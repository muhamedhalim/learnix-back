import { unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import { DataSource, type EntityManager } from 'typeorm';

import { AdminInitializationService } from '../admin-init/admin-initialization.service';
import { resolveDatabaseSsl } from '../common/utils/database-ssl.util';
import { processEnvReader, resolveRedisUrl } from '../common/utils/redis-connection.util';
import {
  bullMqPrefix,
  namespacedPrefix,
  resolveRedisNamespace,
} from '../common/utils/redis-namespace.util';
import { AppEnvironment, recordReader, resolveAppEnv } from '../config/app-env';
import { typeOrmArtifactPaths } from '../data-source';
import { BunnyStreamService } from '../lessons/bunny-stream.service';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { StorageService } from '../storage/storage.service';
import { seedRequiredSystemData } from './system-seed';

loadDotenv();

const MIGRATION_TABLES = new Set(['migrations', 'typeorm_metadata']);
const SYSTEM_TABLES = new Set(['rank_tiers', 'health_alert_rules']);
const SAFE_KEY_PREFIXES = [
  'images/',
  'thumbnails/',
  'profiles/',
  'resources/',
  'attachments/',
  'books/',
  'omr-sheets/',
  'lesson-resources/',
  'homework-submissions/',
  'support-tickets/',
  'manual-payments/',
  'refunds/',
  'settlements/',
] as const;

const STORAGE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  exactKey?: boolean;
}> = [
  { table: 'users', column: 'profile_picture_url' },
  { table: 'users', column: 'profile_picture_thumbnail_url' },
  { table: 'subjects', column: 'thumbnail' },
  { table: 'lessons', column: 'thumbnail' },
  { table: 'lesson_packages', column: 'thumbnail' },
  { table: 'books', column: 'cover_image' },
  { table: 'books', column: 'book_file', exactKey: true },
  { table: 'lesson_attachments', column: 'url' },
  { table: 'lesson_homework', column: 'resource_url', exactKey: true },
  { table: 'homework_submissions', column: 'resource_url', exactKey: true },
  { table: 'omr_sheets', column: 'image_key', exactKey: true },
  { table: 'complaint_attachments', column: 'storage_key', exactKey: true },
  { table: 'manual_payment_methods', column: 'qr_file_key', exactKey: true },
  { table: 'manual_payment_submissions', column: 'proof_file_key', exactKey: true },
  { table: 'refunds', column: 'proof_file_key', exactKey: true },
  { table: 'teacher_settlements', column: 'proof_file_key', exactKey: true },
];

const JSON_MEDIA_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'questions', column: 'content' },
  { table: 'questions', column: 'answer_key' },
  { table: 'question_versions', column: 'content' },
  { table: 'question_versions', column: 'answer_key' },
  { table: 'exam_questions', column: 'content_snapshot' },
  { table: 'exam_questions', column: 'answer_key_snapshot' },
  { table: 'exam_attempt_answers', column: 'response' },
];

export interface DatabaseIdentity {
  host: string;
  database: string;
  environment: string;
}

export interface TableClassification {
  application: string[];
  system: string[];
  metadata: string[];
  unknown: string[];
}

export interface StorageManifest {
  objectKeys: string[];
  bunnyVideoIds: string[];
  unresolvedReferences: string[];
  localExportFiles: string[];
}

export class UnsafePrelaunchResetError extends Error {
  public constructor(message: string) {
    super(`PRE-LAUNCH RESET REFUSED: ${message}`);
    this.name = 'UnsafePrelaunchResetError';
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  try {
    return new URL(databaseUrl);
  } catch {
    throw new UnsafePrelaunchResetError('DATABASE_URL is missing or invalid.');
  }
}

export function databaseIdentity(env: NodeJS.ProcessEnv): DatabaseIdentity {
  const url = parseDatabaseUrl(env['DATABASE_URL'] ?? '');
  let environment = 'unknown';
  try {
    environment = resolveAppEnv(recordReader(env)).toString();
  } catch {
    environment = env['APP_ENV'] ?? env['NODE_ENV'] ?? 'unknown';
  }
  return {
    host: url.hostname,
    database: url.pathname.replace(/^\//, ''),
    environment,
  };
}

export function targetConfirmation(identity: DatabaseIdentity): string {
  return `${identity.host}/${identity.database}`;
}

export function assertExecutionGuards(
  env: NodeJS.ProcessEnv,
  identity: DatabaseIdentity,
  options: { skipExternal: boolean },
): void {
  const required: Array<[string, string]> = [
    ['RESET_PRELAUNCH_DATA', 'true'],
    ['RESET_PRELAUNCH_BACKUP_CONFIRMED', 'true'],
    ['RESET_PRELAUNCH_SERVICES_STOPPED', 'true'],
  ];
  for (const [name, expected] of required) {
    if (env[name] !== expected) {
      throw new UnsafePrelaunchResetError(`${name}=${expected} is required.`);
    }
  }
  const target = targetConfirmation(identity);
  if (env['RESET_PRELAUNCH_TARGET'] !== target) {
    throw new UnsafePrelaunchResetError(
      `RESET_PRELAUNCH_TARGET must exactly equal the non-secret target identifier "${target}".`,
    );
  }
  if (!env['RESET_PRELAUNCH_BACKUP_REFERENCE']?.trim()) {
    throw new UnsafePrelaunchResetError(
      'RESET_PRELAUNCH_BACKUP_REFERENCE must identify the verified recoverable backup.',
    );
  }

  const appEnv = resolveAppEnv(recordReader(env));
  if (appEnv === AppEnvironment.Production && options.skipExternal) {
    throw new UnsafePrelaunchResetError('--skip-external is forbidden in production.');
  }
  if (appEnv === AppEnvironment.Production && !resolveRedisUrl(processEnvReader())) {
    throw new UnsafePrelaunchResetError('Redis must be configured for a production reset.');
  }
  if (
    appEnv === AppEnvironment.Production &&
    resolveRedisNamespace(processEnvReader()) === '' &&
    env['RESET_PRELAUNCH_REDIS_DEDICATED'] !== 'true'
  ) {
    throw new UnsafePrelaunchResetError(
      'Production Redis has no namespace. Confirm its selected Redis database is dedicated by setting RESET_PRELAUNCH_REDIS_DEDICATED=true; otherwise generic throttler keys cannot be safely identified.',
    );
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new UnsafePrelaunchResetError(`Unsafe SQL identifier encountered: ${value}`);
  }
  return `"${value}"`;
}

export function classifyTables(actual: string[], entityTables: string[]): TableClassification {
  const entities = new Set(entityTables);
  const result: TableClassification = { application: [], system: [], metadata: [], unknown: [] };
  for (const table of [...actual].sort()) {
    if (MIGRATION_TABLES.has(table)) result.metadata.push(table);
    else if (SYSTEM_TABLES.has(table)) result.system.push(table);
    else if (entities.has(table)) result.application.push(table);
    else result.unknown.push(table);
  }
  return result;
}

async function publicTables(dataSource: DataSource): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
  )) as Array<{ tablename: string }>;
  return rows.map((row) => row.tablename);
}

function entityTableNames(dataSource: DataSource): string[] {
  return [...new Set(dataSource.entityMetadatas.map((metadata) => metadata.tableName))];
}

async function rowCounts(
  dataSource: DataSource,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)}`,
    )) as Array<{ count: number }>;
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

function walkStrings(value: unknown, found: string[]): void {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, found));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => walkStrings(item, found));
  }
}

function safeObjectKey(storage: StorageService, value: string, exactKey: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//iu.test(trimmed) && !storage.isOwnUrl(trimmed)) return null;
  const key = storage.toKey(trimmed);
  if (!key || key.includes('\\') || key.split('/').includes('..')) return null;
  if (!exactKey && !SAFE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return null;
  return key;
}

async function collectStorageManifest(
  dataSource: DataSource,
  storage: StorageService,
  config: ConfigService,
): Promise<StorageManifest> {
  const keys = new Set<string>();
  const unresolved = new Set<string>();
  for (const spec of STORAGE_COLUMNS) {
    const rows = (await dataSource.query(
      `SELECT ${quoteIdentifier(spec.column)} AS value FROM ${quoteIdentifier(spec.table)} WHERE ${quoteIdentifier(spec.column)} IS NOT NULL`,
    )) as Array<{ value: string }>;
    for (const row of rows) {
      const key = safeObjectKey(storage, row.value, spec.exactKey === true);
      if (key) keys.add(key);
      else unresolved.add(`${spec.table}.${spec.column}`);
    }
  }

  const tracked = (await dataSource.query(
    `SELECT folder || '/' || filename AS value FROM uploaded_files WHERE folder IS NOT NULL AND filename IS NOT NULL`,
  )) as Array<{ value: string }>;
  tracked.forEach((row) => {
    const key = safeObjectKey(storage, row.value, true);
    if (key) keys.add(key);
  });

  for (const spec of JSON_MEDIA_COLUMNS) {
    const rows = (await dataSource.query(
      `SELECT ${quoteIdentifier(spec.column)} AS value FROM ${quoteIdentifier(spec.table)} WHERE ${quoteIdentifier(spec.column)} IS NOT NULL`,
    )) as Array<{ value: unknown }>;
    const strings: string[] = [];
    rows.forEach((row) => walkStrings(row.value, strings));
    strings.forEach((value) => {
      const key = safeObjectKey(storage, value, false);
      if (key) keys.add(key);
    });
  }

  const configuredLibrary = config.get<string>('BUNNY_STREAM_LIBRARY_ID') ?? '';
  const lessonVideos = (await dataSource.query(
    `SELECT bunny_video_id AS id, bunny_library_id AS library_id
     FROM lessons WHERE bunny_video_id IS NOT NULL`,
  )) as Array<{ id: string; library_id: string | null }>;
  const sessionVideos = (await dataSource.query(
    `SELECT bunny_video_id AS id FROM lesson_video_upload_sessions
     UNION SELECT previous_bunny_video_id AS id FROM lesson_video_upload_sessions WHERE previous_bunny_video_id IS NOT NULL`,
  )) as Array<{ id: string }>;
  const videos = new Set(sessionVideos.map((row) => row.id));
  lessonVideos.forEach((row) => {
    if (row.library_id && row.library_id !== configuredLibrary) {
      unresolved.add(`lessons.bunny_library_id:${row.id}`);
    } else {
      videos.add(row.id);
    }
  });
  const exports = (await dataSource.query(
    `SELECT file_path AS path FROM code_exports WHERE file_path IS NOT NULL`,
  )) as Array<{ path: string }>;

  return {
    objectKeys: [...keys].sort(),
    bunnyVideoIds: [...videos].sort(),
    unresolvedReferences: [...unresolved].sort(),
    localExportFiles: [...new Set(exports.map((row) => row.path))].sort(),
  };
}

async function cleanupStorage(
  manifest: StorageManifest,
  storage: StorageService,
  bunny: BunnyStreamService,
  config: ConfigService,
): Promise<{ objectsDeleted: number; videosDeleted: number; localFilesDeleted: number }> {
  const objectsDeleted = await cleanupObjectKeys(manifest.objectKeys, storage, config);

  let videosDeleted = 0;
  for (const id of manifest.bunnyVideoIds) {
    if (!(await bunny.deleteVideo(id))) {
      throw new Error(`Bunny Stream video cleanup failed: ${id}`);
    }
    videosDeleted++;
  }

  let localFilesDeleted = 0;
  const exportRoot = resolve(config.get<string>('CODE_EXPORT_DIR') ?? './exports');
  for (const file of manifest.localExportFiles) {
    const absolute = resolve(file);
    const fromRoot = relative(exportRoot, absolute);
    const withinRoot =
      fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    if (!withinRoot) {
      throw new Error(`Refusing to delete code export outside CODE_EXPORT_DIR: ${file}`);
    }
    await unlink(absolute).then(
      () => localFilesDeleted++,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }
  return { objectsDeleted, videosDeleted, localFilesDeleted };
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function cleanupObjectKeys(
  keys: string[],
  storage: StorageService,
  config: ConfigService,
): Promise<number> {
  if (storage.name !== 'r2') {
    let deleted = 0;
    for (const key of keys) {
      const existed = await storage.exists(key);
      await storage.delete(key);
      if (existed && (await storage.exists(key))) {
        throw new Error(`Storage object still exists after deletion: ${key}`);
      }
      if (existed) deleted++;
    }
    return deleted;
  }

  const accountId = config.get<string>('R2_ACCOUNT_ID');
  const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
  const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
  const bucket = config.get<string>('R2_BUCKET');
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 is selected but its required configuration is incomplete.');
  }
  const client = new S3Client({
    region: config.get<string>('R2_REGION') ?? 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  let deleted = 0;
  for (const key of keys) {
    let exists = true;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) exists = false;
      else throw new Error(`R2 ownership/read verification failed for ${key}.`, { cause: error });
    }
    if (!exists) continue;
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      throw new Error(`R2 object still exists after deletion: ${key}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    deleted++;
  }
  client.destroy();
  return deleted;
}

export function redisOwnedPatterns(env: NodeJS.ProcessEnv): string[] {
  const prefix = namespacedPrefix((key) => env[key]);
  const bullPrefix = bullMqPrefix((key) => env[key]) ?? 'bull';
  return [
    `${prefix}learnix:cache:*`,
    `${prefix}cache-lock:*`,
    `${prefix}idempotency:*`,
    `${prefix}health-collector:*`,
    `${prefix}lb:*`,
    ...Object.values(QUEUE_NAMES).map((queue) => `${bullPrefix}:${queue}:*`),
  ];
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function redisInventory(
  redis: Redis,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const pattern of redisOwnedPatterns(env)) {
    result[pattern] = (await scanKeys(redis, pattern)).length;
  }
  return result;
}

async function cleanupRedis(redis: Redis, env: NodeJS.ProcessEnv): Promise<number> {
  const namespace = resolveRedisNamespace((key) => env[key]);
  if (namespace === '' && env['RESET_PRELAUNCH_REDIS_DEDICATED'] === 'true') {
    const size = await redis.dbsize();
    await redis.flushdb();
    return size;
  }
  const patterns = namespace === '' ? redisOwnedPatterns(env) : [`${namespace}:*`];
  const keys = [
    ...new Set((await Promise.all(patterns.map((pattern) => scanKeys(redis, pattern)))).flat()),
  ];
  for (let index = 0; index < keys.length; index += 500) {
    await redis.unlink(...keys.slice(index, index + 500));
  }
  return keys.length;
}

async function resetDatabase(
  dataSource: DataSource,
  classification: TableClassification,
  config: ConfigService,
): Promise<{ system: { rank_tiers: number; health_alert_rules: number }; admin: string }> {
  return await dataSource.transaction(async (manager: EntityManager) => {
    const resetTables = [...classification.application, ...classification.system];
    await manager.query(
      `TRUNCATE TABLE ${resetTables.map(quoteIdentifier).join(', ')} RESTART IDENTITY CASCADE`,
    );
    const system = await seedRequiredSystemData(manager);
    const adminService = new AdminInitializationService(config, dataSource);
    const admin = await adminService.initializeWithManager(manager);
    if (admin.outcome !== 'created') {
      throw new Error(`Admin recreation did not create a row (outcome: ${admin.outcome}).`);
    }
    return { system, admin: admin.outcome };
  });
}

async function orphanCount(dataSource: DataSource): Promise<number> {
  const foreignKeys = (await dataSource.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS parent_table,
           ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
  `)) as Array<{
    table_name: string;
    column_name: string;
    parent_table: string;
    parent_column: string;
  }>;
  let total = 0;
  for (const fk of foreignKeys) {
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(fk.table_name)} child
       LEFT JOIN ${quoteIdentifier(fk.parent_table)} parent
         ON child.${quoteIdentifier(fk.column_name)} = parent.${quoteIdentifier(fk.parent_column)}
       WHERE child.${quoteIdentifier(fk.column_name)} IS NOT NULL
         AND parent.${quoteIdentifier(fk.parent_column)} IS NULL`,
    )) as Array<{ count: number }>;
    total += Number(rows[0]?.count ?? 0);
  }
  return total;
}

interface QueueAudit {
  repeatableJobs: Record<string, number>;
  unexpectedJobs: number;
  counts: Record<string, Record<string, number>>;
}

async function auditQueues(env: NodeJS.ProcessEnv): Promise<QueueAudit | null> {
  const redisUrl = resolveRedisUrl((key) => env[key]);
  if (!redisUrl) return null;
  const prefix = bullMqPrefix((key) => env[key]);
  const options = { connection: { url: redisUrl }, ...(prefix ? { prefix } : {}) };
  const queues = Object.values(QUEUE_NAMES).map((name) => new Queue(name, options));
  try {
    const byName = new Map(queues.map((queue) => [queue.name, queue]));
    const exam = await byName.get(QUEUE_NAMES.EXAM_AUTO_SUBMIT)!.getRepeatableJobs();
    const game = await byName.get(QUEUE_NAMES.GAMIFICATION)!.getRepeatableJobs();
    const counts: Record<string, Record<string, number>> = {};
    let unexpectedJobs = 0;
    for (const queue of queues) {
      counts[queue.name] = await queue.getJobCounts(
        'wait',
        'active',
        'delayed',
        'failed',
        'paused',
        'prioritized',
        'completed',
      );
      const jobs = await queue.getJobs(
        ['wait', 'active', 'delayed', 'failed', 'paused', 'prioritized', 'completed'],
        0,
        1000,
      );
      unexpectedJobs += jobs.filter(
        (job) =>
          job.name !== JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP &&
          job.name !== JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP,
      ).length;
    }
    return {
      repeatableJobs: {
        [JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP]: exam.filter(
          (job) => job.name === JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP,
        ).length,
        [JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP]: game.filter(
          (job) => job.name === JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP,
        ).length,
      },
      unexpectedJobs,
      counts,
    };
  } finally {
    await Promise.all(queues.map(async (queue) => queue.close()));
  }
}

function createDataSource(databaseUrl: string): DataSource {
  const artifacts = typeOrmArtifactPaths(__filename.endsWith('.js'));
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    synchronize: false,
    logging: ['error'],
    ssl: resolveDatabaseSsl(databaseUrl),
  });
}

function printSection(label: string, value: unknown): void {
  process.stdout.write(`${label}: ${JSON.stringify(value, null, 2)}\n`);
}

export async function runPrelaunchReset(options: {
  dryRun: boolean;
  verify: boolean;
  skipExternal: boolean;
}): Promise<void> {
  const identity = databaseIdentity(process.env);
  printSection('Target', identity);
  const config = new ConfigService(process.env);
  const dataSource = createDataSource(process.env['DATABASE_URL'] ?? '');
  await dataSource.initialize();
  let redis: Redis | null = null;
  try {
    if (await dataSource.showMigrations()) {
      throw new UnsafePrelaunchResetError(
        'Pending migrations exist; apply them before resetting data.',
      );
    }
    const tables = await publicTables(dataSource);
    const classification = classifyTables(tables, entityTableNames(dataSource));
    printSection('Table classification', classification);
    if (classification.unknown.length > 0) {
      throw new UnsafePrelaunchResetError(
        `Unclassified tables exist: ${classification.unknown.join(', ')}. Audit them before execution.`,
      );
    }
    const countsBefore = await rowCounts(dataSource, tables);
    printSection('Row counts', countsBefore);

    const storage = new StorageService(config);
    const manifest = await collectStorageManifest(dataSource, storage, config);
    printSection('Storage manifest', {
      objects: manifest.objectKeys.length,
      bunnyVideos: manifest.bunnyVideoIds.length,
      localExports: manifest.localExportFiles.length,
      unresolvedReferences: manifest.unresolvedReferences,
    });

    const redisUrl = resolveRedisUrl((key) => process.env[key]);
    if (redisUrl) {
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      printSection('Redis owned-key inventory', await redisInventory(redis, process.env));
    }

    if (options.verify) {
      const queues = await auditQueues(process.env);
      printSection('Queue audit', queues);
      if (
        queues &&
        (queues.repeatableJobs[JOB_TYPES.EXAM.AUTO_SUBMIT_SWEEP] !== 1 ||
          queues.repeatableJobs[JOB_TYPES.GAMIFICATION.STREAK_RESET_SWEEP] !== 1 ||
          queues.unexpectedJobs !== 0)
      ) {
        throw new Error(
          'Queue verification failed: expected exactly one of each global repeatable job and no entity-targeting jobs.',
        );
      }
      printSection('Orphan rows', await orphanCount(dataSource));
      return;
    }
    if (options.dryRun) return;

    assertExecutionGuards(process.env, identity, options);
    if (manifest.unresolvedReferences.length > 0) {
      throw new UnsafePrelaunchResetError(
        `Storage ownership is unresolved for: ${manifest.unresolvedReferences.join(', ')}. Resolve these references before execution.`,
      );
    }
    if (!options.skipExternal) {
      const storageResult = await cleanupStorage(
        manifest,
        storage,
        new BunnyStreamService(config),
        config,
      );
      printSection('Storage cleanup', storageResult);
      if (!redis) throw new Error('Redis is configured as required but could not be connected.');
      printSection('Redis keys removed', await cleanupRedis(redis, process.env));
    }

    printSection('Database reset', await resetDatabase(dataSource, classification, config));
    const countsAfter = await rowCounts(dataSource, tables);
    printSection('Final row counts', countsAfter);
    printSection('Orphan rows', await orphanCount(dataSource));
    printSection('Migration count', countsAfter['migrations'] ?? 0);
    process.stdout.write(
      'Reset complete. Restart the application, then run this command with --verify to confirm both required repeatable jobs exist exactly once.\n',
    );
  } finally {
    redis?.disconnect();
    await dataSource.destroy();
  }
}
