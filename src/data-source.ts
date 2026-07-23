import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { resolveDatabaseSsl } from './common/utils/database-ssl.util';

config();

export function typeOrmArtifactPaths(compiled: boolean): {
  entities: string[];
  migrations: string[];
} {
  const baseDir = compiled ? 'dist' : 'src';
  const fileExtension = compiled ? 'js' : 'ts';
  const migrationsDir = compiled ? 'dist/src/migrations' : 'src/migrations';
  return {
    entities: [`${baseDir}/**/entities/*.entity.${fileExtension}`],
    migrations: [`${migrationsDir}/[0-9]*-*.${fileExtension}`],
  };
}

// Production CLI runs the compiled data source and must discover .js entities.
const artifacts = typeOrmArtifactPaths(__filename.endsWith('.js'));

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'] ?? '',
  entities: artifacts.entities,
  // Migration files are timestamp-prefixed (for example `1734986400000-InitialSchema`).
  // Restricting the glob to that convention keeps compiled Jest specs/tests out of production.
  migrations: artifacts.migrations,
  synchronize: false, // Always false for migrations
  logging: true,
  migrationsTransactionMode: 'each', // Allow individual migrations to control transaction behavior
  ssl: resolveDatabaseSsl(process.env['DATABASE_URL']),
});
