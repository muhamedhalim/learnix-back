import { DataSource } from 'typeorm';

async function main() {
  const url = new URL(process.env['DATABASE_URL']!);
  url.pathname = '/lms_migration_dryrun';
  const ds = new DataSource({ type: 'postgres', url: url.toString() });
  await ds.initialize();
  try {
    const cols = await ds.query(`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments'
      ORDER BY ordinal_position
    `);
    console.log('payments columns (fresh, migration-built):');
    console.table(cols);

    const idx = await ds.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'payments' ORDER BY indexname
    `);
    console.log('indexes:', idx.map((r: { indexname: string }) => r.indexname));
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
