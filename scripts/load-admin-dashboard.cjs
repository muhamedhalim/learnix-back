'use strict';

require('dotenv').config({ quiet: true });

const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { createClient } = require('redis');

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

async function clearDashboardCache() {
  const client = createClient({
    socket: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
  client.on('error', () => undefined);
  await client.connect();
  await client.del('dashboard:admin', 'cache-lock:dashboard:admin');
  await client.quit();
}

async function run() {
  const token = await createAdminToken();
  if (process.env.LOAD_TEST_CLEAR_CACHE !== 'false') {
    await clearDashboardCache();
  }

  const responseTimes = [];
  const statusCounts = {};

  const result = await new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${BASE_URL}/api/v1/analytics/admin/dashboard`,
        connections: 50,
        amount: 50,
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

  const metricsResponse = await fetch(`${BASE_URL}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  if (!metricsResponse.ok) {
    throw new Error(`Metrics scrape failed with ${metricsResponse.status}`);
  }
  const metrics = await metricsResponse.text();
  const routeMetrics = metrics
    .split('\n')
    .filter(
      (line) =>
        line.includes('route="/api/v1/analytics/admin/dashboard"') &&
        (line.startsWith('backend_http_db_queries_') ||
          line.startsWith('backend_http_request_duration_seconds_count')),
    );

  console.log(
    JSON.stringify(
      {
        tool: `autocannon ${require('autocannon/package.json').version}`,
        connections: 50,
        requested: 50,
        completed: result.requests.total,
        errors: result.errors,
        timeouts: result.timeouts,
        non2xx: result.non2xx,
        statusCounts,
        latencyMs: {
          p50: percentile(responseTimes, 50),
          p95: percentile(responseTimes, 95),
          p99: percentile(responseTimes, 99),
          min: responseTimes[0],
          max: responseTimes.at(-1),
        },
        routeMetrics,
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
