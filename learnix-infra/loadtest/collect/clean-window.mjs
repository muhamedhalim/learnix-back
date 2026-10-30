// Per-endpoint latency for the part of a run where NO auth request was active (after warm-up logins finish, before
// the first refresh), from the k6 point stream written by collect/run.mjs.
//
//   node collect/clean-window.mjs <run-id>
//
// Why: in scenarios/baseline.js every VU logs in during warm-up and refreshes once, all at about the same moment 10
// minutes later, so the "steady" phase contains a refresh wave that a real fleet would not produce. This view
// separates the two. The window is chosen from the data (end of the last warm-up login, start of the first refresh),
// not from a clock.
import { readFileSync } from 'node:fs';

import { LIMITS_MS } from '../lib/thresholds.js';

const runId = process.argv[2];
if (!runId) throw new Error('usage: node collect/clean-window.mjs <run-id>');
const reqs = [];
for (const l of readFileSync(`results/${runId}/k6-points.json`, 'utf8').split('\n')) {
  if (!l.includes('"http_req_duration"')) continue;
  const o = JSON.parse(l);
  if (o.type !== 'Point' || o.metric !== 'http_req_duration') continue;
  const end = Date.parse(o.data.time);
  reqs.push({ end, start: end - o.data.value, ms: o.data.value, ep: o.data.tags.endpoint ?? 'unknown' });
}
const auth = reqs.filter((r) => r.ep === 'auth.login' || r.ep === 'auth.refresh');
const lastLoginEnd = Math.max(...auth.filter((r) => r.ep === 'auth.login').map((r) => r.end));
const firstRefreshStart = Math.min(...auth.filter((r) => r.ep === 'auth.refresh').map((r) => r.start));
const from = lastLoginEnd;
const to = Number.isFinite(firstRefreshStart) ? firstRefreshStart : Infinity;
const inWin = reqs.filter((r) => r.start >= from && r.end <= to && !r.ep.startsWith('auth.'));

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const by = new Map();
for (const r of inWin) {
  if (!by.has(r.ep)) by.set(r.ep, []);
  by.get(r.ep).push(r.ms);
}
console.log(`run ${runId}: clean window ${((to - from) / 1000).toFixed(0)} s, ${inWin.length} requests, no auth request active`);
console.log('endpoint                    n     p50     p95     p99     max   limit  result');
[...by.entries()]
  .sort((a, b) => pct(b[1], 95) - pct(a[1], 95))
  .forEach(([ep, v]) => {
    const lim = LIMITS_MS[ep];
    const p95 = pct(v, 95);
    const note = v.length < 50 ? ' (n<50: indicative)' : '';
    console.log(
      `${ep.padEnd(26)}${String(v.length).padStart(4)}${pct(v, 50).toFixed(0).padStart(8)}${p95.toFixed(0).padStart(8)}${pct(v, 99).toFixed(0).padStart(8)}${Math.max(...v).toFixed(0).padStart(8)}${String(lim ?? '-').padStart(8)}  ${lim === undefined ? '-' : p95 < lim ? 'ok' : 'MISS'}${note}`,
    );
  });
