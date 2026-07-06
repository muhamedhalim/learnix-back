/**
 * Deterministic, seeded shuffling. Given the same seed the order is always
 * identical, so an attempt's question/choice order is stable across resumes and
 * reproducible for grading/audit — while still differing per attempt (each
 * attempt stores its own random `shuffle_seed`).
 */

/** mulberry32 — a small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Return a new array shuffled deterministically from `seed` (Fisher–Yates). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}

/** A stable 32-bit integer seed derived from a base seed and a string key. */
export function deriveSeed(baseSeed: number, key: string): number {
  let hash = baseSeed >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
