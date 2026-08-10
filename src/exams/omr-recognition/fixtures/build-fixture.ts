import sharp from 'sharp';
import * as QRCode from 'qrcode';

import type { ExamQuestion } from '../../entities/exam-question.entity';
import type { OmrTemplateLayout } from '../../entities/omr-template.types';
import { QuestionType } from '../../entities/question-type.enum';
import { generateOmrTemplateLayout } from '../template-layout.util';
import { encodeSheetQrPayload } from '../qr.util';

/**
 * Deterministic, programmatically-generated OMR fixtures — no real scanned
 * photos involved. Renders the exact same answer-sheet geometry the PDF
 * service prints (via the SAME `generateOmrTemplateLayout`), then composites
 * synthetic "ink" at chosen bubble positions using sharp's native SVG
 * rasterization (no extra dependency). Used by both unit tests and the e2e
 * suite — one generator, reused everywhere, so a fixture can never silently
 * drift from what the real pipeline produces/expects.
 */

export interface FixtureQuestionSpec {
  id: string;
  type: QuestionType.SINGLE_CHOICE | QuestionType.TRUE_FALSE | QuestionType.MULTIPLE_SELECT;
  /** single_choice / multiple_select only — default 4. */
  optionCount?: number;
}

export function buildFixtureExamQuestions(specs: readonly FixtureQuestionSpec[]): ExamQuestion[] {
  return specs.map((spec, index) => {
    const content =
      spec.type === QuestionType.TRUE_FALSE
        ? { prompt: { en: `Question ${String(index + 1)}` } }
        : {
            prompt: { en: `Question ${String(index + 1)}` },
            options: Array.from({ length: spec.optionCount ?? 4 }, (_, i) => ({
              id: `opt_${String(i)}`,
              text: { en: String.fromCharCode(65 + i) },
            })),
          };
    return {
      id: spec.id,
      order_index: index,
      type_snapshot: spec.type,
      content_snapshot: content,
    } as unknown as ExamQuestion;
  });
}

export function buildFixtureTemplate(specs: readonly FixtureQuestionSpec[]): OmrTemplateLayout {
  return generateOmrTemplateLayout(buildFixtureExamQuestions(specs));
}

export interface RenderFixtureOptions {
  sheetId: string;
  template: OmrTemplateLayout;
  /** examQuestionId -> bubble indices to mark. A question with no entry is rendered blank. */
  marks?: Record<string, number[]>;
  /** Render resolution — 200 DPI approximates a decent phone-camera scan. */
  dpi?: number;
  /** Simulated ink opacity 0..1 — a low value renders a faint mark (a merely-gray circle still samples as "no ink" under the dark-pixel threshold, same as a genuinely blank bubble). */
  inkOpacity?: number;
  /** Ink circle radius as a fraction of the bubble radius (default 0.72) — a SMALL value (e.g. 0.35) is what actually produces a partial/ambiguous fill ratio, simulating a light or incomplete pencil mark. */
  inkRadiusFactor?: number;
  /** Omit the identity QR entirely (tests the "QR not found" path). */
  skipQr?: boolean;
  /** Encode a DIFFERENT sheet id than `sheetId` in the QR (tests the mismatch-rejection path). */
  qrSheetIdOverride?: string;
}

export async function renderFixtureSheet(opts: RenderFixtureOptions): Promise<Buffer> {
  const dpi = opts.dpi ?? 200;
  const scale = dpi / 25.4; // px per mm
  const { template } = opts;
  const px = (mm: number): number => mm * scale;
  const width = Math.round(px(template.pageWidthMm));
  const height = Math.round(px(template.pageHeightMm));

  const svg: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">`,
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="white"/>`,
  ];

  for (const marker of Object.values(template.markers)) {
    const half = px(marker.sizeMm) / 2;
    svg.push(
      `<rect x="${String(px(marker.x) - half)}" y="${String(px(marker.y) - half)}" ` +
        `width="${String(px(marker.sizeMm))}" height="${String(px(marker.sizeMm))}" fill="black"/>`,
    );
  }

  const inkOpacity = opts.inkOpacity ?? 1;
  const inkRadiusFactor = opts.inkRadiusFactor ?? 0.72;
  const strokeWidth = Math.max(1, scale * 0.3);
  for (const question of template.questions) {
    const marked = new Set(opts.marks?.[question.examQuestionId] ?? []);
    question.bubbles.forEach((bubble, i) => {
      const r = px(template.bubbleRadiusMm);
      svg.push(
        `<circle cx="${String(px(bubble.x))}" cy="${String(px(bubble.y))}" r="${String(r)}" ` +
          `fill="none" stroke="black" stroke-width="${String(strokeWidth)}"/>`,
      );
      if (marked.has(i)) {
        svg.push(
          `<circle cx="${String(px(bubble.x))}" cy="${String(px(bubble.y))}" r="${String(r * inkRadiusFactor)}" ` +
            `fill="black" fill-opacity="${String(inkOpacity)}"/>`,
        );
      }
    });
  }
  svg.push('</svg>');

  let image = sharp(Buffer.from(svg.join('')));

  if (!opts.skipQr) {
    const qrSizePx = Math.round(px(template.qr.sizeMm));
    const qrBuffer = await QRCode.toBuffer(
      encodeSheetQrPayload(opts.qrSheetIdOverride ?? opts.sheetId),
      {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: qrSizePx,
        type: 'png',
      },
    );
    image = image.composite([
      { input: qrBuffer, left: Math.round(px(template.qr.x)), top: Math.round(px(template.qr.y)) },
    ]);
  }

  return image.png().toBuffer();
}

export async function rotateFixture(buffer: Buffer, degrees: 90 | 180 | 270): Promise<Buffer> {
  return sharp(buffer).rotate(degrees).png().toBuffer();
}

/**
 * Mild affine shear as a stand-in for "reasonable perspective distortion" —
 * homography (a superset of affine transforms) should still recover the
 * sheet's geometry correctly through this.
 */
export async function shearFixture(buffer: Buffer, factor = 0.06): Promise<Buffer> {
  return sharp(buffer).affine([1, factor, 0, 1], { background: '#ffffff' }).png().toBuffer();
}
