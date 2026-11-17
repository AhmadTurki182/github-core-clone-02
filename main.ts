// main.ts — entrypoint. Binds an ephemeral port, registers it with the
// environment, then serves until the environment reports done.

import { Store } from './store.ts';
import { createApp } from './app.ts';

const store = new Store();
const server = createApp({ store });

const envUrl = process.env.MAKEFUN_ENV_URL;

async function register(port: number): Promise<void> {
  if (!envUrl) return;
  const res = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
}

async function waitDone(): Promise<void> {
  if (!envUrl) {
    // No environment: serve until killed.
    return new Promise(() => undefined);
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const res = await fetch(`${envUrl}/done`);
      if (!res.ok) continue;
      const body = (await res.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // Transient; keep polling.
    }
  }
}

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on 127.0.0.1:${port}`);
  try {
    await register(port);
  } catch (err) {
    console.error(`register failed: ${(err as Error).message}`);
    process.exit(1);
  }
  await waitDone();
  server.close(() => process.exit(0));
});
