// Clean-boot verification: run against a freshly migrated EMPTY database with the app
// already booted (ADMIN_INIT_EMAIL/ADMIN_INIT_PASSWORD set). Read-only except one login.
//
//   BASE_URL=http://localhost:3999/api/v1 DATABASE_URL=postgres://... \
//   ADMIN_INIT_EMAIL=... ADMIN_INIT_PASSWORD=... node scripts/verify-clean-boot.mjs
import pg from 'pg';

const { BASE_URL, DATABASE_URL, ADMIN_INIT_EMAIL, ADMIN_INIT_PASSWORD } = process.env;
for (const [k, v] of Object.entries({ BASE_URL, DATABASE_URL, ADMIN_INIT_EMAIL, ADMIN_INIT_PASSWORD })) {
  if (!v) throw new Error(`${k} is required`);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const count = async (table) => Number((await db.query(`select count(*) from ${table}`)).rows[0].count);

// Legacy-free: no business data may exist; system data must.
for (const t of ['orders', 'lesson_purchases', 'entitlements', 'financial_ledger_entries', 'lessons', 'uploaded_files']) {
  check(`empty: ${t}`, (await count(t)) === 0);
}
check('exactly one user (the seeded admin)', (await count('users')) === 1);
check('system seed: rank_tiers', (await count('rank_tiers')) > 0);
check('system seed: health_alert_rules', (await count('health_alert_rules')) > 0);
check('migration seed: marketplace_categories', (await count('marketplace_categories')) > 0);
await db.end();

const get = (path, init) => fetch(`${BASE_URL}${path}`, init);
check('GET /health/readiness 200', (await get('/health/readiness')).status === 200);
// Marketplace routes exist only when MARKETPLACE_ENABLED=true (off by default).
const publicPaths = ['/packages', '/subjects', '/teachers'];
if (process.env.MARKETPLACE_ENABLED === 'true') publicPaths.push('/marketplace/courses', '/marketplace/categories');
for (const p of publicPaths) {
  check(`public ${p} 200 on empty data`, (await get(p)).status === 200);
}

// Double-submit CSRF login as the seeded admin.
const warm = await get('/health');
const setCookies = warm.headers.getSetCookie();
const xsrf = setCookies.find((c) => c.startsWith('XSRF-TOKEN='));
const raw = decodeURIComponent(xsrf?.split(';')[0].split('=')[1] ?? '').replace(/^s:/, '').split('.')[0];
const login = await get('/auth/login', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': raw,
    cookie: setCookies.map((c) => c.split(';')[0]).join('; '),
  },
  body: JSON.stringify({ email: ADMIN_INIT_EMAIL, password: ADMIN_INIT_PASSWORD }),
});
const body = await login.json().catch(() => ({}));
check('seeded admin can log in', login.status === 200 && body.role === 'admin', `status ${login.status}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nClean boot verified.');
