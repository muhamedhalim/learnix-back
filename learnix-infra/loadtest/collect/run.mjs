// Runs one k6 scenario with server-side evidence collected alongside it.
//
//   cd learnix-infra/loadtest && node collect/run.mjs scenarios/smoke.js [--run-id=name] [-- <extra k6 args>]
//
// Writes results/<run-id>/:
//   summary.json      k6 summary (from handleSummary)
//   samples.jsonl     every INTERVAL_MS: container CPU/mem, Postgres connection states + lock waits, Redis memory,
//                     api /metrics (event-loop delay, cache events, queue backlog gauges when present)
//   routes.json       per-route server-side count / avg ms / avg SQL queries per request, as a delta over the run
//   statements.json   top 30 pg_stat_statements rows by total time (stats are reset right before the run)
//   probe.jsonl, cpu.jsonl, k6-points.json  timestamped probe data for collect/analyze-stalls.mjs (PROBE=0 disables)
//   run.json          commit, image, k6 version, start/end, k6 exit code
//
// LOCAL STACK ONLY: it shells out to `docker exec` on the learnix-loadtest-* containers.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';


const args = process.argv.slice(2);
const dash = args.indexOf('--');
const own = dash === -1 ? args : args.slice(0, dash);
const extra = dash === -1 ? [] : args.slice(dash + 1);
const script = own.find((a) => !a.startsWith('--'));
if (!script)
  throw new Error('usage: node collect/run.mjs <scenario.js> [--run-id=name] [-- k6 args]');
const runId =
  own.find((a) => a.startsWith('--run-id='))?.split('=')[1] ??
  `${script.replace(/^.*\//, '').replace(/\.js$/, '')}-${Date.now()}`;
const target = process.env.TARGET ?? 'http://localhost:3001';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(target)) {
  throw new Error(`collect/run.mjs only drives the local stack (TARGET=${target}).`);
}

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 5000);
const METRICS_TOKEN = process.env.METRICS_BEARER_TOKEN ?? 'loadtest-metrics-token';
const dir = `results/${runId}`;
mkdirSync(dir, { recursive: true });

const sh = (cmd, a) =>
  execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const psql = (sql) =>
  sh('docker', [
    'exec',
    'learnix-loadtest-postgres-1',
    'psql',
    '-U',
    'postgres',
    '-d',
    'lms_load',
    '-tAF',
    '|',
    '-c',
    sql,
  ]);

async function scrapeMetrics() {
  const res = await fetch(`${target}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  return res.ok ? await res.text() : '';
}

// Per-route histogram sums/counts from the Prometheus text.
function routeTotals(text) {
  const out = {};
  const grab = (re, field) => {
    for (const m of text.matchAll(re)) {
      const key = `${m[1]} ${m[2]} ${m[3]}`;
      (out[key] ??= {})[field] = Number(m[4]);
    }
  };
  grab(
    /^backend_http_request_duration_seconds_sum\{method="(\w+)",route="([^"]+)",status="(\d+)"\} ([0-9.e+-]+)/gm,
    'sec',
  );
  grab(
    /^backend_http_request_duration_seconds_count\{method="(\w+)",route="([^"]+)",status="(\d+)"\} ([0-9.e+-]+)/gm,
    'n',
  );
  grab(
    /^backend_http_db_queries_total\{method="(\w+)",route="([^"]+)",status="(\d+)"\} ([0-9.e+-]+)/gm,
    'queries',
  );
  return out;
}

function gauges(text) {
  const keep =
    /^(backend_event_loop[^ {]*|backend_nodejs_eventloop[^ {]*|backend_queue[^ ]*|backend_app_cache_events_total[^ ]*|backend_process_resident_memory_bytes[^ ]*) ([0-9.e+-]+)/gm;
  const o = {};
  for (const m of text.matchAll(keep)) o[m[1]] = Number(m[2]);
  return o;
}

async function sample() {
  const t = new Date().toISOString();
  const row = { t };
  try {
    row.containers = Object.fromEntries(
      sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'])
        .split('\n')
        .filter((l) => l.startsWith('learnix-loadtest-'))
        .map((l) => {
          const [n, cpu, mem] = l.split('|');
          return [n.replace('learnix-loadtest-', ''), { cpu, mem }];
        }),
    );
  } catch {
    /* docker stats can fail transiently */
  }
  try {
    row.pgStates = psql(
      "select coalesce(state,'null')||'='||n from (select state, count(*) n from pg_stat_activity where datname='lms_load' group by state) s",
    );
    row.pgLockWaits = Number(
      psql(
        "select count(*) from pg_stat_activity where wait_event_type='Lock' and datname='lms_load'",
      ),
    );
  } catch {
    /* ignore */
  }
  try {
    row.redis = sh('docker', [
      'exec',
      'learnix-loadtest-redis-1',
      'redis-cli',
      'info',
      'memory',
    ]).match(/used_memory_human:(\S+)/)?.[1];
  } catch {
    /* ignore */
  }
  try {
    row.api = gauges(await scrapeMetrics());
  } catch {
    /* ignore */
  }
  appendFileSync(`${dir}/samples.jsonl`, `${JSON.stringify(row)}\n`);
}

const meta = {
  runId,
  script,
  target,
  startedAt: new Date().toISOString(),
  commit: sh('git', ['rev-parse', '--short', 'HEAD']),
  k6: sh('k6', ['version']).split('\n')[0],
};

psql('create extension if not exists pg_stat_statements');
psql('select pg_stat_statements_reset()');
const before = routeTotals(await scrapeMetrics());

const timer = setInterval(() => void sample(), INTERVAL_MS);
await sample();
// PROBE=0 turns off the timestamped probe and the per-request k6 CSV (see collect/probe.mjs, collect/analyze-stalls.mjs).
const withProbe = process.env.PROBE !== '0';
// Separate process: this one makes blocking docker/psql calls that would stall an in-process probe.
const probeProc = withProbe
  ? spawn('node', ['collect/probe.mjs', target, dir, METRICS_TOKEN], { stdio: 'inherit' })
  : null;
const stopProbe = () => probeProc?.kill();
const code = await new Promise((resolve) => {
  const k6 = spawn(
    'k6',
    [
      'run',
      '-e',
      `RUN_ID=${runId}`,
      '-e',
      `TARGET=${target}`,
      ...(withProbe ? ['--out', `json=${dir}/k6-points.json`] : []),
      ...extra,
      script,
    ],
    { stdio: 'inherit' },
  );
  k6.on('exit', (c) => resolve(c ?? 1));
});
clearInterval(timer);
stopProbe();
await sample();

const after = routeTotals(await scrapeMetrics());
const routes = Object.entries(after)
  .map(([key, a]) => {
    const b = before[key] ?? {};
    const n = (a.n ?? 0) - (b.n ?? 0);
    return n > 0
      ? {
          route: key,
          count: n,
          avgMs: +((((a.sec ?? 0) - (b.sec ?? 0)) / n) * 1000).toFixed(1),
          avgQueries: +(((a.queries ?? 0) - (b.queries ?? 0)) / n).toFixed(1),
        }
      : null;
  })
  .filter(Boolean)
  .sort((x, y) => y.count * y.avgMs - x.count * x.avgMs);
writeFileSync(`${dir}/routes.json`, JSON.stringify(routes, null, 2));

const stmts = psql(
  "select calls, round(total_exec_time::numeric,1), round(mean_exec_time::numeric,2), rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 220) from pg_stat_statements where dbid = (select oid from pg_database where datname='lms_load') order by total_exec_time desc limit 30",
);
writeFileSync(
  `${dir}/statements.json`,
  JSON.stringify(
    stmts
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [calls, totalMs, meanMs, rows, query] = l.split('|');
        return { calls: +calls, totalMs: +totalMs, meanMs: +meanMs, rows: +rows, query };
      }),
    null,
    2,
  ),
);
writeFileSync(
  `${dir}/run.json`,
  JSON.stringify({ ...meta, endedAt: new Date().toISOString(), k6ExitCode: code }, null, 2),
);
console.log(`\nevidence written to ${dir}/ (k6 exit ${code})`);
process.exit(code);
