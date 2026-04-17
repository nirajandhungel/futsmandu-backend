# Futsmandu Backend — Docker Handoff Guide

Your backend runs as 7 Docker containers. You build images once on your machine,
push them to Docker Hub, and your friend just pulls + runs — **no Node.js, no
source code, no build tools needed on their machine**. Exactly like using MinIO
via Docker.

---

## What your friend gets

| Container      | Direct port on their laptop | Via nginx (port 80)         |
|---------------|----------------------------|-----------------------------|
| `player-api`   | `localhost:3001`            | `localhost/api/v1/player/…` |
| `owner-api`    | `localhost:3002`            | `localhost/api/v1/owner/…`  |
| `admin-api`    | `localhost:3003`            | `localhost/api/v1/admin/…`  |
| `player-worker`| —                          | background jobs             |
| `owner-worker` | —                          | background jobs + Sharp     |
| `admin-worker` | —                          | background jobs             |
| `nginx`        | `localhost:80`              | reverse proxy               |

Their setup is identical to how you run MinIO locally:
```bash
# They run this — done
docker compose -f docker-compose.hub.yml --env-file .env up -d
```

---

## YOUR workflow (one-time setup)

### 1. Create a Docker Hub account
Sign up at [hub.docker.com](https://hub.docker.com) and note your username.

### 2. Login from terminal
```bash
docker login
# Enter Docker Hub username + password
```

### 3. Build all images
```bash
# From repo root
pnpm docker:build
```
First build is slow (5–15 min). Subsequent builds use layer cache.

### 4. Tag + push to Docker Hub
```bash
DOCKER_USER=yourDockerHubUsername pnpm hub:publish
# This runs: docker:build → hub:tag → hub:push
# All 7 images (nginx + 3 APIs + 3 workers) are pushed
```

Or step by step:
```bash
DOCKER_USER=yourDockerHubUsername pnpm hub:tag    # tag local images
DOCKER_USER=yourDockerHubUsername pnpm hub:push   # push to hub
```

### 5. Send your friend two things
1. **`infrastructure/docker-compose.hub.yml`** — one file, commit it to git or send directly
2. **`.env` file** — send securely (not in chat/email plaintext). Use a password manager share or voice call.

---

## FRIEND'S workflow (nothing to install except Docker)

### 1. Install Docker
- Mac/Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop)
- Linux: `curl -fsSL https://get.docker.com | sh`

### 2. Get the two files from you
Save them in the same folder, e.g. `~/futsmandu/`:
```
~/futsmandu/
  docker-compose.hub.yml
  .env
```

### 3. Pull and start
```bash
cd ~/futsmandu

# Set the Docker Hub username (yours — tell your friend this)
export DOCKER_USER=yourDockerHubUsername

# Pull all images (~1-2 GB total, cached after first pull)
docker compose --env-file .env -f docker-compose.hub.yml pull

# Start everything
docker compose --env-file .env -f docker-compose.hub.yml up -d
```

### 4. Verify it's running
```bash
# Check all containers are healthy
docker compose --env-file .env -f docker-compose.hub.yml ps

# Quick health checks (all should return {"status":"ok"})
curl http://localhost:3001/api/v1/player/health
curl http://localhost:3002/api/v1/owner/health
curl http://localhost/nginx-health
```

### 5. Use the APIs
```
# Direct (like MinIO on port 9000):
http://localhost:3001/api/v1/player/...
http://localhost:3002/api/v1/owner/...
http://localhost:3003/api/v1/admin/...

# Via nginx (all through port 80):
http://localhost/api/v1/player/...
http://localhost/api/v1/owner/...
```

### 6. Stop
```bash
docker compose --env-file .env -f docker-compose.hub.yml down
```

---

## Updating images (after you change code)

On **your machine**:
```bash
# Rebuild changed services only (Docker caches unchanged layers)
pnpm docker:build

# Re-tag and push
DOCKER_USER=yourDockerHubUsername pnpm hub:publish

# Or push a versioned tag:
DOCKER_USER=yourDockerHubUsername TAG=v1.1.0 pnpm hub:publish
```

On **friend's machine**:
```bash
DOCKER_USER=yourDockerHubUsername \
docker compose --env-file .env -f docker-compose.hub.yml pull

docker compose --env-file .env -f docker-compose.hub.yml up -d
# Docker automatically restarts only containers whose image changed
```

---

## Useful commands for your friend

```bash
# Watch logs for all services
docker compose --env-file .env -f docker-compose.hub.yml logs -f

# Watch logs for one service
docker compose --env-file .env -f docker-compose.hub.yml logs -f player-api

# Restart one service
docker compose --env-file .env -f docker-compose.hub.yml restart owner-api

# Full stop and remove containers
docker compose --env-file .env -f docker-compose.hub.yml down

# Stop + remove images (full cleanup)
docker compose --env-file .env -f docker-compose.hub.yml down --rmi all
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `DOCKER_USER` error on startup | Run `export DOCKER_USER=yourname` before the compose command, or add `DOCKER_USER=yourname` to `.env` |
| Container exits immediately | Run `docker logs <container-name>` — look for missing env var messages |
| Port 80 already in use | Stop local nginx/Apache, or change nginx port in `.env`: `NGINX_PORT=8080` |
| Port 3001/3002/3003 in use | Another app is using that port — stop it or change port in `.env` |
| Admin API returns 403 | Add friend's IP to `ADMIN_ALLOWED_IPS` in `.env` and restart |
| Images not found | Make sure you ran `pnpm hub:publish` and `DOCKER_USER` matches your Docker Hub username |
| `pull` is slow | ~1-2 GB first time — subsequent pulls only download changed layers |

---

## Notes

- **Database and Redis are external** — Neon (DB) and Upstash (Redis) credentials in `.env` connect to the cloud. Your friend shares the same DB/Redis as you unless you give them separate credentials.
- **Admin Admin IP restriction** — by default only `127.0.0.1` and Docker network can reach admin. If friend needs admin access, add their IP to `ADMIN_ALLOWED_IPS` in `.env`.
- **No domain needed** — everything runs on `localhost`. No DNS, no SSL cert needed for local testing.
