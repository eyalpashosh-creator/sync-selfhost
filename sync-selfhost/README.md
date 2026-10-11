# Sync — self-hosted alpha

This directory is a portable Node.js build of the current Sync app. It preserves the React UI and all published server actions while replacing the Muse/Hatch runtime with Express, Drizzle, and SQLite. Google sign-in is disabled in this alpha package; testers use email and password.

## What is included

- Current React client and styling
- All 48 JSON-RPC actions, with their existing Zod request/response validation
- `POST /actions` accepting `{ "action": "actionName", "args": { ... } }`
- Email/password accounts and opaque SHA-256-hashed sessions (7-day expiry)
- SQLite via Drizzle and all 23 source migrations, applied on startup
- Persistent file storage for avatars and completed draft-video uploads
- Chunked/resumable video uploads (chunk metadata is persisted in SQLite while chunk bytes and completed videos are stored under `DATA_DIR/uploads`)
- Hourly in-process resolve-request expiry job
- Multi-stage Docker image and Docker Compose setup
- Railway deployment instructions in [`docs/RAILWAY.md`](docs/RAILWAY.md)

## Prerequisites

Choose one:

- Docker Engine + Docker Compose v2, or
- Node.js 22+, npm, and native build tools required by `better-sqlite3`

## Environment variables

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `PORT` | No | `3000` | HTTP port |
| `DATA_DIR` | No | `./data` | Persistent SQLite and upload root |
| `DATABASE_PATH` | No | `$DATA_DIR/sync.sqlite` | Override the SQLite file path |
| `MIGRATIONS_DIR` | No | `./drizzle` | Override migration source directory |
| `CLIENT_DIR` | No | `./client/dist` | Override built-client directory |

`DATA_DIR` must live on persistent storage in production. Do not run multiple replicas against the same SQLite file.

## Run locally with Docker Compose

```bash
docker compose up --build
```

Open <http://localhost:3000>. Data persists in the named `sync_data` volume.

Stop the service:

```bash
docker compose down
```

Remove the local database and uploaded files only when you intentionally want a clean start:

```bash
docker compose down -v
```

## Run locally without Docker

```bash
npm install
npm run build
DATA_DIR="$PWD/data" npm start
```

For client/server development with hot reload:

```bash
npm run dev
```

The Vite client runs on port 5173 and proxies actions/files to the Express server on port 3000.

## Verify the package

With the server running:

```bash
npm run smoke
```

The smoke test creates unique artist and curator accounts, signs in, creates a curator profile, creates a campaign, sends an invitation, and accepts it. The test rows remain in the selected test database, so use a disposable `DATA_DIR` for repeated verification.

Health check:

```bash
curl http://localhost:3000/health
```

## JSON-RPC endpoint

All client calls use one endpoint:

```http
POST /actions
Content-Type: application/json

{"action":"signInWithEmail","args":{"email":"artist@example.com","password":"...","role":"artist"}}
```

The server validates `args` against the action's original Zod request schema, executes it with a request context, then validates the result against the original response schema. Session-bearing requests also resolve the current user into the portable request context; the ported actions retain their original authorization checks.

## Persistence and backups

Back up the complete `DATA_DIR`, not only the SQLite file. It contains:

- `sync.sqlite` plus SQLite WAL files while the server is running
- `uploads/` for avatar and draft-video blob data and metadata

For a consistent filesystem-level backup, stop the container first, then copy the volume contents. Restoring means placing the complete backup into an empty `DATA_DIR` before startup.

## Authentication

The self-hosted alpha exposes email/password sign-in only. Passwords use the existing PBKDF2-SHA-256 scheme with per-user salts. Session tokens remain opaque, are stored only as SHA-256 hashes, and expire after seven days.

The `verifyGoogleCredential` action remains registered to preserve the published action surface, but returns a clear disabled response. The client does not load or show Google Identity Services.

## Password-reset and report email relay

The current app stores password-reset and report notifications in SQLite and exposes the existing relay actions (`list_pending_password_resets`, `mark_password_reset_emailed`, `list_unemailed_reports`, and `mark_reports_emailed`). This package intentionally preserves those action contracts; an external transactional-email relay is still required to send those queued emails and mark them delivered.

## Production notes

- Put the service behind HTTPS. Railway provides TLS on its public domain.
- Keep one running replica while using SQLite.
- Protect and monitor the persistent volume.
- Set a regular backup process before inviting testers.
- The app currently has no payment processing; its existing UI states that paid functionality is not connected.
