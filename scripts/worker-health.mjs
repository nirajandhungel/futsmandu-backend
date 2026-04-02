#!/usr/bin/env node
// scripts/worker-health.mjs
// Used by all three worker Dockerfiles as the HEALTHCHECK CMD.
// Why a file instead of a one-liner:
//   - Readable, testable, version-controlled
//   - Works correctly with non-root users (no CWD require() resolution issues)
//   - Handles both redis:// and rediss:// (TLS) URLs
//   - Exits 0 on success, 1 on failure — Docker interprets this as healthy/unhealthy
//
// Does NOT import ioredis — uses a raw TCP connect to keep it dependency-free
// and immune to node_modules resolution edge cases in the container.

import net from 'net';

const TIMEOUT_MS = 8000;

function parseRedisUrl(rawUrl) {
  // Normalise redis:// and rediss:// into something URL can parse
  const url = new URL(
    rawUrl.replace(/^rediss?:\/\//, (m) => (m === 'rediss://' ? 'https://' : 'http://')),
  );
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port) || 6379,
  };
}

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.error('[worker-health] REDIS_URL is not set');
  process.exit(1);
}

let { host, port } = parseRedisUrl(redisUrl);

const timer = setTimeout(() => {
  console.error(`[worker-health] TCP connect to ${host}:${port} timed out after ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS);

const socket = net.connect({ host, port }, () => {
  clearTimeout(timer);
  socket.destroy();
  process.exit(0);
});

socket.on('error', (err) => {
  clearTimeout(timer);
  console.error(`[worker-health] TCP connect failed: ${err.message}`);
  process.exit(1);
});
