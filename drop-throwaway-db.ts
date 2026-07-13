import { Client } from 'pg';

async function main() {
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('DATABASE_URL not set');
  const url = new URL(base);
  const dbName = 'lms_migration_dryrun';
  url.pathname = '/postgres';

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await client.end();
  console.log(`Dropped throwaway database: ${dbName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
