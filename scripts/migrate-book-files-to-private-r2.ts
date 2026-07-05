/**
 * Legacy Book PDF migration → private Cloudflare R2.
 *
 * Moves every Book whose `book_file` is a legacy reference (local `/uploads/...`,
 * an old backend URL, or an old PUBLIC R2/CDN URL, or any bare key not already
 * under `books/`) into a PRIVATE `books/<uuid>.pdf` object, then rewrites the DB
 * value to the private key. After this runs, no public book URL remains in the
 * database.
 *
 * Safety / correctness:
 *  - Idempotent + resumable: rows already stored as a private `books/` key are
 *    skipped, so re-running continues where it left off.
 *  - Fail-safe: the DB value is only updated AFTER the new object is uploaded
 *    AND verified to exist in R2. A failed row leaves the original untouched.
 *  - Rollback: every change is appended to book-migration-rollback.json
 *    ({ bookId, old, new }); pass --rollback to restore from it.
 *  - Duplicate detection: identical source values are migrated once and reused.
 *  - --dry-run: report only, no upload / no DB write.
 *  - --cleanup: after successful verification, delete the old orphaned object
 *    (local file or old PUBLIC R2 object). Off by default to preserve rollback.
 *
 * Usage (from learning-center-backend/):
 *   npx ts-node scripts/migrate-book-files-to-private-r2.ts [--dry-run] [--cleanup]
 *   npx ts-node scripts/migrate-book-files-to-private-r2.ts --rollback
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { Book } from '../src/books/entities/book.entity';
import { StorageService } from '../src/storage/storage.service';
import { DataSource } from 'typeorm';

const DRY_RUN = process.argv.includes('--dry-run');
const CLEANUP = process.argv.includes('--cleanup');
const ROLLBACK = process.argv.includes('--rollback');
const ROLLBACK_FILE = join(process.cwd(), 'book-migration-rollback.json');

interface RollbackEntry {
  bookId: string;
  old: string;
  new: string;
}

/** A value is already migrated iff it is a bare key under `books/`. */
function isMigrated(value: string): boolean {
  return !/^https?:\/\//i.test(value) && value.startsWith('books/');
}

/** Load the bytes for a legacy reference (remote URL or local uploads path). */
async function loadBytes(
  value: string,
  storage: StorageService,
): Promise<Buffer | null> {
  // Remote URL (old backend URL or public R2/CDN URL).
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  const uploadDir = process.env['UPLOAD_DIR'] ?? './uploads';
  const key = storage.toKey(value); // strips /uploads or /api/v1/uploads prefix

  // Try local disk first (legacy local uploads).
  const localPath = join(uploadDir, key);
  if (existsSync(localPath)) {
    return readFile(localPath);
  }

  // Otherwise assume it is an existing (public) R2 object → fetch via public URL.
  try {
    const res = await fetch(storage.getPublicUrl(key));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function runMigration(
  dataSource: DataSource,
  storage: StorageService,
): Promise<void> {
  const repo = dataSource.getRepository(Book);
  const books = await repo.find({ withDeleted: true });

  const report = {
    total: books.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    duplicate: 0,
    missing: 0,
  };
  const rollback: RollbackEntry[] = [];
  const sourceToKey = new Map<string, string>(); // duplicate detection

  for (const book of books) {
    const value = book.book_file ?? '';

    if (value === '' || isMigrated(value)) {
      report.skipped++;
      continue;
    }

    // Duplicate source → reuse the already-migrated key.
    const existingKey = sourceToKey.get(value);
    if (existingKey) {
      report.duplicate++;
      if (!DRY_RUN) {
        await repo.update(book.id, { book_file: existingKey });
        rollback.push({ bookId: book.id, old: value, new: existingKey });
      }
      console.log(`~ dup  ${book.id}: reused ${existingKey}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] would migrate ${book.id}: ${value}`);
      report.migrated++;
      sourceToKey.set(value, `books/<pending>`);
      continue;
    }

    try {
      const bytes = await loadBytes(value, storage);
      if (!bytes) {
        report.missing++;
        console.error(`✗ missing source for ${book.id}: ${value}`);
        continue;
      }

      const newKey = `books/${randomUUID()}.pdf`;
      await storage.upload({
        buffer: bytes,
        path: newKey,
        contentType: 'application/pdf',
        visibility: 'private',
      });

      // Verify BEFORE touching the DB — fail-safe.
      const ok = await storage.exists(newKey);
      if (!ok) {
        report.failed++;
        console.error(`✗ verify failed for ${book.id} (${newKey})`);
        continue;
      }

      await repo.update(book.id, { book_file: newKey });
      rollback.push({ bookId: book.id, old: value, new: newKey });
      sourceToKey.set(value, newKey);
      report.migrated++;
      console.log(`✓ ${book.id}: ${value} → ${newKey}`);

      // Optional cleanup of the orphaned legacy object (after verification).
      if (CLEANUP) {
        const oldKey = storage.toKey(value);
        const localPath = join(process.env['UPLOAD_DIR'] ?? './uploads', oldKey);
        if (existsSync(localPath)) {
          await unlink(localPath).catch(() => undefined);
        } else if (!/^https?:\/\//i.test(value) || value.includes('r2')) {
          await storage.tryDelete(oldKey);
        }
      }
    } catch (err) {
      report.failed++;
      console.error(`✗ ${book.id}: ${(err as Error).message}`);
    }
  }

  if (!DRY_RUN && rollback.length > 0) {
    const prior: RollbackEntry[] = existsSync(ROLLBACK_FILE)
      ? (JSON.parse(readFileSync(ROLLBACK_FILE, 'utf8')) as RollbackEntry[])
      : [];
    await writeFile(
      ROLLBACK_FILE,
      JSON.stringify([...prior, ...rollback], null, 2),
    );
    console.log(`\nRollback map written to ${ROLLBACK_FILE}`);
  }

  console.log(
    `\nMigration ${DRY_RUN ? '(dry run) ' : ''}report:` +
      `\n  total:     ${report.total}` +
      `\n  migrated:  ${report.migrated}` +
      `\n  skipped:   ${report.skipped}` +
      `\n  duplicate: ${report.duplicate}` +
      `\n  missing:   ${report.missing}` +
      `\n  failed:    ${report.failed}`,
  );
}

async function runRollback(dataSource: DataSource): Promise<void> {
  if (!existsSync(ROLLBACK_FILE)) {
    console.log('No rollback file found — nothing to restore.');
    return;
  }
  const entries = JSON.parse(
    readFileSync(ROLLBACK_FILE, 'utf8'),
  ) as RollbackEntry[];
  const repo = dataSource.getRepository(Book);
  let restored = 0;
  // Restore in reverse so the earliest original value wins for duplicates.
  for (const e of [...entries].reverse()) {
    await repo.update(e.bookId, { book_file: e.old });
    restored++;
  }
  console.log(`Rolled back ${restored} book(s) to their original book_file.`);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const dataSource = app.get(DataSource);
    const storage = app.get(StorageService);
    if (ROLLBACK) {
      await runRollback(dataSource);
    } else {
      await runMigration(dataSource, storage);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('Book migration failed:', err);
  process.exitCode = 1;
});
