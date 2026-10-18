import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan } from '../prod-guard.mjs';

const rc = (address, actions, after = {}) => ({ address, change: { actions, after, before: null } });
const okBackend = { __backendBucket: 'learnix-production-tfstate-486940690416', __backendKey: 'production/platform.tfstate' };

test('accepts a create-only production plan', () => {
  assert.deepEqual(checkPlan({ ...okBackend, resource_changes: [rc('module.x.aws_s3_bucket.b', ['create'], { bucket: 'learnix-production-files-486940690416' })] }), []);
});
test('rejects deletes and replaces', () => {
  assert.equal(checkPlan({ ...okBackend, resource_changes: [rc('a', ['delete', 'create'])] }).length, 1);
  assert.equal(checkPlan({ ...okBackend, resource_changes: [rc('a', ['delete'])] }, { allowDelete: true }).length, 0);
});
test('rejects names mentioning staging', () => {
  assert.equal(checkPlan({ ...okBackend, resource_changes: [rc('a', ['create'], { name: 'learnix-staging-api' })] }).length, 1);
});
test('rejects the staging backend and a missing backend', () => {
  assert.equal(checkPlan({ __backendBucket: 'learnix-staging-tfstate-486940690416', __backendKey: 'production/platform.tfstate', resource_changes: [] }).length, 1);
  assert.equal(checkPlan({ __backendBucket: null, resource_changes: [] }).length, 1);
});
