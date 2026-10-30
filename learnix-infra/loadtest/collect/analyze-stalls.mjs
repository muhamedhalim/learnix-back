// Joins the timestamped probe (collect/probe.mjs) with k6's per-request points to say WHEN the api stalled and what
// was running at the time.
//
//   cd learnix-infra/loadtest && node collect/analyze-stalls.mjs <run-id>
//
// Reads results/<run-id>/{probe.jsonl,cpu.jsonl,k6-points.json}; writes results/<run-id>/stalls.json and prints a report.
//
// Definitions (all heuristics, stated so the numbers can be challenged):
//   stall sample     probe round-trip above max(100 ms, 10 x the probe median); samples whose own scheduling drift
//                    exceeded 50 ms are dropped as probe-side noise.
//   stall episode    stall samples whose gaps are at most 1 s, merged.
//   in flight        a k6 request whose [end - duration, end] interval overlaps the episode window.
//   cheap endpoint   steady-state median under 50 ms in this run.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const runId = process.argv[2];
if (!runId) throw new Error('usage: node collect/analyze-stalls.mjs <run-id>');
const dir = `results/${runId}`;
for (const f of ['probe.jsonl', 'cpu.jsonl', 'k6-points.json']) {
  if (!existsSync(`${dir}/${f}`)) throw new Error(`${dir}/${f} missing: run with collect/run.mjs (PROBE not 0)`);
}

const lines = (f) =>
  readFileSync(`${dir}/${f}`, 'utf8')
    .split('\n')
    .filter(Boolean);
const probeAll = lines('probe.jsonl').map((l) => JSON.parse(l));
const cpu = lines('cpu.jsonl').map((l) => JSON.parse(l));

const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// k6 JSON stream: keep http_req_duration points only.
const reqs = [];
for (const l of lines('k6-points.json')) {
  if (!l.includes('"http_req_duration"')) continue;
  const o = JSON.parse(l);
  if (o.type !== 'Point' || o.metric !== 'http_req_duration') continue;
  const end = Date.parse(o.data.time);
  reqs.push({
    end,
    start: end - o.data.value,
    ms: o.data.value,
    endpoint: o.data.tags.endpoint ?? o.data.tags.name ?? 'unknown',
    phase: o.data.tags.phase ?? '?',
    status: o.data.tags.status,
  });
}
if (reqs.length === 0) throw new Error('no http_req_duration points found in k6-points.json');
const runStart = Math.min(...reqs.map((r) => r.start));
const runEnd = Math.max(...reqs.map((r) => r.end));

// Probe: drop samples taken while the probe process itself was late, and samples outside the k6 run.
const probe = probeAll.filter((p) => p.t >= runStart - 2000 && p.t <= runEnd + 2000);
const noisy = probe.filter((p) => p.drift > 50).length;
const clean = probe.filter((p) => p.drift <= 50);
const probeMedian = pct(
  clean.map((p) => p.ms),
  50,
);
const threshold = Math.max(100, 10 * probeMedian);
const stalled = clean.filter((p) => p.ms > threshold || p.status !== 200);

// Episodes.
const episodes = [];
for (const p of stalled) {
  const start = p.t - p.ms;
  const last = episodes[episodes.length - 1];
  if (last && start - last.end <= 1000) {
    last.end = Math.max(last.end, p.t);
    last.peakMs = Math.max(last.peakMs, p.ms);
    last.samples += 1;
  } else {
    episodes.push({ start, end: p.t, peakMs: p.ms, samples: 1 });
  }
}

// api CPU utilisation per 2 s window, as a fraction of the 0.5 vCPU quota.
const cpuWindows = [];
for (let i = 1; i < cpu.length; i += 1) {
  const dt = (cpu[i].t - cpu[i - 1].t) / 1000;
  const dc = cpu[i].cpuSeconds - cpu[i - 1].cpuSeconds;
  if (dt > 0 && Number.isFinite(dc)) cpuWindows.push({ t: cpu[i].t, util: dc / dt / 0.5 });
}
const cpuAt = (a, b) => {
  const w = cpuWindows.filter((c) => c.t >= a && c.t <= b + 2000);
  return w.length === 0 ? NaN : Math.max(...w.map((c) => c.util));
};

const isAuth = (e) => e.startsWith('auth.');
const overlap = (r, a, b) => r.start <= b && r.end >= a;

// Warm-up boundary: first request plus the configured warm-up (default 3m, WARMUP env is not recorded here).
const warmupEnd = reqs.filter((r) => r.phase === 'steady').reduce((m, r) => Math.min(m, r.start), Infinity);

for (const e of episodes) {
  const inFlight = reqs.filter((r) => overlap(r, e.start - 500, e.end));
  const auth = inFlight.filter((r) => isAuth(r.endpoint));
  const slow = inFlight
    .filter((r) => !isAuth(r.endpoint) && r.ms > 300)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  e.durationMs = e.end - e.start;
  e.phase = e.start < warmupEnd ? 'warmup' : 'steady';
  e.secondOfMinute = new Date(e.start).getUTCSeconds();
  e.authInFlight = auth.map((r) => r.endpoint);
  e.heaviestOther = slow.map((r) => `${r.endpoint} ${Math.round(r.ms)}ms`);
  e.apiCpuPeak = cpuAt(e.start, e.end);
  e.class =
    auth.length > 0
      ? 'auth in flight'
      : slow.length > 0
        ? 'heavy non-auth request in flight'
        : 'nothing identified';
}

// Endpoint classes.
const byEndpoint = new Map();
for (const r of reqs.filter((x) => x.phase === 'steady')) {
  if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, []);
  byEndpoint.get(r.endpoint).push(r.ms);
}
const cheap = new Set(
  [...byEndpoint.entries()].filter(([name, v]) => !isAuth(name) && pct(v, 50) < 50).map(([n]) => n),
);

// Are slow cheap requests inside stall windows, compared with all cheap requests?
const padded = episodes.map((e) => ({ a: e.start - 300, b: e.end + 300 }));
const inEpisode = (r) => padded.some((w) => overlap(r, w.a, w.b));
const cheapSteady = reqs.filter((r) => r.phase === 'steady' && cheap.has(r.endpoint));
const cheapSlow = cheapSteady.filter((r) => r.ms > 300);
const slowInEpisode = cheapSlow.filter(inEpisode);
const allInEpisode = cheapSteady.filter(inEpisode);

// 30 s timeline.
const timeline = [];
for (let t = runStart; t < runEnd; t += 30000) {
  const p = clean.filter((x) => x.t >= t && x.t < t + 30000).map((x) => x.ms);
  const c = cpuWindows.filter((x) => x.t >= t && x.t < t + 30000).map((x) => x.util);
  timeline.push({
    atSec: Math.round((t - runStart) / 1000),
    probeP50: Math.round(pct(p, 50)),
    probeMax: Math.max(0, ...p),
    apiCpuMax: +Math.max(0, ...c).toFixed(2),
    authInFlightMax: Math.max(
      0,
      ...[0, 10000, 20000].map(
        (o) => reqs.filter((r) => isAuth(r.endpoint) && overlap(r, t + o, t + o + 1000)).length,
      ),
    ),
    stallEpisodes: episodes.filter((e) => e.start >= t && e.start < t + 30000).length,
  });
}

const classCount = {};
for (const e of episodes) classCount[e.class] = (classCount[e.class] ?? 0) + 1;

const report = {
  runId,
  probe: {
    samples: probe.length,
    droppedForProbeDrift: noisy,
    medianMs: probeMedian,
    p95Ms: pct(clean.map((p) => p.ms), 95),
    p99Ms: pct(clean.map((p) => p.ms), 99),
    maxMs: Math.max(...clean.map((p) => p.ms)),
    stallThresholdMs: threshold,
    stalledSamples: stalled.length,
  },
  episodes: { count: episodes.length, byClass: classCount, byPhase: {
    warmup: episodes.filter((e) => e.phase === 'warmup').length,
    steady: episodes.filter((e) => e.phase === 'steady').length,
  } },
  cheapEndpoints: [...cheap],
  cheapTail: {
    steadyRequests: cheapSteady.length,
    slowOver300ms: cheapSlow.length,
    slowInsideStallWindow: slowInEpisode.length,
    shareOfAllCheapInsideStallWindow: +(allInEpisode.length / Math.max(1, cheapSteady.length)).toFixed(3),
    shareOfSlowInsideStallWindow: +(slowInEpisode.length / Math.max(1, cheapSlow.length)).toFixed(3),
  },
  timeline,
  topEpisodes: [...episodes].sort((a, b) => b.peakMs - a.peakMs).slice(0, 15),
};
writeFileSync(`${dir}/stalls.json`, JSON.stringify(report, null, 2));

const f = (n) => (Number.isFinite(n) ? Math.round(n) : '-');
console.log(`run ${runId}: ${probe.length} probe samples (${noisy} dropped for probe drift)`);
console.log(
  `probe round-trip ms  p50 ${f(probeMedian)}  p95 ${f(report.probe.p95Ms)}  p99 ${f(report.probe.p99Ms)}  max ${f(report.probe.maxMs)}  stall threshold ${f(threshold)}`,
);
console.log(
  `stall episodes ${episodes.length} (warmup ${report.episodes.byPhase.warmup}, steady ${report.episodes.byPhase.steady})  ${JSON.stringify(classCount)}`,
);
console.log(
  `cheap-endpoint requests over 300 ms in steady state: ${cheapSlow.length} of ${cheapSteady.length}; ${slowInEpisode.length} inside a stall window (stall windows cover ${(report.cheapTail.shareOfAllCheapInsideStallWindow * 100).toFixed(1)}% of all cheap requests)`,
);
console.log('\ntop episodes by peak probe latency');
for (const e of report.topEpisodes) {
  console.log(
    `  +${f((e.start - runStart) / 1000)}s ${e.phase} peak ${e.peakMs}ms dur ${f(e.durationMs)}ms cpu ${f(e.apiCpuPeak * 100)}% of quota :${String(e.secondOfMinute).padStart(2, '0')}s  ${e.class}  ${e.authInFlight.join(',')} ${e.heaviestOther.join(' | ')}`,
  );
}
console.log('\n30 s timeline: sec  probeP50  probeMax  apiCPU%quota  authInFlight  episodes');
for (const t of timeline) {
  console.log(
    `  ${String(t.atSec).padStart(4)}  ${String(t.probeP50).padStart(5)}  ${String(t.probeMax).padStart(7)}  ${String(Math.round(t.apiCpuMax * 100)).padStart(8)}  ${String(t.authInFlightMax).padStart(8)}  ${t.stallEpisodes}`,
  );
}
