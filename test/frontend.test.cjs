/* Static integrity checks for the PWA front-end and Cloudflare config (no browser required). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

/* ---------------------------------------------- 1. inline script parses OK */
const scriptBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
assert.ok(scriptBlocks.length >= 2, 'expected tailwind config + app script blocks');
const appScript = scriptBlocks[scriptBlocks.length - 1];
assert.ok(appScript.includes('doClock'), 'app script should contain the clocking logic');

const tmp = path.join(os.tmpdir(), 'absen-inline-check.mjs');
fs.writeFileSync(tmp, appScript);
execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
fs.unlinkSync(tmp);
console.log('PASS  inline JavaScript parses cleanly');

/* --------------------------------- 2. every getElementById target exists */
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const referenced = [
  ...[...appScript.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...appScript.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
];
const missing = referenced.filter((id) => !htmlIds.has(id));
assert.deepEqual(missing, [], `these ids are referenced but absent from the DOM: ${missing.join(', ')}`);
console.log(`PASS  all ${referenced.length} referenced element ids exist in the markup`);

/* ------------------------------------------- 3. single-button minimal UI */
const clockButtons = [...html.matchAll(/<button[^>]*id="clockBtn(?:Mobile)?"/g)].length;
assert.equal(clockButtons, 1, 'there should be exactly one clock button');
assert.ok(!html.includes('clockBtnMobile'), 'no duplicate mobile button is needed');
for (const removed of ['logList', 'clearLogBtn', 'monthTotal', 'todayIn', 'todayOut', 'statusPill', 'ringProgress']) {
  assert.ok(!appScript.includes(removed), `${removed} should no longer exist in the simplified UI`);
}
for (const kept of ['totalHours', 'totalMinutes', 'clockBtn', 'clockBtnText', 'userName']) {
  assert.ok(htmlIds.has(kept), `${kept} must remain in the markup`);
}
console.log('PASS  one clock button, hours total + name present, history widgets removed');

/* ---------------------------------------- 3b. server state drives the UI */
assert.ok(appScript.includes("today: '/api/today'"), 'front-end must call /api/today');
assert.ok(appScript.includes('applyAttendance'), 'attendance payload must be applied');
assert.ok(appScript.includes('elapsedMs'), 'total must derive from server state');
assert.ok(appScript.includes('SYNC_INTERVAL_MS'), 'must poll periodically');
assert.ok(appScript.includes("addEventListener('visibilitychange'"), 'must resync on tab focus');
assert.ok(!appScript.includes('readLog') && !appScript.includes('writeLog'), 'localStorage log must be gone');
assert.ok(appScript.includes('readCache'), 'cached server snapshot is still used for offline paint');
assert.ok(appScript.includes('ENDPOINTS.today'), 'sync must call the today endpoint');
console.log('PASS  hours + clocked state are synced from /api/today, not from local logs');

/* ------------------------------------------- 3c. work location selector */
assert.equal(els0(html, 'data-location="WorkFromHome"'), 1, 'needs a WorkFromHome option');
assert.equal(els0(html, 'data-location="Office"'), 1, 'needs an Office option');
assert.ok(html.includes('id="locThumb"'), 'needs the sliding thumb');
assert.ok(appScript.includes('selectLocation'), 'selection handler must exist');
assert.ok(appScript.includes('workLocation: state.workLocation'), 'must send the selected location');
assert.ok(appScript.includes('LOCATION_KEY'), 'selection must be persisted');
assert.ok(!appScript.includes('WORK_LOCATION'), 'the hardcoded constant must be gone');
assert.ok(appScript.includes('aria-pressed'), 'switch must be accessible');
assert.ok(appScript.includes('Masuk pukul'), 'clock-in status text must remain');
console.log('PASS  WorkFromHome / Office switch drives the workLocation payload');

function els0(haystack, needle) { return haystack.split(needle).length - 1; }

/* ------------------------------------------ 4. API contract consistency */
const worker = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');
for (const route of ['/api/today', '/api/clock-in', '/api/clock-out']) {
  assert.ok(appScript.includes(route), `front-end must call ${route}`);
  assert.ok(worker.includes(`'${route.replace('/api', '')}'`), `worker must route ${route.replace('/api', '')}`);
}
console.log('PASS  front-end endpoints match worker routes');

/* ------------------------------------ 5. upstream contract is unchanged */
assert.ok(worker.includes('https://connect.cebes.co.id/api/v1'), 'upstream base url');
assert.ok(worker.includes("UPSTREAM_ORIGIN = 'https://connect.cebes.co.id'"), 'origin header source');
assert.ok(worker.includes('/auth/login'), 'login route');
assert.ok(worker.includes('/attendance/today'), 'today route');
assert.ok(worker.includes('/attendance/${action}'), 'attendance routes');
assert.ok(appScript.includes('workLocation: state.workLocation'), 'the selected work location is sent');
console.log('PASS  upstream contract (login + today + clock-in|clock-out) intact');

/* ------------------------------------------- 6. PWA plumbing references */
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
assert.equal(manifest.name, 'Absen · Clock In / Clock Out');
assert.ok(manifest.icons.some((i) => i.sizes === '192x192'), 'needs a 192px icon');
assert.ok(manifest.icons.some((i) => i.sizes === '512x512'), 'needs a 512px icon');
assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'needs a maskable icon');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');

const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
for (const icon of manifest.icons.map((i) => i.src)) {
  assert.ok(fs.existsSync(path.join(publicDir, icon.replace(/^\//, ''))), `icon missing on disk: ${icon}`);
  assert.ok(sw.includes(icon), `service worker should precache ${icon}`);
}
assert.ok(html.includes('<link rel="manifest" href="/manifest.webmanifest"'), 'manifest link tag');
assert.ok(html.includes('navigator.serviceWorker.register'), 'sw registration');
assert.ok(html.includes('apple-touch-icon'), 'apple touch icon');
console.log('PASS  manifest, icons and service worker precache list agree');

/* ------------------------------------------ 7. wrangler config + secrets */
const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
assert.ok(toml.includes('main = "worker/index.js"'), 'worker entry point');
assert.ok(toml.includes('directory = "public"'), 'assets directory');
assert.ok(toml.includes('binding = "ASSETS"'), 'assets binding');
assert.ok(toml.includes('run_worker_first = ["/api/*"]'), 'api routes to the worker first');
assert.ok(/compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/.test(toml), 'compatibility date set');
assert.ok(fs.existsSync(path.join(root, 'worker', 'index.js')), 'worker entry exists on disk');
console.log('PASS  wrangler config points at the worker and the public assets');

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
assert.ok(gitignore.includes('.dev.vars'), 'must gitignore .dev.vars');
assert.ok(gitignore.includes('.wrangler'), 'must gitignore .wrangler');
assert.ok(!fs.existsSync(path.join(root, '.dev.vars')) === false, '.dev.vars should exist locally for wrangler dev');
const example = fs.readFileSync(path.join(root, '.dev.vars.example'), 'utf8');
assert.ok(example.includes('APP_EMAIL') && example.includes('APP_PASSWORD'), 'secret example documents both vars');
console.log('PASS  secrets are gitignored and documented in .dev.vars.example');

/* ------------------------------- 8. no secrets inside the published assets */
const published = fs.readdirSync(publicDir, { recursive: true }).filter((f) => fs.statSync(path.join(publicDir, f)).isFile());
assert.ok(!published.includes('.dev.vars'), 'secrets must not be inside the assets directory');
assert.ok(!published.includes('.env'), 'secrets must not be inside the assets directory');
for (const file of published.filter((f) => /\.(html|js|webmanifest|css)$/.test(f))) {
  const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(!content.includes('dwiangger'), `${file} must not contain a hardcoded password`);
  assert.ok(!content.includes('da.rustanto@'), `${file} must not contain a hardcoded email`);
}
const workerText = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8');
assert.ok(!workerText.includes('dwiangger'), 'worker must not contain a hardcoded password');
console.log(`PASS  none of the ${published.length} published files leak credentials`);

console.log('\nAll front-end checks passed.');
