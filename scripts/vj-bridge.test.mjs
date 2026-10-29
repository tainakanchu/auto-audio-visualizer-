import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

describe('vj-bridge Origin admission', () => {
  let bridge;
  let url;

  beforeAll(async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    url = `ws://127.0.0.1:${port}`;
    bridge = spawn(
      process.execPath,
      [fileURLToPath(new URL('./vj-bridge.mjs', import.meta.url)), '--port', String(port)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await Promise.race([
      once(bridge.stdout, 'data'),
      once(bridge, 'exit').then(() => {
        throw new Error('vj-bridge exited before listening');
      }),
    ]);
  });

  afterAll(async () => {
    if (bridge && bridge.exitCode === null) {
      const exited = once(bridge, 'exit');
      bridge.kill();
      await exited;
    }
  });

  it.each([undefined, 'https://localhost:5173', 'http://127.0.0.1:8080', 'https://[::1]:5173'])(
    'Origin %s を許可する',
    async (origin) => {
      const socket = new WebSocket(url, { origin });
      try {
        await once(socket, 'open');
      } finally {
        socket.terminate();
      }
    },
  );

  it.each(['https://example.com', 'https://localhost.example.com', 'null', 'invalid', ''])(
    'Origin %s をハンドシェイク時に 403 で拒否する',
    async (origin) => {
      const socket = new WebSocket(url, { headers: { Origin: origin } });
      try {
        await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 403');
      } finally {
        socket.terminate();
      }
    },
  );
});
