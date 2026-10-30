// Timestamped responsiveness probe, run next to a k6 scenario by collect/run.mjs (local stack only).
//
// Why: `backend_nodejs_eventloop_lag_max_seconds` is a lifetime maximum (the histogram in
// performance-metrics.registry.ts is never reset), so it cannot say WHEN the loop stalled. Instead this probe
//   - GETs /api/v1/health every PROBE_MS (default 200) and records the round-trip, so an event-loop stall of X ms
//     shows up as a probe round-trip of about X ms at that timestamp;
//   - every 2 s scrapes /metrics for the api's cumulative CPU seconds, so CPU use per window is a delta.
// The probe also records its own scheduling drift: if the probe process itself stalls, that shows up as drift and
// the sample is not evidence about the api.
//
// It must run in its OWN process (collect/run.mjs spawns it): run.mjs makes blocking docker/psql calls that would
// otherwise delay the probe's timers and hide exactly the stalls it is meant to see.
//
//   node collect/probe.mjs <target> <run-dir> <metrics-token>
//
// Output (in the run dir): probe.jsonl {t, ms, status, drift}, cpu.jsonl {t, cpuSeconds, rssBytes, uptime}.
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export function startProbe({ target, dir, metricsToken }) {
  const probeMs = Number(process.env.PROBE_MS ?? 200);
  let stopped = false;
  let seq = 0;

  // Fire on a fixed grid and do NOT wait for the previous response: a slow response must not delay the next probe,
  // otherwise the samples that follow a stall would look "late" and be discarded as probe noise. `drift` is then only
  // this process's own timer lateness.
  async function probeOnce(ip, drift) {
    const startedAt = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${target}/api/v1/health`, {
        headers: { 'x-forwarded-for': ip },
        signal: AbortSignal.timeout(60000),
      });
      status = res.status;
      await res.arrayBuffer();
    } catch {
      /* status 0 = timeout or refused */
    }
    appendFileSync(
      `${dir}/probe.jsonl`,
      `${JSON.stringify({ t: Date.now(), ms: Math.round(performance.now() - startedAt), status, drift })}
`,
    );
  }

  async function probeLoop() {
    let expected = performance.now() + probeMs;
    while (!stopped) {
      await new Promise((r) => setTimeout(r, Math.max(0, expected - performance.now())));
      const drift = Math.round(performance.now() - expected);
      expected += probeMs;
      seq += 1;
      // A distinct client address per request keeps the per-IP throttle (300/min) out of the measurement.
      void probeOnce(`10.250.${(seq >> 8) & 255}.${seq & 255}`, drift);
    }
  }

  async function cpuLoop() {
    while (!stopped) {
      try {
        const res = await fetch(`${target}/metrics`, {
          headers: { authorization: `Bearer ${metricsToken}` },
        });
        const text = await res.text();
        const pick = (name) => Number(text.match(new RegExp(`^${name} ([0-9.e+-]+)`, 'm'))?.[1]);
        appendFileSync(
          `${dir}/cpu.jsonl`,
          `${JSON.stringify({
            t: Date.now(),
            cpuSeconds: pick('backend_process_cpu_seconds_total'),
            rssBytes: pick('backend_process_resident_memory_bytes'),
            uptime: pick('backend_process_uptime_seconds'),
          })}\n`,
        );
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  void probeLoop();
  void cpuLoop();
  return () => {
    stopped = true;
  };
}

if (process.argv[1]?.endsWith('probe.mjs')) {
  const [target, dir, metricsToken] = process.argv.slice(2);
  if (!target || !dir) throw new Error('usage: node collect/probe.mjs <target> <run-dir> <metrics-token>');
  startProbe({ target, dir, metricsToken });
}
