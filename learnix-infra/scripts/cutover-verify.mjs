#!/usr/bin/env node
// Read-only: is the site's DNS pointing at the CloudFront distribution yet?
//   node scripts/cutover-verify.mjs learnix.school d111111abcdef8.cloudfront.net
// Compares the addresses the public resolvers return for the site name with those of the distribution.
import { Resolver } from 'node:dns/promises';

const [site, distribution] = process.argv.slice(2);
if (!site || !distribution) {
  console.error('usage: cutover-verify.mjs <site> <distribution domain>');
  process.exit(2);
}
const resolvers = { cloudflare: '1.1.1.1', google: '8.8.8.8', quad9: '9.9.9.9' };
const base = new Resolver();
base.setServers(['8.8.8.8']);
const dist = new Set(await base.resolve4(distribution));

let pointing = 0;
for (const [label, ip] of Object.entries(resolvers)) {
  const r = new Resolver();
  r.setServers([ip]);
  const answers = await r.resolve4(site).catch(() => []);
  const onCloudFront = answers.some((a) => dist.has(a));
  if (onCloudFront) pointing++;
  console.log(`${onCloudFront ? 'CLOUDFRONT' : 'elsewhere '}  ${label.padEnd(10)} ${answers.join(', ') || '(no answer)'}`);
}
console.log(`\n${pointing}/${Object.keys(resolvers).length} public resolvers return CloudFront addresses for ${site}`);
process.exit(pointing === Object.keys(resolvers).length ? 0 : 1);
