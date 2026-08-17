import { describe, expect, it, vi } from 'vitest';

import type { StreamProvider, StreamSessionMeta } from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { StreamEventHandler } from '../src/streamEventHandler.js';

function createMockStreamProvider(
  id: string,
  options: {
    displayName?: string;
    sessionMeta?: Record<string, StreamSessionMeta | undefined>;
    hasGetSessionMeta?: boolean;
    formatToolStatus?: (toolName: string) => string;
  } = {},
): StreamProvider {
  const {
    displayName = `${id}-display`,
    sessionMeta = {},
    hasGetSessionMeta = true,
    formatToolStatus = (toolName: string) => `Running ${toolName}`,
  } = options;

  const provider: StreamProvider = {
    kind: 'stream',
    id,
    displayName,
    protocolVersion: 1,
    readingTools: new Set(['Read', 'Search']),
    formatToolStatus,
    async start() {
      return async () => {};
    },
  };

  if (hasGetSessionMeta) {
    provider.getSessionMeta = (sessionId: string) => sessionMeta[sessionId];
  }

  return provider;
}

describe('StreamEventHandler', () => {
  it('materializes agent on first event with correct properties', () => {
    const store = new AgentStateStore();
    const agentAddedListener = vi.fn();
    store.on('agentAdded', agentAddedListener);

    const provider = createMockStreamProvider('stream-test', {
      sessionMeta: {
        'session-1': {
          folderName: 'repo-alpha',
          displayName: 'Claude / feat/stream',
          remoteLabel: 'host-xyz',
        },
      },
    });

    const handler = new StreamEventHandler(store, [provider]);

    handler.handleEvent('stream-test', 'session-1', {
      kind: 'toolStart',
      toolId: 't1',
      toolName: 'Bash',
    });

    expect(store.size).toBe(1);
    const [agentId, agent] = [...store.entries()][0]!;

    expect(agentId).toBe(1);
    expect(agent.sessionId).toBe('session-1');
    expect(agent.providerId).toBe('stream-test');
    expect(agent.isExternal).toBe(true);
    expect(agent.hooksOnly).toBe(true);
    expect(agent.hookDelivered).toBe(true);
    expect(agent.jsonlFile).toBe('');
    expect(agent.projectDir).toBe('');
    expect(agent.folderName).toBe('repo-alpha');
    expect(agent.displayName).toBe('Claude / feat/stream');
    expect(agent.palette).toBeDefined();
    expect(agent.hueShift).toBeDefined();

    expect(agentAddedListener).toHaveBeenCalledWith(1, agent);
  });

  describe('getSessionMeta handling and fallbacks', () => {
    it('falls back to provider.displayName when getSessionMeta returns undefined', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('bridge', {
        displayName: 'Default Bridge Name',
        sessionMeta: {
          'session-no-meta': undefined,
        },
      });

      const handler = new StreamEventHandler(store, [provider]);
      handler.handleEvent('bridge', 'session-no-meta', { kind: 'sessionStart' });

      expect(store.size).toBe(1);
      const agent = [...store.values()][0]!;
      expect(agent.displayName).toBe('Default Bridge Name');
      expect(agent.folderName).toBeUndefined();
    });

    it('falls back to provider.displayName when getSessionMeta is not implemented on provider', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('no-meta-provider', {
        displayName: 'Fallback Name',
        hasGetSessionMeta: false,
      });

      const handler = new StreamEventHandler(store, [provider]);
      handler.handleEvent('no-meta-provider', 'session-any', { kind: 'sessionStart' });

      expect(store.size).toBe(1);
      const agent = [...store.values()][0]!;
      expect(agent.displayName).toBe('Fallback Name');
      expect(agent.folderName).toBeUndefined();
    });

    it('never blocks agent creation if getSessionMeta throws', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('throwing-provider', {
        displayName: 'Safe Fallback Name',
      });
      provider.getSessionMeta = () => {
        throw new Error('meta lookup failure');
      };

      const handler = new StreamEventHandler(store, [provider]);
      expect(() => {
        handler.handleEvent('throwing-provider', 'session-err', { kind: 'sessionStart' });
      }).not.toThrow();

      expect(store.size).toBe(1);
      const agent = [...store.values()][0]!;
      expect(agent.displayName).toBe('Safe Fallback Name');
    });
  });

  describe('addressed emit & multi-session routing', () => {
    it('routes events with different sessionIds to distinct agents', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-a', { kind: 'sessionStart' });
      handler.handleEvent('bridge', 'session-b', { kind: 'sessionStart' });

      expect(store.size).toBe(2);
      const agents = [...store.values()];
      expect(agents[0]?.sessionId).toBe('session-a');
      expect(agents[1]?.sessionId).toBe('session-b');
      expect(agents[0]?.id).not.toBe(agents[1]?.id);
    });

    it('routes subsequent events for the same sessionId to the same agent', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-1', { kind: 'sessionStart' });
      const firstAgentId = [...store.keys()][0]!;

      handler.handleEvent('bridge', 'session-1', {
        kind: 'toolStart',
        toolId: 't1',
        toolName: 'Read',
      });

      expect(store.size).toBe(1);
      const agent = store.get(firstAgentId)!;
      expect(agent.activeToolIds.has('t1')).toBe(true);
    });
  });

  describe('tool lifecycle & turn end', () => {
    it('handles toolStart and toolEnd with name-only formatToolStatus', () => {
      const store = new AgentStateStore();
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (b) => broadcasts.push(b));

      const formatToolStatus = vi.fn((name: string) => `Executing ${name}`);
      const provider = createMockStreamProvider('bridge', { formatToolStatus });
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-1', {
        kind: 'toolStart',
        toolId: 'tool-1',
        toolName: 'Edit',
      });

      expect(formatToolStatus).toHaveBeenCalledWith('Edit');
      const agent = [...store.values()][0]!;
      expect(agent.activeToolIds.has('tool-1')).toBe(true);
      expect(agent.activeToolStatuses.get('tool-1')).toBe('Executing Edit');
      expect(agent.activeToolNames.get('tool-1')).toBe('Edit');
      expect(agent.isWaiting).toBe(false);

      expect(broadcasts).toContainEqual({
        type: 'agentToolStart',
        id: agent.id,
        toolId: 'tool-1',
        status: 'Executing Edit',
        toolName: 'Edit',
        runInBackground: undefined,
      });
      expect(broadcasts).toContainEqual({
        type: 'agentStatus',
        id: agent.id,
        status: 'active',
      });

      broadcasts.length = 0;
      handler.handleEvent('bridge', 'session-1', {
        kind: 'toolEnd',
        toolId: 'tool-1',
      });

      expect(agent.activeToolIds.has('tool-1')).toBe(false);
      expect(broadcasts).toContainEqual({
        type: 'agentToolDone',
        id: agent.id,
        toolId: 'tool-1',
      });
    });

    it('handles turnEnd, clearing foreground tools and setting status: waiting with awaitingInput: false', () => {
      const store = new AgentStateStore();
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (b) => broadcasts.push(b));

      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      // Start foreground tool + background tool
      handler.handleEvent('bridge', 'session-1', {
        kind: 'toolStart',
        toolId: 'fg-tool',
        toolName: 'Bash',
      });
      handler.handleEvent('bridge', 'session-1', {
        kind: 'toolStart',
        toolId: 'bg-tool',
        toolName: 'Agent',
        runInBackground: true,
      });

      const agent = [...store.values()][0]!;
      expect(agent.activeToolIds.size).toBe(2);

      broadcasts.length = 0;
      handler.handleEvent('bridge', 'session-1', {
        kind: 'turnEnd',
        awaitingInput: true, // Should be ignored/forced false per ADR 0001
      });

      expect(agent.isWaiting).toBe(true);
      // Foreground tool cleared
      expect(agent.activeToolIds.has('fg-tool')).toBe(false);
      // Background tool preserved
      expect(agent.activeToolIds.has('bg-tool')).toBe(true);
      expect(agent.backgroundAgentToolIds.has('bg-tool')).toBe(true);

      expect(broadcasts).toContainEqual({
        type: 'agentToolsClear',
        id: agent.id,
      });
      expect(broadcasts).toContainEqual({
        type: 'agentToolStart',
        id: agent.id,
        toolId: 'bg-tool',
        status: 'Running Agent',
        toolName: 'Agent',
        runInBackground: true,
      });
      expect(broadcasts).toContainEqual({
        type: 'agentStatus',
        id: agent.id,
        status: 'waiting',
        awaitingInput: false,
      });
    });

    it('never emits permissionRequest or awaitingInput (ADR 0001 constraint)', () => {
      const store = new AgentStateStore();
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (b) => broadcasts.push(b));

      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-1', { kind: 'sessionStart' });
      broadcasts.length = 0;

      handler.handleEvent('bridge', 'session-1', { kind: 'permissionRequest' });
      expect(broadcasts.length).toBe(0);

      handler.handleEvent('bridge', 'session-1', { kind: 'turnEnd', awaitingInput: true });
      const statusMsg = broadcasts.find((b) => b['type'] === 'agentStatus');
      expect(statusMsg).toEqual({
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        awaitingInput: false,
      });
    });
  });

  describe('subagent events', () => {
    it('dispatches subagentStart, subagentEnd, and subagentTurnEnd(completed)', () => {
      const store = new AgentStateStore();
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (b) => broadcasts.push(b));

      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-1', {
        kind: 'subagentStart',
        parentToolId: 'p-1',
        toolId: 'sub-1',
        toolName: 'Worker',
      });

      const agent = [...store.values()][0]!;
      expect(agent.activeSubagentToolIds.get('p-1')?.has('sub-1')).toBe(true);
      expect(broadcasts).toContainEqual({
        type: 'subagentToolStart',
        id: agent.id,
        parentToolId: 'p-1',
        toolId: 'sub-1',
        status: 'Running Worker',
      });

      broadcasts.length = 0;
      handler.handleEvent('bridge', 'session-1', {
        kind: 'subagentEnd',
        parentToolId: 'p-1',
        toolId: 'sub-1',
      });
      expect(broadcasts).toContainEqual({
        type: 'subagentToolDone',
        id: agent.id,
        parentToolId: 'p-1',
        toolId: 'sub-1',
      });

      broadcasts.length = 0;
      handler.handleEvent('bridge', 'session-1', {
        kind: 'subagentTurnEnd',
        parentToolId: 'p-1',
        reason: 'completed',
      });
      expect(agent.activeSubagentToolIds.has('p-1')).toBe(false);
      expect(broadcasts).toContainEqual({
        type: 'subagentClear',
        id: agent.id,
        parentToolId: 'p-1',
      });
    });
  });

  describe('sessionEnd and agent removal', () => {
    it('removes agent from store and emits agentRemoved on sessionEnd', () => {
      const store = new AgentStateStore();
      const agentRemovedListener = vi.fn();
      store.on('agentRemoved', agentRemovedListener);

      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      handler.handleEvent('bridge', 'session-1', { kind: 'sessionStart' });
      expect(store.size).toBe(1);

      handler.handleEvent('bridge', 'session-1', { kind: 'sessionEnd' });
      expect(store.size).toBe(0);
      expect(agentRemovedListener).toHaveBeenCalledWith(1);
    });

    it('tolerates sessionEnd on an unknown session without throwing', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      expect(() => {
        handler.handleEvent('bridge', 'unknown-session', { kind: 'sessionEnd' });
      }).not.toThrow();
      expect(store.size).toBe(0);
    });
  });

  describe('HookEventHandler isolation', () => {
    it('asserts no stream events reach or require HookEventHandler', () => {
      const store = new AgentStateStore();
      const provider = createMockStreamProvider('bridge');
      const handler = new StreamEventHandler(store, [provider]);

      // Process an entire session lifecycle through StreamEventHandler
      handler.handleEvent('bridge', 'sess-iso', { kind: 'sessionStart' });
      handler.handleEvent('bridge', 'sess-iso', {
        kind: 'toolStart',
        toolId: 't1',
        toolName: 'Read',
      });
      handler.handleEvent('bridge', 'sess-iso', { kind: 'toolEnd', toolId: 't1' });
      handler.handleEvent('bridge', 'sess-iso', { kind: 'turnEnd' });
      handler.handleEvent('bridge', 'sess-iso', { kind: 'sessionEnd' });

      // Clean completion, no transcript watchers, no timers, no Claude heuristic state
      expect(store.size).toBe(0);
    });
  });
});
