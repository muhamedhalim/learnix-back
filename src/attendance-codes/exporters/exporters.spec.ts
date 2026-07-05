import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PdfLayout } from '../entities/pdf-layout.enum';
import { exportCsv } from './csv.exporter';
import { ExportableCode, ExportContext } from './export-context';
import { exportExcel } from './excel.exporter';
import { exportJson } from './json.exporter';
import { exportPdf } from './pdf.exporter';
import { buildQrPayload, generateQrPngBuffer } from './qr.util';

/** Build an in-memory export context over a fixed set of rows (no DB). */
function makeContext(rows: ExportableCode[]): {
  ctx: ExportContext;
  progress: number[];
} {
  const progress: number[] = [];
  const ctx: ExportContext = {
    total: rows.length,
    fetchChunk: (offset, limit) =>
      Promise.resolve(rows.slice(offset, offset + limit)),
    onProgress: (p) => progress.push(p),
  };
  return { ctx, progress };
}

function sampleRows(n: number): ExportableCode[] {
  return Array.from({ length: n }, (_, i) => ({
    code: `CODE${String(i).padStart(4, '0')}`,
    status: 'unused',
    type: 'lesson',
    item_id: '11111111-1111-1111-1111-111111111111',
    batch_id: '22222222-2222-2222-2222-222222222222',
    is_active: true,
    used_at: null,
    expires_at: new Date('2030-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
  }));
}

describe('attendance-code exporters', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'code-exports-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('QR util', () => {
    it('encodes the raw code when no base URL is given', () => {
      expect(buildQrPayload('ABC123')).toBe('ABC123');
    });

    it('encodes a redeem URL when a base URL is given', () => {
      expect(buildQrPayload('ABC123', 'https://x.io/redeem')).toBe(
        'https://x.io/redeem?code=ABC123',
      );
      expect(buildQrPayload('ABC123', 'https://x.io/r?a=1')).toBe(
        'https://x.io/r?a=1&code=ABC123',
      );
    });

    it('produces a valid PNG buffer', async () => {
      const png = await generateQrPngBuffer('ABC123');
      // PNG magic number.
      expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
      expect(png.length).toBeGreaterThan(100);
    });
  });

  describe('CSV export', () => {
    it('writes a BOM, header and one row per code', async () => {
      const { ctx, progress } = makeContext(sampleRows(3));
      const file = join(dir, 'out.csv');
      const written = await exportCsv(file, ctx);

      expect(written).toBe(3);
      const content = readFileSync(file, 'utf8');
      expect(content.charCodeAt(0)).toBe(0xfeff); // BOM
      const lines = content.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines).toHaveLength(4); // header + 3
      expect(lines[0]).toContain('code');
      expect(lines[1]).toContain('CODE0000');
      expect(progress[progress.length - 1]).toBe(100);
    });

    it('escapes fields containing commas or quotes', async () => {
      const rows = sampleRows(1);
      rows[0]!.code = 'A,"B"';
      const { ctx } = makeContext(rows);
      const file = join(dir, 'esc.csv');
      await exportCsv(file, ctx);
      const content = readFileSync(file, 'utf8');
      expect(content).toContain('"A,""B"""');
    });
  });

  describe('JSON export', () => {
    it('writes a valid, parseable JSON array', async () => {
      const { ctx } = makeContext(sampleRows(5));
      const file = join(dir, 'out.json');
      const written = await exportJson(file, ctx);

      expect(written).toBe(5);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5);
    });

    it('writes an empty array for no rows', async () => {
      const { ctx } = makeContext([]);
      const file = join(dir, 'empty.json');
      await exportJson(file, ctx);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
    });
  });

  describe('Excel export', () => {
    it('produces a non-empty .xlsx (ZIP) file', async () => {
      const { ctx } = makeContext(sampleRows(10));
      const file = join(dir, 'out.xlsx');
      const written = await exportExcel(file, ctx);

      expect(written).toBe(10);
      const buf = readFileSync(file);
      // XLSX is a ZIP container: 'PK' signature.
      expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    });
  });

  describe('PDF export', () => {
    it.each([
      PdfLayout.A4_GRID,
      PdfLayout.LABELS,
      PdfLayout.CARDS,
      PdfLayout.QR_SHEET,
    ])(
      'produces a valid PDF for the %s layout',
      async (layout) => {
        const { ctx } = makeContext(sampleRows(3));
        const file = join(dir, `out-${layout}.pdf`);
        const written = await exportPdf(file, layout, ctx);

        expect(written).toBe(3);
        const buf = readFileSync(file);
        expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      },
      30_000,
    );

    it(
      'paginates when rows exceed one page (QR sheet = 12/page)',
      async () => {
        const { ctx } = makeContext(sampleRows(15));
        const file = join(dir, 'multi.pdf');
        const written = await exportPdf(file, PdfLayout.QR_SHEET, ctx);
        expect(written).toBe(15);
        expect(readFileSync(file).subarray(0, 5).toString('ascii')).toBe(
          '%PDF-',
        );
      },
      30_000,
    );
  });
});
