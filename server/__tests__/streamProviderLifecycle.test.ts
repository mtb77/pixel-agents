import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, StreamEventEnvelope, StreamProvider } from '../../core/src/provider.js';
import { StreamProviderLifecycle } from '../src/streamProviderLifecycle.js';

/** Deferred so a test can control exactly when start()/dispose() settle. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeProvider(
  id: string,
  overrides: Partial<StreamProvider> = {},
): StreamProvider & {
  startCalls: Array<(envelope: StreamEventEnvelope) => void>;
  disposeCalls: number;
} {
  const startCalls: Array<(envelope: StreamEventEnvelope) => void> = [];
  let disposeCalls = 0;
  return {
    kind: 'stream',
    id,
    displayName: id,
    protocolVersion: 1,
    readingTools: new Set(),
    formatToolStatus: (toolName: string) => `Running ${toolName}`,
    async start(emit) {
      startCalls.push(emit);
      return async () => {
        disposeCalls++;
      };
    },
    get startCalls() {
      return startCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    ...overrides,
  } as StreamProvider & {
    startCalls: Array<(envelope: StreamEventEnvelope) => void>;
    disposeCalls: number;
  };
}

// Flush the microtask queue enough times for the lifecycle's internal promise
// chain (start/stop, each with their own awaits) to settle.
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('StreamProviderLifecycle', () => {
  it('reports every client-count change without altering the lifecycle gate', async () => {
    const provider = makeProvider('bridge');
    const onCount = vi.fn();
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn(), onCount);

    lifecycle.clientConnected();
    lifecycle.clientConnected();
    lifecycle.clientDisconnected();
    lifecycle.clientDisconnected();
    await flush();

    expect(onCount.mock.calls.map(([count]) => count)).toEqual([1, 2, 1, 0]);
    expect(provider.startCalls.length).toBe(0);
  });

  it('rejects a non-stream provider at construction (defensive guard)', () => {
    const notStream = { kind: 'hook', id: 'claude' } as unknown as StreamProvider;
    expect(() => new StreamProviderLifecycle([notStream], vi.fn())).toThrow(/expected "stream"/);
  });

  it('starts the provider once the first client connects', async () => {
    const provider = makeProvider('bridge');
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    expect(provider.startCalls.length).toBe(0);
    lifecycle.clientConnected();
    await flush();
    expect(provider.startCalls.length).toBe(1);
  });

  it('does not start again for additional connects while already running', async () => {
    const provider = makeProvider('bridge');
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected();
    await flush();
    lifecycle.clientConnected();
    lifecycle.clientConnected();
    await flush();
    expect(provider.startCalls.length).toBe(1);
  });

  it('does not dispose while clients remain', async () => {
    const provider = makeProvider('bridge');
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected();
    lifecycle.clientConnected();
    await flush();
    lifecycle.clientDisconnected(); // 2 -> 1, still someone watching
    await flush();
    expect(provider.disposeCalls).toBe(0);
  });

  it('awaits the disposer once the last client disconnects', async () => {
    const provider = makeProvider('bridge');
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected();
    await flush();
    lifecycle.clientDisconnected(); // 1 -> 0
    await flush();
    expect(provider.disposeCalls).toBe(1);
  });

  it('restarts on a later connect after a full stop', async () => {
    const provider = makeProvider('bridge');
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected();
    await flush();
    lifecycle.clientDisconnected();
    await flush();
    expect(provider.disposeCalls).toBe(1);

    lifecycle.clientConnected();
    await flush();
    expect(provider.startCalls.length).toBe(2);
  });

  it('starts every registered provider and isolates one that fails to start', async () => {
    const good = makeProvider('good');
    const bad = makeProvider('bad', {
      start: async () => {
        throw new Error('boom');
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lifecycle = new StreamProviderLifecycle([good, bad], vi.fn());

    lifecycle.clientConnected();
    await flush();

    expect(good.startCalls.length).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('forwards emitted events to the sink tagged with the provider id and session id', async () => {
    const provider = makeProvider('bridge');
    const sink = vi.fn();
    const lifecycle = new StreamProviderLifecycle([provider], sink);

    lifecycle.clientConnected();
    await flush();

    const emit = provider.startCalls[0];
    const event: AgentEvent = { kind: 'turnEnd' };
    emit({ sessionId: 'session-123', event });

    expect(sink).toHaveBeenCalledWith('bridge', 'session-123', event);
  });

  it('serializes a rapid connect/disconnect/connect without double-starting or racing a stop', async () => {
    const startGate = deferred<void>();
    let starts = 0;
    let disposes = 0;
    const provider: StreamProvider = {
      kind: 'stream',
      id: 'bridge',
      displayName: 'bridge',
      protocolVersion: 1,
      readingTools: new Set(),
      formatToolStatus: (toolName) => toolName,
      async start() {
        starts++;
        await startGate.promise; // held open until the test releases it
        return async () => {
          disposes++;
        };
      },
    };
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected(); // 0 -> 1: begins starting (blocked on startGate)
    lifecycle.clientDisconnected(); // 1 -> 0: queued stop, must wait for start to finish
    lifecycle.clientConnected(); // 0 -> 1 again: should not queue a second concurrent start

    startGate.resolve();
    await flush(10);

    expect(starts).toBe(1);
    // Net client count is 1 (connect, disconnect, connect), so the provider must
    // end up running, not disposed.
    expect(disposes).toBe(0);
  });

  it('formatToolStatus takes only a tool name and never renders payload text', () => {
    const provider = makeProvider('bridge', {
      formatToolStatus: (toolName: string) => `Running ${toolName}`,
    });
    // The interface signature has no `input`/payload parameter to pass one
    // through -- calling it with just a name is the only shape that type-checks.
    expect(provider.formatToolStatus('Read')).toBe('Running Read');
    expect(provider.formatToolStatus('Read')).not.toMatch(/secret|password|token/i);
  });

  it('never calls formatToolStatus itself -- it is a display-layer concern, not a lifecycle one', async () => {
    const formatToolStatus = vi.fn((toolName: string) => toolName);
    const provider = makeProvider('bridge', { formatToolStatus });
    const lifecycle = new StreamProviderLifecycle([provider], vi.fn());

    lifecycle.clientConnected();
    await flush();
    const emit = provider.startCalls[0];
    emit({
      sessionId: 's1',
      event: { kind: 'toolStart', toolId: 't1', toolName: 'Read', input: { secret: 'leak' } },
    });
    lifecycle.clientDisconnected();
    await flush();

    expect(formatToolStatus).not.toHaveBeenCalled();
  });
});
