/**
 * One-off migration: copy existing local `/uploads` assets into Cloudflare R2,
 * preserving object keys (folder/filename) so they line up with the new
 * StorageService key scheme.
 *
 * Videos are NOT touched — they live on Bunny Stream, never on local disk.
 *
 * Usage (from learning-center-backend/):
 *   npx ts-node scripts/migrate-uploads-to-r2.ts [--dry-run]
 *
 * Requires the R2_* env vars (same ones StorageService uses). After copying,
 * decide how to reconcile existing DB URLs:
 *   - If DB stores full `${BACKEND_URL}/api/v1/uploads/...` URLs, run a follow-up
 *     SQL/data pass to rewrite them to `${R2_PUBLIC_BASE_URL}/<key>` (public
 *     assets) — keys are identical, only the host changes.
 *   - Paid book PDFs should additionally be re-uploaded with private visibility
 *     and their `book_file` set to the bare key (see report).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const DRY_RUN = process.argv.includes('--dry-run');

/** Minimal extension → content-type map (avoids an external mime dependency). */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  const uploadDir = process.env['UPLOAD_DIR'] ?? './uploads';
  const bucket = requireEnv('R2_BUCKET');
  const accountId = requireEnv('R2_ACCOUNT_ID');

  const s3 = new S3Client({
    region: process.env['R2_REGION'] || 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });

  try {
    await stat(uploadDir);
  } catch {
    console.log(`No local upload dir at ${uploadDir} — nothing to migrate.`);
    return;
  }

  let migrated = 0;
  let failed = 0;

  for await (const filePath of walk(uploadDir)) {
    // Object key = path relative to uploadDir, POSIX-normalized.
    const key = relative(uploadDir, filePath).split(sep).join('/');
    const contentType = contentTypeFor(filePath);

    if (DRY_RUN) {
      console.log(`[dry-run] would upload ${key} (${contentType})`);
      migrated++;
      continue;
    }

    try {
      const body = await readFile(filePath);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      migrated++;
      console.log(`✓ ${key}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${key}: ${(err as Error).message}`);
    }
  }

  console.log(
    `\nMigration ${DRY_RUN ? '(dry run) ' : ''}complete: ${migrated} object(s), ${failed} failure(s).`,
  );
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
