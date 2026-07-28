'use strict';

require('dotenv').config({ quiet: true });

const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { createClient } = require('redis');
const { createHash, randomUUID } = require('crypto');

const METRICS_TOKEN = process.env.METRICS_BEARER_TOKEN ?? 'local-performance-verification-token';
const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:3001';

function percentile(sorted, percentage) {
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1] ?? 0;
}

async function createAdminToken() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();
  const result = await client.query(
    `SELECT id, email, name, role
     FROM users
     WHERE role = 'admin' AND is_active = true AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT 1`,
  );
  await client.end();

  const admin = result.rows[0];
  if (!admin) throw new Error('No active admin user exists for the load test');

  return jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

function hash(value) {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22);
}

function appCacheCounters(metrics) {
  const counters = {};
  for (const line of metrics.split('\n')) {
    if (!line.startsWith('backend_app_cache_events_total{')) continue;
    if (!line.includes('family="admin_dashboard"')) continue;
    const outcome = /outcome="([^"]+)"/.exec(line)?.[1];
    if (outcome) counters[outcome] = Number(line.split(' ').at(-1) ?? 0);
  }
  return counters;
}

function counterDelta(before, after) {
  const outcomes = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries([...outcomes].map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]));
}

async function readMetrics() {
  const response = await fetch(`${BASE_URL}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Metrics scrape failed with ${response.status}`);
  return appCacheCounters(await response.text());
}

/**
 * A v2 cache entry contains the global generation. Changing that generation
 * guarantees a cold key without KEYS/SCAN or an unprefixed deletion. The
 * explicit DEL below removes only the exact legacy key and the exact v2 key
 * selected for this run, and the exists check proves the run starts cold.
 */
async function resetAdminDashboardCache() {
  const client = createClient({
    ...(process.env.REDIS_URL ? { url: process.env.REDIS_URL } : {}),
    socket: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
  client.on('error', () => undefined);
  await client.connect();
  const tenantHash = hash('default');
  const globalGenerationKey = `learnix:cache:v2:cache-generation:tenant:${tenantHash}:family:global`;
  const familyGenerationKey = `learnix:cache:v2:cache-generation:tenant:${tenantHash}:family:admin_dashboard`;
  const globalGeneration = `load-${randomUUID()}`;
  await client.set(globalGenerationKey, globalGeneration);
  const familyGeneration = (await client.get(familyGenerationKey)) ?? '0';
  const internalKey = [
    'v2',
    `tenant:${tenantHash}`,
    `scope:${hash('role:admin')}`,
    'family:admin_dashboard',
    `generation:${globalGeneration}.${familyGeneration}`,
    `parts:${hash('[]')}`,
  ].join(':');
  const cacheKey = `learnix:cache:${internalKey}`;
  const lockKey = `cache-lock:${internalKey}`;
  await client.del('learnix:cache:dashboard:admin', 'cache-lock:dashboard:admin', cacheKey, lockKey);
  const cold = (await client.exists(cacheKey)) === 0;
  await client.quit();
  if (!cold) throw new Error('Cold-cache verification failed: the exact v2 key still exists');
  return { cacheKey, generation: globalGeneration, cold };
}

async function runScenario(name, token, { connections, amount, cold }) {
  const metricsBefore = await readMetrics();
  const coldStart = cold ? await resetAdminDashboardCache() : null;
  const responseTimes = [];
  const statusCounts = {};

  const result = await new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${BASE_URL}/api/v1/analytics/admin/dashboard`,
        connections,
        amount,
        pipelining: 1,
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
      (error, finalResult) => {
        if (error) reject(error);
        else resolve(finalResult);
      },
    );

    instance.on('response', (_client, statusCode, _responseBytes, responseTime) => {
      responseTimes.push(responseTime);
      statusCounts[statusCode] = (statusCounts[statusCode] ?? 0) + 1;
    });
  });

  responseTimes.sort((left, right) => left - right);

  const metricsAfter = await readMetrics();
  return {
    name,
    connections,
    requested: amount,
    completed: result.requests.total,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    statusCounts,
    coldStart,
    cacheEvents: counterDelta(metricsBefore, metricsAfter),
    latencyMs: {
      p50: percentile(responseTimes, 50), p95: percentile(responseTimes, 95),
      p99: percentile(responseTimes, 99), min: responseTimes[0], max: responseTimes.at(-1),
    },
  };
}

async function run() {
  const token = await createAdminToken();
  const scenarios = [
    await runScenario('cold-cache', token, { connections: 1, amount: 1, cold: true }),
    await runScenario('warm-cache', token, { connections: 1, amount: 1, cold: false }),
    await runScenario('concurrent-cold-burst', token, { connections: 50, amount: 50, cold: true }),
    await runScenario('concurrent-warm-burst', token, { connections: 50, amount: 50, cold: false }),
  ];
  console.log(JSON.stringify({ tool: `autocannon ${require('autocannon/package.json').version}`, scenarios }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
