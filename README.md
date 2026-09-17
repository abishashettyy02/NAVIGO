# NAVIGO
NAVIGO is a real-time bus location demo for Mangaluru. Drivers share browser GPS data, passengers receive position updates over Socket.IO, and Google Maps renders the live map and driving route.

## Required services

Create a Google Cloud project with billing enabled, then enable these APIs:

- **Maps JavaScript API** for the passenger and driver maps.
- **Routes API** for live road distance, route geometry, and traffic-aware driving ETA.

Create two different API keys in Google Cloud:

| Variable | Purpose | Required restriction |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | Loaded in the browser to show Google Maps | Website restrictions: `http://localhost:5173/*` and your deployed domain. API restriction: Maps JavaScript API. |
| `GOOGLE_ROUTES_API_KEY` | Used only by the Express server to request road routes | Server IP restriction where possible. API restriction: Routes API. Never expose this key to the browser. |

Generate a random `JWT_SECRET` with at least 32 characters. It signs user sessions.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your two Google keys.
3. Run `npm.cmd install` from PowerShell, then `npm.cmd run dev`.
4. Open `http://localhost:5173`.

Create a driver account in one browser and a passenger account in another. New accounts receive a six-digit verification code by Gmail before they can sign in. Start the driver shift and approve location permission; the passenger map updates immediately.

## Gmail verification

1. Turn on 2-Step Verification for the Gmail account that will send NAVIGO emails.
2. Create a Gmail **App Password** and put the 16-character value in `GMAIL_APP_PASSWORD`.
3. Add the sending address as `GMAIL_USER`.

Never use your normal Gmail password in `.env` or commit `.env` to Git.

## Timetable data

The API loads routes, stops, buses, and timetable entries from `Navigo.xlsx`. In this local setup the supplied workbook is one folder above the project, so it is found automatically. For deployment, upload the workbook with the service and set `DATA_WORKBOOK_PATH` to its deployed path. The health endpoint reports whether the workbook was loaded.

## Hardware GPS ingestion and arrival estimates

Set a long random `DEVICE_API_KEY` in the server environment and assign every device to its bus in `DEVICE_REGISTRY_JSON`. The device never chooses its bus in a request: the backend resolves the device ID to its configured bus ID. Each device sends updates to `POST /api/device/coordinates` with `Content-Type: application/json` and an `X-Device-Key` header containing that secret.

```json
{
  "deviceId": "gps-unit-001",
  "lat": 12.9141,
  "lng": 74.8560,
  "occupancy": "Seats available",
  "accuracy": 12,
  "sentAt": "2026-09-10T09:45:00.000Z"
}
```

Each accepted location is broadcast instantly to passengers. When a passenger shares their current location, NAVIGO uses the server-side Google Routes API to calculate traffic-aware driving time and distance for buses updated within the last five minutes. The Routes API key stays on the server.

Driver accounts are also bound to one valid bus ID at registration and must provide that ID at login. If the GPS hardware is unavailable, a signed-in driver can temporarily share their phone location; the backend always applies it to that same assigned bus, so it cannot be used to move another bus.

Do not rely on IP address alone for mobile devices—cellular providers and NAT can change it. A unique device ID plus `DEVICE_API_KEY` is the reliable binding; the optional `ip` field in `DEVICE_REGISTRY_JSON` is only suitable for a fixed, trusted public IP.

## Deploy to Render

The included `render.yaml` and `Dockerfile` deploy the web client and Socket.IO API together, which preserves real-time connections.

1. Push this directory to a GitHub repository.
2. In Render, choose **New** → **Blueprint** and select the repository.
3. Set `GOOGLE_MAPS_API_KEY` and `GOOGLE_ROUTES_API_KEY` as secret environment variables.
4. After Render gives you a URL, set `CLIENT_ORIGIN` to that exact URL and add the URL to the browser key's website restrictions.
5. Redeploy once after updating the origin and key restrictions.

## Accounts storage

Passenger and driver accounts are stored in a SQLite database file (`better-sqlite3`), not in server memory, so they survive restarts. It lives at `USERS_DB_PATH`, defaulting to `data/users.db` next to the project. Passwords are always stored as a bcrypt hash, never as plain text. On Render, `render.yaml` attaches a small persistent disk at `/app/data` and points `USERS_DB_PATH` there — without a persistent disk, any container filesystem resets on redeploy and accounts would be lost, so keep that disk attached (or point `USERS_DB_PATH` at a managed volume) before public launch.

## Production limitation

Live bus positions still live in server memory, which is fine for a single instance but resets after a restart and does not support multiple server instances. Before scaling past one instance, add a shared Socket.IO adapter such as Redis and, if needed, move bus state to the same database.
