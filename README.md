# Absen — PWA Clock In / Clock Out

Glassmorphism PWA that wraps the Cebes Connect attendance API (`/auth/login`,
`/attendance/clock-in`, `/attendance/clock-out`) into a one-tap mobile app: the
hours worked today and a single clock in / clock out button, installable to the
home screen.

Plain HTML, CSS and JavaScript. No framework, no build step, no runtime
dependencies. The PWA and the API proxy ship as a single **Cloudflare Worker**.

## Why there is a Worker

`connect.cebes.co.id` only returns CORS headers for its own origin, so a PWA
served from anywhere else is blocked by the browser. `worker/index.js` runs on the
same origin as the static app, adds the required `Origin` header, and holds the
credentials in Worker secrets — the browser never sees the password or the JWT.

| App calls | Worker calls |
|---|---|
| `GET /api/today` | `POST /api/v1/auth/login` (cached) → `GET /api/v1/attendance/today` |
| `POST /api/clock-in` | `POST /api/v1/auth/login` (cached) → `POST /api/v1/attendance/clock-in` |
| `POST /api/clock-out` | `POST /api/v1/auth/login` (cached) → `POST /api/v1/attendance/clock-out` |

The Worker logs in on the first request, caches the token in the warm isolate and
re-authenticates automatically when the JWT expires or is rejected.

## Local development

```bash
copy .dev.vars.example .dev.vars   # add APP_EMAIL / APP_PASSWORD
npx wrangler dev                   # http://localhost:8787
```

`wrangler dev` runs the real workerd runtime locally, serves `public/` as static
assets and routes `/api/*` through the Worker — so what you test is what deploys.

## Deploying to Cloudflare

```bash
npx wrangler login                 # once, opens a browser
npx wrangler secret put APP_EMAIL       # your Cebes Connect email
npx wrangler secret put APP_PASSWORD    # your Cebes Connect password
npx wrangler deploy
```

`wrangler deploy` prints a `https://absen.<subdomain>.workers.dev` URL. To use
your own domain, add a route in `wrangler.toml`:

```toml
routes = [{ pattern = "absen.yourdomain.com", custom_domain = true }]
```

Then open the URL in Chrome and install it (address-bar install icon; on iOS use
Share → Add to Home Screen).

Secrets set with `wrangler secret put` are encrypted and are **not** in
`wrangler.toml` or the repo. After changing a secret, re-run `wrangler deploy`
only if you also changed code — a secret update takes effect immediately.

## Files

```
public/index.html             single-file app (markup, styles, logic)
public/manifest.webmanifest   PWA manifest, standalone display, shortcuts
public/sw.js                  service worker: shell cache, API calls never cached
public/icons/                 180/192/512 px icons incl. maskable
worker/index.js               proxy for the three endpoints, Web-standard only
wrangler.toml                 worker entry, assets binding, /api/* routing
test/worker.test.cjs          worker tests with a stubbed upstream
test/frontend.test.cjs        markup/PWA/secret-leak static checks
```

## Tests

```bash
npm test
```

`worker.test.cjs` stubs `global.fetch` and asserts routing, token caching, 401
re-login, payload shape, work-location allow-listing, error mapping, asset
fall-through and that the password and JWT never reach the response.
`frontend.test.cjs` parses the inline script, verifies every `getElementById`
target exists, checks that the manifest, service worker and icons on disk agree,
validates `wrangler.toml`, and fails if a credential would be published.

## Notes

- `workLocation` comes from the Rumah/Kantor switch, is remembered in
  `localStorage`, and is sent on both clock in and clock out. The Worker only
  forwards values from an allow-list and falls back to `WorkFromHome` otherwise.
- `latitude` / `longitude` are sent as `null`, matching the reference requests.
- Hours and clocked state are read from `GET /attendance/today`, so the server is
  the single source of truth. The app syncs on launch, every 60 s, when you
  return to the tab, when connectivity returns, and immediately after a clock
  action. `localStorage` only holds the last snapshot so the UI can paint
  instantly or show something while offline.
- The total ticks live from the open record's `clockIn` timestamp, so it stays
  continuous between syncs.
- Bump `VERSION` in `public/sw.js` whenever you change `index.html`, so the cached
  shell is refreshed on clients that already have the app installed.
