#!/usr/bin/env node
// Legacy-provider audit for the AWS migration ("no hidden dependencies").
//
//   node scripts/provider-audit.mjs [--back ../learnix-back] [--front ../learnix-front] [--report]
//   node scripts/provider-audit.mjs --write-baseline     (after a REVIEWED removal or addition)
//
// Fails (exit 1) when:
//   1. production source (tests, specs, docs and migrations excluded) references a legacy provider's
//      SDK or host in a file that is not in scripts/provider-baseline.json. Every baseline file is a
//      reviewed rollback path behind a provider switch (MAIL_PROVIDER, SMS_PROVIDER, PUSH_PROVIDER,
//      storage/video capability) or a Phase 8 removal item; new references must not appear.
//   2. a baseline file no longer references the provider (the baseline is stale: re-run with
//      --write-baseline so the inventory shrinks as Phase 8 removes code).
//   3. the AWS deployment configuration (Terraform environments, AWS deploy workflows, Dockerfiles)
//      sets any legacy provider variable, i.e. AWS would actually use the old provider.
// --report prints the per-provider inventory used in AWS-OPEN-ITEMS.md.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const infraRoot = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repos = {
  'learnix-back': resolve(infraRoot, opt('--back', '../learnix-back')),
  'learnix-front': resolve(infraRoot, opt('--front', '../learnix-front')),
};
const baselinePath = join(here, 'provider-baseline.json');

// Patterns per provider. Imports catch SDK use; hosts catch hand-written HTTP clients (Bunny has no SDK).
// Bunny is fully retired: its baseline is EMPTY, so any new reference to it fails this audit.
const PROVIDERS = {
  'bunny-stream': [/bunnycdn\.com/i, /mediadelivery\.net/i, /b-cdn\.net/i, /from ['"]tus-js-client['"]/, /BUNNY_[A-Z_]+/],
  'cloudflare-r2': [/r2\.cloudflarestorage\.com/i, /\bR2_[A-Z_]+/],
  mailersend: [/from ['"]mailersend['"]/, /mailersend\.com/i, /MAILERSEND_[A-Z_]+/],
  twilio: [/from ['"]twilio['"]/, /api\.twilio\.com/i, /TWILIO_[A-Z_]+/],
  firebase: [/from ['"]firebase(-admin)?(\/[a-z-]+)?['"]/, /import\(['"]firebase\/[a-z-]+['"]\)/, /fcm\.googleapis\.com/i, /gstatic\.com\/firebasejs/i, /FIREBASE_[A-Z_]+/],
  sentry: [/from ['"]@sentry\/[a-z-]+['"]/, /import\(['"]@sentry\/[a-z-]+['"]\)/, /sentry\.io/i],
  // Vercel is not listed: it remains the approved frontend host (AWS hosts the backend only), so references to
  // it are expected and are not a migration dependency.
  railway: [/railway\.app/i, /RAILWAY_[A-Z_]+/, /nixpacks/i],
};

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|json|toml|yml|yaml|sh)$/;
// learnix-infra: this very script and the Terraform live in a subdirectory of learnix-back; they name every provider on purpose.
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'dist-test', 'coverage', '.git', 'tmp', 'docs', 'test', 'e2e', '__tests__', 'migrations', 'learnix-infra']);
const SKIP_FILE = /(\.spec\.|\.test\.|\.e2e-spec\.|package-lock\.json$|tsbuildinfo|\.md$|\.example$)/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.') || entry.name === '.github') walk(join(dir, entry.name), out);
    } else if (CODE_EXT.test(entry.name) || entry.name === 'Dockerfile' || entry.name === 'Procfile') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function scan() {
  const found = {};
  for (const [repo, root] of Object.entries(repos)) {
    if (!existsSync(root)) throw new Error(`Repository not found: ${root}`);
    for (const file of walk(root)) {
      const rel = `${repo}/${relative(root, file).split(sep).join('/')}`;
      if (SKIP_FILE.test(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [provider, patterns] of Object.entries(PROVIDERS)) {
        if (patterns.some((p) => p.test(text))) (found[provider] ??= new Set()).add(rel);
      }
    }
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));
}

// The configuration AWS actually runs with must not select any legacy provider.
const LEGACY_ENV = /\b(R2_[A-Z_]+|BUNNY_[A-Z_]+|MAILERSEND_[A-Z_]+|TWILIO_[A-Z_]+|FIREBASE_[A-Z_]+|NEXT_PUBLIC_FIREBASE_[A-Z_]+|SENTRY_[A-Z_]+|NEXT_PUBLIC_SENTRY_[A-Z_]+|RAILWAY_[A-Z_]+)\b/;
const LEGACY_VALUES = /(MAIL_PROVIDER\s*=\s*"mailersend"|SMS_PROVIDER\s*=\s*"twilio"|PUSH_PROVIDER\s*=\s*"fcm")/;
function awsConfigFiles() {
  const files = [];
  for (const env of ['staging', 'production']) {
    const dir = join(infraRoot, 'environments', env);
    for (const f of readdirSync(dir)) if (f.endsWith('.tf')) files.push(join(dir, f));
  }
  files.push(join(repos['learnix-back'], '.github/workflows/ci-cd.yml'));
  return files.filter((f) => existsSync(f));
}

function checkAwsConfig() {
  const problems = [];
  for (const file of awsConfigFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.trim().startsWith('#')) return;
      const m = line.match(LEGACY_ENV) ?? line.match(LEGACY_VALUES);
      if (m) problems.push(`${relative(join(infraRoot, '..'), file)}:${i + 1} sets ${m[0]}`);
    });
  }
  return problems;
}

const current = scan();

if (args.includes('--write-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${relative(infraRoot, baselinePath)} (${Object.values(current).flat().length} entries). Review the diff before committing.`);
  process.exit(0);
}

if (args.includes('--report')) {
  for (const [provider, files] of Object.entries(current)) {
    const byRepo = files.reduce((acc, f) => ((acc[f.split('/')[0]] = (acc[f.split('/')[0]] ?? 0) + 1), acc), {});
    console.log(`${provider.padEnd(14)} ${JSON.stringify(byRepo)}`);
  }
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const failures = [];
for (const [provider, files] of Object.entries(current)) {
  const allowed = new Set(baseline[provider] ?? []);
  for (const f of files) if (!allowed.has(f)) failures.push(`NEW ${provider} reference: ${f}`);
}
for (const [provider, files] of Object.entries(baseline)) {
  const now = new Set(current[provider] ?? []);
  for (const f of files) if (!now.has(f)) failures.push(`STALE baseline (${provider} no longer referenced, shrink the baseline): ${f}`);
}
for (const p of checkAwsConfig()) failures.push(`AWS configuration uses a legacy provider: ${p}`);

const total = Object.values(current).flat().length;
if (failures.length > 0) {
  failures.forEach((f) => console.error(f));
  console.error(`\nprovider-audit: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`provider-audit: OK. ${total} reviewed legacy references (rollback paths / Phase 8 removals); AWS configuration selects no legacy provider.`);
