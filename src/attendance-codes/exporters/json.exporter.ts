import { createWriteStream } from 'node:fs';

import { ExportContext, EXPORT_CHUNK } from './export-context';
import { endStream, writeBackpressured } from './stream.util';

/**
 * Stream matching codes to a JSON array without building the whole array in
 * memory: brackets and separators are written incrementally around each page.
 */
export async function exportJson(filePath: string, ctx: ExportContext): Promise<number> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  try {
    await writeBackpressured(stream, '[');

    let written = 0;
    for (let offset = 0; offset < ctx.total; offset += EXPORT_CHUNK) {
      const rows = await ctx.fetchChunk(offset, EXPORT_CHUNK);
      if (rows.length === 0) break;

      let buffer = '';
      for (const row of rows) {
        buffer += (written === 0 ? '' : ',') + JSON.stringify(row);
        written += 1;
      }
      await writeBackpressured(stream, buffer);
      ctx.onProgress?.(Math.round((written / ctx.total) * 100));
    }

    await writeBackpressured(stream, ']');
    await endStream(stream);
    return written;
  } catch (err) {
    stream.destroy();
    throw err;
  }
}
