import { createWriteStream } from 'node:fs';

import { ExportContext, EXPORT_CHUNK } from './export-context';
import { endStream, writeBackpressured } from './stream.util';

const COLUMNS = [
  'code',
  'status',
  'type',
  'item_id',
  'batch_id',
  'is_active',
  'used_at',
  'expires_at',
  'created_at',
] as const;

/** RFC-4180 field escaping. */
function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return escapeCsv(String(value));
}

/** Stream matching codes to a CSV file, one bounded page at a time. */
export async function exportCsv(filePath: string, ctx: ExportContext): Promise<number> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  try {
    // UTF-8 BOM so Excel opens Arabic/Unicode content correctly.
    await writeBackpressured(stream, '﻿' + COLUMNS.join(',') + '\r\n');

    let written = 0;
    for (let offset = 0; offset < ctx.total; offset += EXPORT_CHUNK) {
      const rows = await ctx.fetchChunk(offset, EXPORT_CHUNK);
      if (rows.length === 0) break;

      let buffer = '';
      for (const row of rows) {
        buffer += COLUMNS.map((c) => toCell(row[c])).join(',') + '\r\n';
      }
      await writeBackpressured(stream, buffer);

      written += rows.length;
      ctx.onProgress?.(Math.round((written / ctx.total) * 100));
    }
    await endStream(stream);
    return written;
  } catch (err) {
    stream.destroy();
    throw err;
  }
}
