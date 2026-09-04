'use strict';

/**
 * T212 (FR-331, SC-013). Load-tests the public marketplace catalogue —
 * list/search/filter, course detail, and (a smaller, representative slice
 * of) instructor/admin queries — against data `seed-marketplace-load.ts`
 * put in place. Mirrors `load-admin-dashboard.cjs`'s exact tool and
 * measurement approach (`autocannon`, p50/p95/p99 from real response
 * times) for the same target this feature's success criteria states:
 * p95 <= 500ms for list/search, p95 <= 400ms for detail, sustained at 500
 * concurrent learners / 50 concurrent instructors.
 *
 * USAGE
 *   npm run seed:marketplace-load                    # seed data first (see that script's own doc comment)
 *   node scripts/load-marketplace-catalog.cjs         # smoke-scale run against whatever connections/amount below
 *   LOAD_CONNECTIONS=500 LOAD_AMOUNT=5000 node scripts/load-marketplace-catalog.cjs   # closer to FR-331's stated concurrency
 *
 * THIS SCRIPT HAS BEEN RUN ONLY AT SMOKE SCALE. Running it against the
 * full 50,000-course/500,000-enrollment seed at FR-331's stated
 * concurrency (500 learners / 50 instructors) has not been executed to
 * completion in this pass — see tasks.md T212.
 */
require('dotenv').config({ quiet: true });

const autocannon = require('autocannon');

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 20);
const AMOUNT = Number(process.env.LOAD_AMOUNT ?? 200);

function percentile(sorted, percentage) {
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1] ?? 0;
}

async function fetchOneSlug() {
  const res = await fetch(`${BASE_URL}/api/v1/marketplace/courses?limit=1`);
  if (!res.ok) throw new Error(`Could not fetch a course to detail-test against (${res.status}) — has seed-marketplace-load.ts been run?`);
  const body = await res.json();
  const item = body.items?.[0];
  if (!item) throw new Error('No published marketplace courses found — run `npm run seed:marketplace-load` first.');
  return item.slug ?? item.id;
}

async function runScenario(name, url, { connections, amount }) {
  const responseTimes = [];
  const statusCounts = {};

  const result = await new Promise((resolve, reject) => {
    const instance = autocannon({ url, connections, amount, pipelining: 1 }, (error, finalResult) => {
      if (error) reject(error);
      else resolve(finalResult);
    });
    instance.on('response', (_client, statusCode, _responseBytes, responseTime) => {
      responseTimes.push(responseTime);
      statusCounts[statusCode] = (statusCounts[statusCode] ?? 0) + 1;
    });
  });

  responseTimes.sort((left, right) => left - right);
  return {
    name,
    url,
    connections,
    requested: amount,
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
  };
}

async function run() {
  const slug = await fetchOneSlug();

  const scenarios = [
    await runScenario('catalog-list', `${BASE_URL}/api/v1/marketplace/courses`, { connections: CONNECTIONS, amount: AMOUNT }),
    await runScenario(
      'catalog-search',
      `${BASE_URL}/api/v1/marketplace/courses?q=Load&level=beginner&sort=newest`,
      { connections: CONNECTIONS, amount: AMOUNT },
    ),
    await runScenario('catalog-filter', `${BASE_URL}/api/v1/marketplace/courses?minPriceMinor=50000&maxPriceMinor=100000`, {
      connections: CONNECTIONS,
      amount: AMOUNT,
    }),
    await runScenario('course-detail', `${BASE_URL}/api/v1/marketplace/courses/${slug}`, { connections: CONNECTIONS, amount: AMOUNT }),
    await runScenario('course-curriculum', `${BASE_URL}/api/v1/marketplace/courses/${slug}/curriculum`, {
      connections: CONNECTIONS,
      amount: AMOUNT,
    }),
    await runScenario('categories', `${BASE_URL}/api/v1/marketplace/categories`, { connections: CONNECTIONS, amount: AMOUNT }),
  ];

  const summary = scenarios.map((s) => ({
    name: s.name,
    p95Ms: s.latencyMs.p95,
    p99Ms: s.latencyMs.p99,
    errors: s.errors,
    non2xx: s.non2xx,
    threshold: s.name === 'course-detail' || s.name === 'course-curriculum' ? 400 : 500,
    withinThreshold:
      s.latencyMs.p95 <= (s.name === 'course-detail' || s.name === 'course-curriculum' ? 400 : 500),
  }));

  console.log(JSON.stringify({ tool: `autocannon ${require('autocannon/package.json').version}`, connections: CONNECTIONS, amount: AMOUNT, scenarios, summary }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
