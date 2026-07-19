import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { resolveDatabaseSsl } from './common/utils/database-ssl.util';

config();

// Determine if running from compiled code (production) or source (development)
const isCompiled = __filename.endsWith('.js');
const baseDir = isCompiled ? 'dist' : 'src';
const fileExtension = isCompiled ? 'js' : 'ts';
const migrationsDir = isCompiled ? 'dist/src/migrations' : 'src/migrations';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'] ?? '',
  entities: [`${baseDir}/**/entities/*.entity.${fileExtension}`],
  // Migration files are timestamp-prefixed (for example `1734986400000-InitialSchema`).
  // Restricting the glob to that convention keeps compiled Jest specs/tests out of production.
  migrations: [`${migrationsDir}/[0-9]*-*.${fileExtension}`],
  synchronize: false, // Always false for migrations
  logging: true,
  migrationsTransactionMode: 'each', // Allow individual migrations to control transaction behavior
  ssl: resolveDatabaseSsl(process.env['DATABASE_URL']),
});
