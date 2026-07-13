import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { resolveDatabaseSsl } from './common/utils/database-ssl.util';

config();

// Determine if running from compiled code (production) or source (development)
const isCompiled = __filename.endsWith('.js');
const baseDir = isCompiled ? 'dist' : 'src';
const fileExtension = isCompiled ? 'js' : 'ts';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'] ?? '',
  entities: [`${baseDir}/**/entities/*.entity.${fileExtension}`],
  migrations: [`${baseDir}/**/migrations/*.${fileExtension}`],
  synchronize: false, // Always false for migrations
  logging: true,
  migrationsTransactionMode: 'each', // Allow individual migrations to control transaction behavior
  ssl: resolveDatabaseSsl(process.env['DATABASE_URL']),
});
