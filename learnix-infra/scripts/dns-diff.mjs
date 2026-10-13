#!/usr/bin/env node
// Phase 6 acceptance: every DNS record resolves identically at the old and the new authoritative servers.
//   node scripts/dns-diff.mjs records.json --old ns1.cloudflare.com --new ns-123.awsdns-45.org
// records.json: [{"name":"learnix.school","type":"MX"}, ...]  (the exported Cloudflare zone)
// --old / --new accept a host name or an IP; names are resolved first. Read-only. Exit 1 on any difference.
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const oldNs = arg('--old');
const newNs = arg('--new');
if (!file || !oldNs || !newNs) {
  console.error('usage: dns-diff.mjs records.json --old <ns host|ip> --new <ns host|ip>');
  process.exit(2);
}

function makePromiseResolver(ips) {
  const r = new dns.Resolver({ timeout: 4000, tries: 2 });
  r.setServers(ips);
  return r;
}

const norm = (type, answer) => {
  const flat = (Array.isArray(answer) ? answer : [answer]).map((a) => {
    if (typeof a === 'string') return a.toLowerCase().replace(/\.$/, '');
    if (a.exchange) return `${a.priority} ${a.exchange.toLowerCase().replace(/\.$/, '')}`;
    if (Array.isArray(a)) return a.join('');
    if (a.nsname) return a.nsname;
    return JSON.stringify(a);
  });
  return flat.sort();
};

async function lookup(r, name, type) {
  try {
    const t = type.toUpperCase();
    const ans = t === 'A' ? await r.resolve4(name) : t === 'AAAA' ? await r.resolve6(name) : await r.resolve(name, t);
    return norm(t, ans);
  } catch (e) {
    return [`(${e.code ?? e.message})`];
  }
}

const records = JSON.parse(readFileSync(file, 'utf8'));
const old = makePromiseResolver(/^\d/.test(oldNs) ? [oldNs] : await dns.resolve4(oldNs));
const neu = makePromiseResolver(/^\d/.test(newNs) ? [newNs] : await dns.resolve4(newNs));

let diffs = 0;
for (const { name, type } of records) {
  const [a, b] = await Promise.all([lookup(old, name, type), lookup(neu, name, type)]);
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) diffs++;
  console.log(`${same ? 'SAME' : 'DIFF'}  ${type.padEnd(5)} ${name}${same ? '' : `\n        old: ${a.join(' | ')}\n        new: ${b.join(' | ')}`}`);
}
console.log(`\n${records.length - diffs}/${records.length} identical`);
process.exit(diffs === 0 ? 0 : 1);
