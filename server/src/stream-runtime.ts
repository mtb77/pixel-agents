/**
 * Headless IPC composition host for the standalone office and one external
 * StreamProvider. The supplied module must export a named, zero-argument
 * `createStreamProvider()` factory returning a StreamProvider.
 */

import * as path from 'path';
import { pathToFileURL } from 'url';

import type { StreamProvider } from '../../core/src/provider.js';
import { AgentStateStore } from './agentStateStore.js';
import { buildAssetCache } from './assetReload.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { PixelAgentsServer } from './server.js';

type StartMessage = {
  type: 'start';
  host: string;
  port: number;
  token: string;
  bridgeModule: string;
};
type ControlMessage = StartMessage | { type: 'stop' };
type ProviderModule = { createStreamProvider?: () => StreamProvider | Promise<StreamProvider> };

let server: PixelAgentsServer | undefined;
let starting = false;
let secret: string | undefined;

function send(message: Record<string, unknown>): void {
  if (process.connected) process.send?.(message);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join('[redacted]') : message;
}

async function start(message: StartMessage): Promise<void> {
  if (server || starting) throw new Error('Stream runtime has already been started.');
  starting = true;
  secret = message.token;
  try {
    const imported = (await import(
      pathToFileURL(path.resolve(message.bridgeModule)).href
    )) as ProviderModule;
    if (typeof imported.createStreamProvider !== 'function') {
      throw new Error('Stream provider module must export createStreamProvider().');
    }
    const provider = await imported.createStreamProvider();
    if (!provider || provider.kind !== 'stream') {
      throw new Error('createStreamProvider() must return a StreamProvider.');
    }

    const distRoot = path.resolve(__dirname);
    const store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const assetCache = await buildAssetCache(distRoot, []);
    const instance = new PixelAgentsServer();
    server = instance;
    const config = await instance.start({
      store,
      embedded: false,
      reuseExisting: false,
      quiet: true,
      requireSpaToken: true,
      host: message.host || '127.0.0.1',
      port: message.port,
      token: message.token,
      staticDir: path.join(distRoot, 'webview'),
      assetCache,
      streamProviders: [provider],
      onClientCountChange: (count) => send({ type: 'clients', count }),
    });
    send({ type: 'ready', port: config.port });
  } finally {
    starting = false;
  }
}

async function stop(): Promise<void> {
  const instance = server;
  server = undefined;
  await instance?.stop();
  process.disconnect?.();
  process.exit(0);
}

process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const message = value as ControlMessage;
  const action =
    message.type === 'start' ? start(message) : message.type === 'stop' ? stop() : null;
  action?.catch((error) => {
    send({ type: 'error', message: safeMessage(error) });
    void stop();
  });
});

process.on('disconnect', () => void stop());
