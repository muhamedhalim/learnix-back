import * as ExcelJS from 'exceljs';

import { ExportContext, EXPORT_CHUNK } from './export-context';

/**
 * Stream matching codes to an .xlsx file using ExcelJS' streaming workbook
 * writer, which flushes rows to disk as they are committed instead of holding
 * the whole sheet in memory — safe for hundreds of thousands of rows.
 */
export async function exportExcel(filePath: string, ctx: ExportContext): Promise<number> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
  });
  const sheet = workbook.addWorksheet('Attendance Codes');

  sheet.columns = [
    { header: 'Code', key: 'code', width: 18 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Item ID', key: 'item_id', width: 38 },
    { header: 'Batch ID', key: 'batch_id', width: 38 },
    { header: 'Active', key: 'is_active', width: 10 },
    { header: 'Used At', key: 'used_at', width: 22 },
    { header: 'Expires At', key: 'expires_at', width: 22 },
    { header: 'Created At', key: 'created_at', width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();

  let written = 0;
  for (let offset = 0; offset < ctx.total; offset += EXPORT_CHUNK) {
    const rows = await ctx.fetchChunk(offset, EXPORT_CHUNK);
    if (rows.length === 0) break;

    for (const row of rows) {
      sheet
        .addRow({
          code: row.code,
          status: row.status,
          type: row.type,
          item_id: row.item_id,
          batch_id: row.batch_id ?? '',
          is_active: row.is_active ? 'yes' : 'no',
          used_at: row.used_at ? row.used_at.toISOString() : '',
          expires_at: row.expires_at.toISOString(),
          created_at: row.created_at.toISOString(),
        })
        .commit();
      written += 1;
    }
    ctx.onProgress?.(Math.round((written / ctx.total) * 100));
  }

  sheet.commit();
  await workbook.commit();
  return written;
}
