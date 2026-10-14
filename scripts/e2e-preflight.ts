// Proves the E2E job's runtime is usable BEFORE jest starts, so an infrastructure problem (Postgres or
// Redis service not reachable, wrong Node major) fails here with a one-line cause instead of surfacing
// as dozens of unrelated suite failures — or as a hang — twenty minutes later.
//
// It only reads: one `SELECT version()` and one Redis `PING`. It prints server versions and the Node
// version, never a connection string, host credential or any other environment value.
//
// USAGE: npm run e2e:preflight        (needs DATABASE_URL, and REDIS_URL or REDIS_HOST/REDIS_PORT)

import { Client } from 'pg';
import Redis from 'ioredis';

const REQUIRED_NODE_MAJOR = 24;
const CONNECT_TIMEOUT_MS = 10_000;

// Node reports a refused connection as an AggregateError with an empty message; fall back to the code.
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  const inner =
    error instanceof AggregateError ? (error.errors[0] as NodeJS.ErrnoException)?.code : undefined;
  return error.message || code || inner || error.name;
}

function redisTarget(): string {
  const url = process.env['REDIS_URL'];
  if (url !== undefined && url !== '') return url;
  const host = process.env['REDIS_HOST'] ?? 'localhost';
  const port = process.env['REDIS_PORT'] ?? '6379';
  return `redis://${host}:${port}`;
}

async function checkPostgres(): Promise<string> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set');
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    const result = await client.query<{ version: string }>('SELECT version() AS version');
    return result.rows[0]?.version.split(' on ')[0] ?? 'unknown version';
  } finally {
    await client.end();
  }
}

async function checkRedis(): Promise<string> {
  const redis = new Redis(redisTarget(), {
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  // The rejection of connect() below is the report; ioredis would otherwise also print each error.
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`unexpected PING reply "${pong}"`);
    const info = await redis.info('server');
    return `Redis ${/redis_version:(\S+)/u.exec(info)?.[1] ?? 'unknown version'}`;
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`Node.js v${process.versions.node}`);
  if (nodeMajor !== REQUIRED_NODE_MAJOR) {
    failures.push(
      `Node.js major ${nodeMajor} is not the ${REQUIRED_NODE_MAJOR} the pipeline targets`,
    );
  }

  for (const [name, check] of [
    ['PostgreSQL', checkPostgres],
    ['Redis', checkRedis],
  ] as const) {
    try {
      console.log(`${name}: ${await check()}`);
    } catch (error) {
      failures.push(`${name} is not usable: ${describe(error)}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::E2E preflight: ${failure}`);
    process.exit(1);
  }
  console.log('E2E preflight passed.');
}

void main();
