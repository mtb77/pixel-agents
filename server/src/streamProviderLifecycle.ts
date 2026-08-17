import type { AgentEvent, StreamProvider } from '../../core/src/provider.js';

/** Receives events emitted by any registered StreamProvider, tagged with the
 *  originating provider's id. Wired by the composition root (never a Claude
 *  heuristic/transcript-fallback path -- those only ever see the bound
 *  HookProvider). */
export type StreamEventSink = (providerId: string, event: AgentEvent) => void;

/**
 * Gates StreamProvider.start()/dispose() on office-client presence: starts
 * each registered provider when the first client connects, and awaits every
 * disposer once the last client disconnects. This connect/disconnect gate is
 * the contract an external stream bridge relies on to pause its own polling
 * at zero clients rather than running unobserved.
 *
 * Start/stop transitions are serialized through a single promise chain so a
 * rapid connect/disconnect/connect sequence can't start a provider twice or
 * dispose one that a later connect already needs running again.
 */
export class StreamProviderLifecycle {
  private clientCount = 0;
  private readonly disposers = new Map<string, () => Promise<void>>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly providers: readonly StreamProvider[],
    private readonly onEvent: StreamEventSink,
  ) {
    for (const provider of providers) {
      // Defensive: a caller wiring this up could pass a HookProvider by
      // mistake at the composition root. Fail loudly rather than silently
      // treating hook-sourced events as stream-sourced (or vice versa).
      if (provider.kind !== 'stream') {
        throw new Error(
          `StreamProviderLifecycle received a provider with kind "${provider.kind}" (id=${provider.id}); expected "stream".`,
        );
      }
    }
  }

  /** Call when an office client (WS connection) is accepted. */
  clientConnected(): void {
    this.clientCount++;
    if (this.clientCount === 1) {
      this.chain = this.chain.then(() => this.startAll());
    }
  }

  /** Call when an office client (WS connection) closes. */
  clientDisconnected(): void {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) {
      this.chain = this.chain.then(() => this.stopAll());
    }
  }

  private async startAll(): Promise<void> {
    if (this.clientCount === 0) return; // a disconnect already raced ahead of us
    for (const provider of this.providers) {
      if (this.disposers.has(provider.id)) continue;
      try {
        const dispose = await provider.start((event) => this.onEvent(provider.id, event));
        this.disposers.set(provider.id, dispose);
      } catch (err) {
        console.error(`[Pixel Agents] StreamProvider "${provider.id}" failed to start:`, err);
      }
    }
  }

  private async stopAll(): Promise<void> {
    if (this.clientCount > 0) return; // a connect already raced ahead of us
    const entries = [...this.disposers.entries()];
    this.disposers.clear();
    for (const [id, dispose] of entries) {
      try {
        await dispose();
      } catch (err) {
        console.error(`[Pixel Agents] StreamProvider "${id}" failed to dispose:`, err);
      }
    }
  }
}
