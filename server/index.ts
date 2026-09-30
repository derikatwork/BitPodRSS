import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { allowPrivateNetwork } from './security';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';
const dataDir = path.resolve(process.env['DATA_DIR'] ?? path.join(root, 'data'));
const allowedHosts = (process.env['ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean);

const app = createApp({ dataDir, allowedHosts, staticDir: path.join(root, 'dist') });

const server = app.listen(port, host, () => {
  console.log(`BitPodRSS server listening on http://${host}:${port}`);
  console.log(`  data directory: ${dataDir}`);
  if (allowPrivateNetwork()) console.log('  ALLOW_PRIVATE_NETWORK=1: feeds on private/LAN addresses are permitted');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.log(`  WARNING: listening on ${host}. Anyone who can reach this port can use the feed proxy; add your host name to ALLOWED_HOSTS.`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
