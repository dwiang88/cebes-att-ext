/* Worker tests: stubs global.fetch, exercises the Worker fetch handler end to end. */
const assert = require('node:assert/strict');

const calls = [];
const CLAIMS = {
  sub: '12',
  employeeId: '12',
  email: 'da.rustanto@cebes.co.id',
  name: 'Power Rangers  Merah',
  role: 'Regular',
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const TOKEN = [b64({ alg: 'HS256', typ: 'JWT' }), b64(CLAIMS), 'sig'].join('.');

let clockInCount = 0;
const logins = () => calls.filter((c) => c.url.endsWith('/auth/login')).length;
const json = (status, payload) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });

const stubFetch = async (url, init = {}) => {
  calls.push({ url, method: init.method, headers: init.headers, body: init.body });
  if (url.endsWith('/auth/login')) return json(200, { data: { accessToken: TOKEN } });
  if (url.endsWith('/attendance/clock-in')) {
    clockInCount += 1;
    if (clockInCount === 1) return json(400, { message: 'You have already clocked in today' });
    return json(201, { message: 'clock in recorded' });
  }
  if (url.endsWith('/attendance/clock-out')) return json(200, { message: 'clock out recorded' });
  throw new Error('unexpected upstream call: ' + url);
};
const nativeFetch = global.fetch;
global.fetch = stubFetch;

const ENV = { APP_EMAIL: 'da.rustanto@cebes.co.id', APP_PASSWORD: 'secret' };
const ORIGIN = 'https://absen.example.workers.dev';

(async () => {
  const { default: worker } = await import('../worker/index.js');

  const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), ENV);
  const get = (path) => call(path);
  const post = (path, body) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 1. session auto-login and profile mapping
  const session = await get('/api/session');
  assert.equal(session.status, 200);
  const sessionData = await session.json();
  assert.equal(sessionData.ok, true);
  assert.equal(sessionData.profile.name, 'Power Rangers Merah'); // whitespace normalised
  assert.equal(sessionData.profile.employeeId, '12');
  assert.equal(sessionData.profile.role, 'Regular');
  assert.match(sessionData.account.email, /^\w+\*+@cebes\.co\.id$/);
  const sessionText = JSON.stringify(sessionData);
  assert.ok(!sessionText.includes('secret'), 'password must never leak');
  assert.ok(!sessionText.includes(TOKEN), 'token must never reach the browser');
  assert.equal(session.headers.get('cache-control'), 'no-store');
  console.log('PASS  GET /api/session ->', sessionData.profile.name, '|', sessionData.account.email);
  assert.equal(logins(), 1);

  // 2. clock-in rejected upstream surfaces the API message
  const rejected = await post('/api/clock-in', { latitude: null, longitude: null, workLocation: 'WorkFromHome' });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.message, 'You have already clocked in today');
  console.log('PASS  POST /api/clock-in (upstream rejection surfaced)');

  // 3. clock-in succeeds with the exact upstream contract
  const ok = await post('/api/clock-in', { latitude: null, longitude: null, workLocation: 'WorkFromHome' });
  assert.equal(ok.status, 200); // proxy normalises upstream 201
  assert.equal((await ok.json()).meta.workLocation, 'WorkFromHome');
  const clockInCall = calls.filter((c) => c.url.endsWith('/attendance/clock-in')).pop();
  assert.equal(clockInCall.headers.origin, 'https://connect.cebes.co.id');
  assert.equal(clockInCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(clockInCall.body), { latitude: null, longitude: null, workLocation: 'WorkFromHome' });
  console.log('PASS  POST /api/clock-in -> body', clockInCall.body);

  // 4. token cached for the isolate
  assert.equal(logins(), 1);
  console.log('PASS  token cached across requests (1 login total)');

  // 5. clock-out
  const out = await post('/api/clock-out', {});
  assert.equal(out.status, 200);
  assert.equal((await out.json()).action, 'clock-out');
  console.log('PASS  POST /api/clock-out');

  // 6. upstream 401 triggers exactly one re-login
  let refreshed = false;
  global.fetch = async (url, init = {}) => {
    if (url.endsWith('/attendance/clock-in') && !refreshed) {
      refreshed = true;
      return json(401, { message: 'token expired' });
    }
    return stubFetch(url, init);
  };
  const retried = await post('/api/clock-in', { workLocation: 'Office' });
  assert.equal(retried.status, 200);
  assert.equal(logins(), 2, 'should re-login once after a 401');
  console.log('PASS  401 upstream triggers exactly one re-login');

  // 7. work location is allow-listed
  global.fetch = stubFetch;
  const fallback = await post('/api/clock-out', { workLocation: 'Hacked<script>' });
  assert.equal((await fallback.json()).meta.workLocation, 'WorkFromHome');
  console.log('PASS  unrecognised workLocation falls back to WorkFromHome');

  // 8. non-JSON body
  const bad = await call('/api/clock-in', { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'BAD_REQUEST');
  console.log('PASS  invalid JSON body -> 400');

  // 9. routing and config errors
  assert.equal((await get('/api/nope')).status, 404);
  const unconfigured = await worker.fetch(new Request(`${ORIGIN}/api/session`), {});
  assert.equal(unconfigured.status, 500);
  assert.equal((await unconfigured.json()).error.code, 'PROXY_NOT_CONFIGURED');
  console.log('PASS  404 unknown route, 500 when secrets missing');

  // 10. preflight + non-API paths fall through to the assets binding
  const preflight = await call('/api/clock-in', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  let assetRequest = null;
  const withAssets = { ...ENV, ASSETS: { fetch: (r) => { assetRequest = r; return new Response('index', { status: 200 }); } } };
  const page = await worker.fetch(new Request(`${ORIGIN}/index.html`), withAssets);
  assert.equal(page.status, 200);
  assert.equal(new URL(assetRequest.url).pathname, '/index.html');
  console.log('PASS  OPTIONS preflight -> 204, static paths served from assets');

  console.log('\nAll worker tests passed.');
  global.fetch = nativeFetch;
})().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
