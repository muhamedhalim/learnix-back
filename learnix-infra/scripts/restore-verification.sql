-- Run against the restored scratch instance and against the source; the numbers must match (allowing for
-- writes after the restore point). Read-only.
SELECT 'users' AS table_name, count(*) AS rows FROM users
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'entitlements', count(*) FROM entitlements
UNION ALL SELECT 'ledger_entries', count(*) FROM financial_ledger_entries
UNION ALL SELECT 'migrations', count(*) FROM migrations
ORDER BY table_name;

SELECT max(timestamp) AS last_migration FROM migrations;
SELECT now() - pg_postmaster_start_time() AS uptime;
