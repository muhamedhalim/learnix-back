#!/usr/bin/env node
// Production-vs-staging guard for a Terraform plan in the shared account 486940690416.
// The account id cannot tell the environments apart, so this checks the plan itself:
//   node scripts/prod-guard.mjs <tfplan.json> [--allow-delete]
// where tfplan.json = `terraform show -json tfplan`. Exits 1 (and prints why) when:
//   - the plan's backend is not the production state bucket/key,
//   - any change deletes or replaces a resource (unless --allow-delete),
//   - any planned name/bucket/identifier/arn mentions "staging",
//   - any resource is planned outside eu-central-1 / us-east-1 / eu-west-1.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '486940690416';
const STATE_BUCKET = `learnix-production-tfstate-${ACCOUNT}`;
const STATE_KEY = 'production/platform.tfstate';
const REGIONS = new Set(['eu-central-1', 'us-east-1', 'eu-west-1']);
const NAME_ATTRS = ['name', 'name_prefix', 'bucket', 'identifier', 'replication_group_id', 'cluster_identifier', 'family', 'alias', 'arn', 'role', 'repository'];

export function checkPlan(plan, { allowDelete = false } = {}) {
  const errors = [];

  const backend = plan.configuration?.terraform?.backend ?? plan.backend;
  const bucket = backend?.config?.bucket ?? plan.__backendBucket;
  const key = backend?.config?.key ?? plan.__backendKey;
  if (bucket !== undefined && bucket !== STATE_BUCKET) errors.push(`backend bucket is ${bucket}, expected ${STATE_BUCKET}`);
  if (key !== undefined && key !== STATE_KEY) errors.push(`backend key is ${key}, expected ${STATE_KEY}`);

  for (const rc of plan.resource_changes ?? []) {
    const actions = rc.change?.actions ?? [];
    if (!allowDelete && actions.includes('delete')) {
      errors.push(`${rc.address}: ${actions.join('+')} (delete/replace is not allowed)`);
    }
    const after = rc.change?.after ?? {};
    const before = rc.change?.before ?? {};
    for (const attr of NAME_ATTRS) {
      for (const v of [after[attr], before[attr]]) {
        if (typeof v === 'string' && /staging/i.test(v)) errors.push(`${rc.address}.${attr} mentions staging: ${v}`);
      }
    }
    const region = after.region;
    if (typeof region === 'string' && !REGIONS.has(region)) errors.push(`${rc.address}: region ${region} is not allowed`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: prod-guard.mjs <tfplan.json> [--allow-delete]');
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  // The plan JSON omits partial backend config; read what `terraform init` recorded instead (required).
  const dataDir = process.env.TF_DATA_DIR || '.terraform';
  try {
    const init = JSON.parse(readFileSync(`${dataDir}/terraform.tfstate`, 'utf8'));
    plan.__backendBucket = init.backend?.config?.bucket ?? null;
    plan.__backendKey = init.backend?.config?.key ?? null;
  } catch {
    plan.__backendBucket = null;
  }
  const errors = checkPlan(plan, { allowDelete: process.argv.includes('--allow-delete') });
  const counts = {};
  for (const rc of plan.resource_changes ?? []) {
    const a = (rc.change?.actions ?? []).join('+');
    counts[a] = (counts[a] ?? 0) + 1;
  }
  console.log('plan actions:', JSON.stringify(counts));
  if (errors.length) {
    console.error(`prod-guard: REJECTED (${errors.length})`);
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }
  console.log('prod-guard: OK');
}
