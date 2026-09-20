# Stream GPS

Stream GPS receives GPS telemetry from registered devices, stores it in PostgreSQL, shows device history on a map, and provides configurable live overlays for OBS.

## Current capabilities

- Multi-user registration, isolated private data, revocable JWT sessions and account security settings.
- Registered GPS devices with one-time device keys, key replacement, revocation, replay protection and request-rate limiting.
- PostgreSQL storage for GPS history, nonce protection and telemetry sessions.
- Live SSE device map, route statistics, history range, CSV/GPX export, deletion and configurable retention.
- Standalone Belabox device agent with its own password-protected web panel on port 26666, offline queue and diagnostics; no BelaUI patching.
- OBS Browser Source overlay with live SSE updates, speed-aware zoom, configurable map/text styling and GPS/session statistics.
- Docker deployment with PostgreSQL, database migrations, Express API, React frontend and Caddy reverse proxy.

## Local development

Requirements: Node.js 24+, Docker Desktop and Docker Compose.

Run the complete local application with one command:

```powershell
.\scripts\start-local.ps1
```

Open `http://localhost:8080`. Stop the local stack with:

```powershell
.\scripts\stop-local.ps1
```

The commands below are only needed when working on the frontend and backend separately with hot reload.

Start PostgreSQL:

```powershell
docker compose up -d postgres
```

Start the backend:

```powershell
cd src/backend
npm install
npm start
```

Start the Vite frontend in a second terminal:

```powershell
cd src/frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Production deployment

1. Copy `.env.example` to `.env`.
2. Set a long, unique `POSTGRES_PASSWORD` and `JWT_SECRET` in `.env`.
3. Set `APP_DOMAIN` to the public DNS name, for example `gps.example.com`.
4. Point the domain's DNS A/AAAA record at the server and allow inbound TCP ports 80 and 443.
5. Run:

```powershell
docker compose up -d --build
```

Caddy obtains and renews the HTTPS certificate automatically when `APP_DOMAIN` resolves publicly to the server. The database is not exposed publicly; its port is bound only to `127.0.0.1`.

Check service status:

```powershell
docker compose ps
curl.exe https://your-domain.example/health
```

## Backups

Create a PostgreSQL backup on the Docker host:

```powershell
.\scripts\backup-postgres.ps1
```

The custom-format dump is written to the ignored `backups/` directory. To restore it into a deliberately prepared empty database, use `pg_restore` inside the PostgreSQL container; do not restore over a production database without a separate, verified backup.

## GPS update API

Interactive API documentation is available at `/api/docs`; the source OpenAPI document is available at `/api/openapi.yaml`.

`POST /api/v1/gps/update` requires:

- `Authorization: Bearer <device key>`
- `X-Device-Id: <device ID>`
- `X-Request-Timestamp: <Unix seconds>`
- `X-Request-Nonce: <unique UUID>`

The JSON body requires `latitude` and `longitude`; it can also include `altitude`, `speed`, `heading`, `accuracy`, `satellites` and `recorded_at`.

For local testing, run [scripts/simulate-gps.ps1](scripts/simulate-gps.ps1):

```powershell
.\scripts\simulate-gps.ps1 -DeviceId test1
```

The script checks `http://localhost:8080/health`, then asks for the device key without displaying or saving it. To test another deployment, pass its complete update endpoint with `-ApiUrl`.

## Standalone Belabox installation

The recommended device integration is independent from BelaUI. It runs as its own systemd service and provides a local configuration interface on port `26666`.

Follow the complete beginner-friendly guide in [docs/belabox-standalone-installation.md](docs/belabox-standalone-installation.md). Do not expose port `26666` directly to the public internet.

## Security notes

- Never commit `.env`, device keys, overlay URLs or database dumps.
- A device key and an OBS overlay URL are displayed only once.
- Replacing a GPS key immediately invalidates the former key.
- Revoke an overlay when its Browser Source URL is no longer needed.
