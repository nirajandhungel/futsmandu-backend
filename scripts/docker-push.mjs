#!/usr/bin/env node
// scripts/docker-push.mjs
// Pushes all tagged Futsmandu images to Docker Hub.
//
// Usage:
//   DOCKER_USER=yourname pnpm hub:push    (also runs docker-tag.mjs first)
//   DOCKER_USER=yourname TAG=v1.2.0 pnpm hub:push
//
// Prerequisites:
//   docker login   (run once — stores credentials in keychain)

import { execSync } from 'child_process';

const DOCKER_USER = process.env.DOCKER_USER;
if (!DOCKER_USER) {
  console.error('❌  DOCKER_USER env var is required.');
  console.error('   Example: DOCKER_USER=subashdhungel pnpm hub:push');
  process.exit(1);
}

const TAG = process.env.TAG || 'latest';

const services = [
  'nginx',
  'player-api',
  'player-worker',
  'owner-api',
  'owner-worker',
  'admin-api',
  'admin-worker',
];

console.log(`🚀  Pushing images to Docker Hub as ${DOCKER_USER}/futsmandu-*:${TAG}\n`);
console.log('   (This may take several minutes on first push — layers are cached after that)\n');

for (const svc of services) {
  const image = `${DOCKER_USER}/futsmandu-${svc}:${TAG}`;
  console.log(`  ⬆️   Pushing ${image} ...`);
  try {
    execSync(`docker push ${image}`, { stdio: 'inherit' });
    console.log(`  ✅  ${image}\n`);
  } catch {
    console.error(`  ❌  Push failed for ${image}`);
    console.error('      Make sure you are logged in: docker login');
    process.exit(1);
  }
}

console.log('✅  All images pushed to Docker Hub.');
console.log(`\n📋  Your friend can now run:`);
console.log(`    DOCKER_USER=${DOCKER_USER} docker compose --env-file .env -f infrastructure/docker-compose.hub.yml pull`);
console.log(`    DOCKER_USER=${DOCKER_USER} docker compose --env-file .env -f infrastructure/docker-compose.hub.yml up -d`);
