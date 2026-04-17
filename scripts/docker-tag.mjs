#!/usr/bin/env node
// scripts/docker-tag.mjs
// Tags locally-built compose images with Docker Hub names.
//
// Usage:
//   DOCKER_USER=yourname pnpm hub:tag
//   DOCKER_USER=yourname TAG=v1.2.0 pnpm hub:tag
//
// The compose service images are named by Docker as:
//   futsmandu-server-<service>  (based on the compose project + service name)
//
// This script re-tags them as:
//   <DOCKER_USER>/futsmandu-<service>:<TAG>

import { execSync } from 'child_process';

const DOCKER_USER = process.env.DOCKER_USER;
if (!DOCKER_USER) {
  console.error('❌  DOCKER_USER env var is required.');
  console.error('   Example: DOCKER_USER=subashdhungel pnpm hub:tag');
  process.exit(1);
}

const TAG = process.env.TAG || 'latest';

// Map: compose service name → Docker Hub image name suffix
const services = [
  'nginx',
  'player-api',
  'player-worker',
  'owner-api',
  'owner-worker',
  'admin-api',
  'admin-worker',
];

// docker compose names images as: <project>-<service>
// Default project name = directory name = "futsmandu-server"
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT || 'futsmandu-server';

console.log(`🏷️  Tagging images → ${DOCKER_USER}/futsmandu-*:${TAG}\n`);

for (const svc of services) {
  const src = `${COMPOSE_PROJECT}-${svc}`;
  const dst = `${DOCKER_USER}/futsmandu-${svc}:${TAG}`;
  try {
    execSync(`docker tag ${src} ${dst}`, { stdio: 'inherit' });
    console.log(`  ✅  ${src}  →  ${dst}`);
  } catch {
    console.error(`  ❌  Failed to tag ${src} — did you run pnpm docker:build first?`);
    process.exit(1);
  }
}

console.log('\n✅  All images tagged.');
