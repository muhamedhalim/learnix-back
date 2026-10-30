// handleSummary: writes results/<RUN_ID>/summary.json and prints a compact table. No remote jslib import, so it
// works offline.
import { RUN_ID } from './config.js';

function fmt(v) {
  return v === undefined ? '-' : v.toFixed(1);
}

export function summarize(data, extra) {
  const m = data.metrics;
  const d = m.http_req_duration ? m.http_req_duration.values : {};
  const lines = [
    `run ${RUN_ID}`,
    `requests ${m.http_reqs ? m.http_reqs.values.count : 0}  rate ${fmt(m.http_reqs && m.http_reqs.values.rate)}/s  failed ${fmt(m.http_req_failed && m.http_req_failed.values.rate * 100)}%`,
    `duration ms  p50 ${fmt(d.med)}  p90 ${fmt(d['p(90)'])}  p95 ${fmt(d['p(95)'])}  p99 ${fmt(d['p(99)'])}  max ${fmt(d.max)}`,
    `checks passed ${m.checks ? m.checks.values.passes : 0}  failed ${m.checks ? m.checks.values.fails : 0}`,
    `dropped_iterations ${m.dropped_iterations ? m.dropped_iterations.values.count : 0}  vus_max ${m.vus_max ? m.vus_max.values.max : '-'}`,
  ];
  // Per-endpoint table from the tagged sub-metrics that lib/thresholds.js declares.
  const prefix = 'http_req_duration{endpoint:';
  const suffix = ',phase:steady}';
  const rows = Object.keys(m)
    .filter((k) => k.startsWith(prefix) && k.endsWith(suffix))
    .map((k) => {
      const v = m[k].values;
      const ok = !m[k].thresholds || Object.values(m[k].thresholds).every((t) => t.ok);
      return { name: k.slice(prefix.length, -suffix.length), v, ok };
    })
    .sort((a, b) => b.v['p(95)'] - a.v['p(95)']);
  if (rows.length > 0) {
    lines.push('', 'steady-state endpoint        p50      p90      p95      p99      max   limit');
    rows.forEach((r) =>
      lines.push(
        `${r.name.padEnd(26)}${fmt(r.v.med).padStart(8)}${fmt(r.v['p(90)']).padStart(9)}${fmt(r.v['p(95)']).padStart(9)}${fmt(r.v['p(99)']).padStart(9)}${fmt(r.v.max).padStart(9)}   ${r.ok ? 'ok' : 'MISS'}`,
      ),
    );
  }
  const failing = [];
  const walk = (group) => {
    (group.checks || []).forEach((c) => {
      if (c.fails > 0) failing.push(`  FAIL ${c.name} (${c.fails} of ${c.passes + c.fails})`);
    });
    (group.groups || []).forEach(walk);
  };
  walk(data.root_group);
  const out = { stdout: `${lines.join('\n')}\n${failing.join('\n')}${failing.length ? '\n' : ''}` };
  out[`results/${RUN_ID}/summary.json`] = JSON.stringify(
    { runId: RUN_ID, ...(extra || {}), data },
    null,
    2,
  );
  return out;
}
