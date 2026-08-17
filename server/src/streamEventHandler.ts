import type { AgentEvent, StreamProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import type { AgentState } from './types.js';

/**
 * Dedicated event handler for push-based StreamProviders.
 *
 * Stream sessions never enter HookEventHandler, file watchers, or Claude
 * heuristic/transcript-fallback paths. This handler owns:
 * - Materializing an agent on its first event (hooksOnly: true, isExternal: true,
 *   providerId set, no transcript file, no heuristic timers, no pending external session flow).
 * - Pulling per-session display metadata once via `provider.getSessionMeta(sessionId)`,
 *   falling back to `provider.displayName` if undefined.
 * - Dispatching toolStart, toolEnd, turnEnd, subagentStart, subagentEnd, subagentTurnEnd, progress.
 * - Removing the agent on sessionEnd.
 */
export class StreamEventHandler {
  private readonly sessionToAgentId = new Map<string, number>();
  private readonly providers = new Map<string, StreamProvider>();

  constructor(
    private readonly store: AgentStateStore,
    providers?: readonly StreamProvider[],
  ) {
    if (providers) {
      for (const p of providers) {
        this.registerProvider(p);
      }
    }
  }

  registerProvider(provider: StreamProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Handle an event emitted by a StreamProvider.
   * Bound method so it can be passed directly as a StreamEventSink callback.
   */
  handleEvent = (providerId: string, sessionId: string, event: AgentEvent): void => {
    const provider = this.providers.get(providerId);

    // If sessionEnd arrives for an unknown session, there is nothing to clean up.
    if (event.kind === 'sessionEnd') {
      const agentId = this.resolveAgentId(providerId, sessionId);
      if (agentId !== undefined) {
        this.store.delete(agentId);
        this.store.persist();
        this.sessionToAgentId.delete(this.sessionKey(providerId, sessionId));
      }
      return;
    }

    // Materialize agent on first event
    const agentId = this.getOrCreateAgent(providerId, sessionId, provider);
    const agent = this.store.get(agentId);
    if (!agent) return;

    agent.lastDataAt = Date.now();

    switch (event.kind) {
      case 'sessionStart':
        // Agent is already materialized above
        return;

      case 'toolStart': {
        const status = provider ? provider.formatToolStatus(event.toolName) : event.toolName;
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        agent.activeToolIds.add(event.toolId);
        agent.activeToolStatuses.set(event.toolId, status);
        agent.activeToolNames.set(event.toolId, event.toolName);
        if (event.runInBackground) {
          agent.backgroundAgentToolIds.add(event.toolId);
        }

        this.store.broadcast({
          type: 'agentToolStart',
          id: agentId,
          toolId: event.toolId,
          status,
          toolName: event.toolName,
          runInBackground: event.runInBackground || undefined,
        });
        this.store.broadcast({
          type: 'agentStatus',
          id: agentId,
          status: 'active',
        });
        return;
      }

      case 'toolEnd': {
        agent.activeToolIds.delete(event.toolId);
        agent.activeToolStatuses.delete(event.toolId);
        agent.activeToolNames.delete(event.toolId);
        agent.backgroundAgentToolIds.delete(event.toolId);

        this.store.broadcast({
          type: 'agentToolDone',
          id: agentId,
          toolId: event.toolId,
        });
        return;
      }

      case 'turnEnd': {
        agent.isWaiting = true;
        agent.hadToolsInTurn = false;

        // Clear foreground tools, keep background agent tools
        for (const toolId of [...agent.activeToolIds]) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          agent.activeToolNames.delete(toolId);
          agent.activeSubagentToolIds.delete(toolId);
          agent.activeSubagentToolNames.delete(toolId);
        }

        this.store.broadcast({ type: 'agentToolsClear', id: agentId });

        // Re-send live background tools after clearing
        for (const toolId of agent.backgroundAgentToolIds) {
          const status = agent.activeToolStatuses.get(toolId);
          if (status) {
            this.store.broadcast({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              status,
              toolName: agent.activeToolNames.get(toolId),
              runInBackground: true,
            });
          }
        }

        // Stream providers never emit awaitingInput (ADR 0001, ADR 0003)
        this.store.broadcast({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
          awaitingInput: false,
        });
        return;
      }

      case 'subagentStart': {
        const status = provider
          ? provider.formatToolStatus(event.toolName)
          : `Subtask: ${event.toolName}`;

        let subTools = agent.activeSubagentToolIds.get(event.parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(event.parentToolId, subTools);
        }
        subTools.add(event.toolId);

        let subNames = agent.activeSubagentToolNames.get(event.parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(event.parentToolId, subNames);
        }
        subNames.set(event.toolId, event.toolName);

        this.store.broadcast({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId: event.parentToolId,
          toolId: event.toolId,
          status,
        });
        return;
      }

      case 'subagentEnd': {
        this.store.broadcast({
          type: 'subagentToolDone',
          id: agentId,
          parentToolId: event.parentToolId,
          toolId: event.toolId,
        });
        return;
      }

      case 'subagentTurnEnd': {
        if (event.reason === 'completed') {
          agent.activeSubagentToolIds.delete(event.parentToolId);
          agent.activeSubagentToolNames.delete(event.parentToolId);
          this.store.broadcast({
            type: 'subagentClear',
            id: agentId,
            parentToolId: event.parentToolId,
          });
        }
        return;
      }

      case 'permissionRequest':
        // Stream providers never emit permissionRequest (ADR 0001)
        return;

      case 'progress':
        // Progress events are not currently visualized in the office
        return;
    }
  };

  private sessionKey(providerId: string, sessionId: string): string {
    return `${providerId}:${sessionId}`;
  }

  private resolveAgentId(providerId: string, sessionId: string): number | undefined {
    const key = this.sessionKey(providerId, sessionId);
    const existing = this.sessionToAgentId.get(key);
    if (existing !== undefined && this.store.has(existing)) {
      return existing;
    }
    // Check if the agent is in the store from previous state
    for (const [id, a] of this.store) {
      if (a.sessionId === sessionId && a.providerId === providerId) {
        this.sessionToAgentId.set(key, id);
        return id;
      }
    }
    return undefined;
  }

  private getOrCreateAgent(
    providerId: string,
    sessionId: string,
    provider?: StreamProvider,
  ): number {
    const key = this.sessionKey(providerId, sessionId);
    const existingId = this.resolveAgentId(providerId, sessionId);
    if (existingId !== undefined) {
      return existingId;
    }

    let meta: import('../../core/src/provider.js').StreamSessionMeta | undefined;
    try {
      meta = provider?.getSessionMeta?.(sessionId);
    } catch {
      // getSessionMeta must never block agent creation
    }
    const folderName = meta?.folderName;
    const displayName = meta?.displayName ?? provider?.displayName ?? providerId;

    const id = this.store.nextAgentId.current++;
    const agent: AgentState = {
      id,
      sessionId,
      isExternal: true,
      projectDir: '',
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: true,
      hooksOnly: true,
      providerId,
      folderName,
      displayName,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    };

    assignPaletteIfNeeded(agent, this.store);
    this.store.set(id, agent);
    this.store.persist();
    this.sessionToAgentId.set(key, id);

    return id;
  }
}
