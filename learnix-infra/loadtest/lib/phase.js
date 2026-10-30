// Marks requests made during the warm-up window so thresholds can judge steady state only. First-time logins (about
// 1 s of bcrypt CPU each) legitimately cluster at the start of a run; they are still recorded, just tagged `warmup`.
let startedAt = 0;
let warmupMs = 0;

export function initPhase(data) {
  startedAt = data.startedAt || 0;
  warmupMs = data.warmupMs || 0;
}

export function phase() {
  return warmupMs > 0 && Date.now() - startedAt < warmupMs ? 'warmup' : 'steady';
}

export function toMs(duration) {
  const m = /^(\d+)(s|m|h)$/.exec(duration);
  if (!m) throw new Error(`bad duration: ${duration}`);
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}
