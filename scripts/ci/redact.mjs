// Masks credentials in text that is about to be published (job summaries, annotations, uploaded logs).
//
//   node scripts/ci/redact.mjs < raw.log > redacted.log
//
// Best effort by pattern, not a guarantee: it exists so that an accidental connection string or token in
// a test failure message does not leave the runner. The E2E values in CI are synthetic and disposable;
// this protects against that ever changing. No dependencies: it runs on the runner's own Node.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const RULES = [
  // postgres://user:password@host, https://token@github.com
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:?[^\s/@]*@/gi, '$1***@'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // key=value / "key": "value" for names that hold secrets
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1$2***',
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '***'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***'],
];

export function redact(text) {
  let out = text.replace(ANSI, '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => process.stdout.write(`${redact(line)}\n`));
}
