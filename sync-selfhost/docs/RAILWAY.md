# Deploy Sync to Railway

The included Dockerfile is the deployment unit. Railway builds the client and server together, then runs one Node.js process.

## 1. Create the service

1. Put this directory in a GitHub repository.
2. In Railway, choose **New Project → Deploy from GitHub repo**.
3. Select the repository and, if the repository contains other projects, set the service root directory to this package.
4. Railway detects the `Dockerfile`; no custom build or start command is needed.

## 2. Attach persistent storage

1. Open the Sync service in Railway.
2. Add a **Volume**.
3. Mount it at `/data`.
4. Add the service variable:

```text
DATA_DIR=/data
```

The app creates `/data/sync.sqlite` and `/data/uploads` automatically. Migrations run before the server begins accepting traffic.

## 3. Configure networking

1. In **Settings → Networking**, generate a public Railway domain.
2. Railway injects `PORT`; do not hard-code it.
3. Wait for `/health` on the public domain to return `{ "ok": true }`.

## 4. Keep SQLite safe

- Run **one replica**. Two app replicas must not share this SQLite volume.
- Do not enable horizontal autoscaling.
- Back up the mounted `/data` volume regularly.
- Keep the volume attached through redeploys. Replacing the service without reattaching it starts an empty database.

## 5. Test before sharing

Run the smoke test against the Railway URL from your local checkout:

```bash
BASE_URL="https://YOUR-RAILWAY-DOMAIN" npm run smoke
```

Then create the two real alpha tester accounts through the UI and send them the Railway HTTPS URL. Google sign-in is intentionally unavailable; they should use email/password.

## Redeploys and migrations

Every image includes the full `drizzle/` migration history. At startup the server records applied migration filenames in `__sync_migrations` and applies only new files. The SQLite file and uploads survive normal redeploys because they live on the mounted volume.

## Troubleshooting

### Build fails at `better-sqlite3`

Use the included Dockerfile. Its build stage contains the compiler toolchain needed for the native module.

### App starts with an empty database after a redeploy

Check that the volume is still mounted at `/data` and that `DATA_DIR=/data` is set on the running service.

### Uploaded videos disappear

The uploads directory is under `DATA_DIR/uploads`. Confirm `/data` is the persistent mount and that only one service instance writes to it.

### Health check works but the page does not load

Inspect Railway logs for the resolved `Data directory` and for migration errors. The production image serves `client/dist` from the same Express process.
