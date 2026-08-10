import { Injectable } from '@nestjs/common';

import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

import { containsArabic, shapeArabicForPdf } from '../../certificates/arabic-pdf-text.util';
import type { LocalizedText } from '../entities/content.types';
import type { ExamQuestion } from '../entities/exam-question.entity';
import type { OmrTemplateLayout } from '../entities/omr-template.types';
import { QuestionType } from '../entities/question-type.enum';
import { PAGE_MARGIN_MM, LABEL_COLUMN_WIDTH_MM } from '../omr-recognition/constants';
import { encodeSheetQrPayload } from '../omr-recognition/qr.util';

const ARABIC_FONT_REGULAR = require.resolve('noto-sans-arabic/fonts/Regular.ttf');
const ARABIC_FONT_BOLD = require.resolve('noto-sans-arabic/fonts/Bold.ttf');

const MM_TO_PT = 72 / 25.4;
function mm(value: number): number {
  return value * MM_TO_PT;
}

export interface OmrSheetPdfInput {
  sheetId: string;
  template: OmrTemplateLayout;
  examTitle: LocalizedText;
  studentName: string;
  /** Only the OMR-eligible questions the template actually lays out, any order. */
  examQuestions: readonly ExamQuestion[];
  locale: 'en' | 'ar';
}

interface QuestionContentShape {
  prompt?: LocalizedText;
  options?: { id: string; text: LocalizedText }[];
}

/**
 * Renders a generated OMR template as a printable PDF: a plain-text "question
 * paper" (the student reads this) followed by a single geometrically precise
 * "answer sheet" page carrying the fiducial markers, identity QR, and bubble
 * grid — the ONLY page the recognizer ever processes. Coordinates are
 * converted straight from `OmrTemplateLayout`'s millimetre space, so the
 * printed geometry and the recognizer's expected geometry can never drift
 * apart (single source of truth: `template-layout.util.ts`).
 */
@Injectable()
export class OmrSheetPdfService {
  public async render(input: OmrSheetPdfInput): Promise<Buffer> {
    const { template, locale } = input;
    const isArabic = locale === 'ar';
    const contentById = new Map(input.examQuestions.map((eq) => [eq.id, eq]));

    // Document-level default margin serves the (possibly auto-paginating,
    // multi-page) question paper — pdfkit's automatic page breaks during text
    // overflow use this constructor default, not a later page's own override,
    // so the answer-sheet page below must override it explicitly instead.
    const doc = new PDFDocument({ size: 'A4', margin: mm(18), autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      doc.on('end', () => resolve());
      doc.on('error', (err: Error) => reject(err));
    });

    doc.registerFont('Latin', 'Helvetica');
    doc.registerFont('Latin-Bold', 'Helvetica-Bold');
    doc.registerFont('Body', isArabic ? ARABIC_FONT_REGULAR : 'Helvetica');
    doc.registerFont('Body-Bold', isArabic ? ARABIC_FONT_BOLD : 'Helvetica-Bold');
    const align = isArabic ? 'right' : 'left';
    const localize = (text: LocalizedText): string => (isArabic && text.ar ? text.ar : text.en);
    const render = (text: string): string =>
      containsArabic(text) ? shapeArabicForPdf(text) : text;

    this.drawQuestionPaper(doc, input, contentById, align, localize, render);

    doc.addPage({ size: 'A4', margin: 0 });
    this.drawAnswerSheet(doc, input, align, localize, render);

    const qrBuffer = await QRCode.toBuffer(encodeSheetQrPayload(input.sheetId), {
      errorCorrectionLevel: 'M',
      margin: 0,
      width: 512,
      type: 'png',
    });
    doc.image(qrBuffer, mm(template.qr.x), mm(template.qr.y), {
      width: mm(template.qr.sizeMm),
      height: mm(template.qr.sizeMm),
    });

    doc.end();
    await done;
    return Buffer.concat(chunks);
  }

  private drawQuestionPaper(
    doc: PDFKit.PDFDocument,
    input: OmrSheetPdfInput,
    contentById: Map<string, ExamQuestion>,
    align: 'left' | 'right',
    localize: (t: LocalizedText) => string,
    render: (s: string) => string,
  ): void {
    doc.addPage();
    const width = doc.page.width - mm(36);

    doc
      .font('Body-Bold')
      .fontSize(16)
      .text(render(localize(input.examTitle)), { width, align });
    doc.moveDown(0.3);
    doc
      .font('Body')
      .fontSize(11)
      .text(render(`${input.locale === 'ar' ? 'الطالب' : 'Student'}: ${input.studentName}`), {
        width,
        align,
      });
    doc.moveDown(1);

    const ordered = [...input.template.questions].sort((a, b) => a.label - b.label);
    for (const question of ordered) {
      const eq = contentById.get(question.examQuestionId);
      const content = (eq?.content_snapshot ?? {}) as QuestionContentShape;
      const prompt = content.prompt ? localize(content.prompt) : '';

      doc
        .font('Body-Bold')
        .fontSize(11)
        .text(render(`${String(question.label)}. ${prompt}`), {
          width,
          align,
        });

      if (question.type === QuestionType.TRUE_FALSE) {
        const label = input.locale === 'ar' ? 'صواب / خطأ' : 'True / False';
        doc
          .font('Body')
          .fontSize(10)
          .text(render(label), { width, align, indent: mm(6) });
      } else if (content.options) {
        for (const option of content.options) {
          doc
            .font('Body')
            .fontSize(10)
            .text(render(`${option.id}) ${localize(option.text)}`), {
              width,
              align,
              indent: mm(6),
            });
        }
      }
      doc.moveDown(0.6);
    }
  }

  private drawAnswerSheet(
    doc: PDFKit.PDFDocument,
    input: OmrSheetPdfInput,
    align: 'left' | 'right',
    localize: (t: LocalizedText) => string,
    render: (s: string) => string,
  ): void {
    const { template } = input;

    // Fiducial markers — solid black squares, corners the recognizer searches for.
    doc.fillColor('#000000');
    for (const marker of Object.values(template.markers)) {
      const half = marker.sizeMm / 2;
      doc
        .rect(mm(marker.x - half), mm(marker.y - half), mm(marker.sizeMm), mm(marker.sizeMm))
        .fill();
    }

    // Header text (kept clear of the marker row and the QR, drawn separately by `render()`).
    const headerWidth = template.pageWidthMm - 2 * 18;
    doc
      .fillColor('#000000')
      .font('Body-Bold')
      .fontSize(13)
      .text(
        render(localize(input.examTitle)),
        mm(18),
        mm(template.markers.topLeft.y + template.markers.topLeft.sizeMm),
        {
          width: mm(headerWidth),
          align,
        },
      );
    doc
      .font('Body')
      .fontSize(10)
      .text(render(`${input.locale === 'ar' ? 'الطالب' : 'Student'}: ${input.studentName}`), {
        width: mm(headerWidth),
        align,
      });

    // Answer-sheet instructions (kept short — the label column sits at the page margin).
    doc.fontSize(9).fillColor('#444444');

    for (const question of template.questions) {
      const rowY = question.bubbles[0]!.y;
      doc
        .fillColor('#000000')
        .font('Body-Bold')
        .fontSize(10)
        .text(String(question.label), mm(PAGE_MARGIN_MM), mm(rowY - 3), {
          width: mm(LABEL_COLUMN_WIDTH_MM - 2),
          align: 'right',
        });

      question.bubbles.forEach((bubble, i) => {
        doc
          .lineWidth(0.8)
          .strokeColor('#000000')
          .circle(mm(bubble.x), mm(bubble.y), mm(template.bubbleRadiusMm))
          .stroke();
        const optionLabel =
          bubble.kind === 'boolean' ? (bubble.value ? 'T' : 'F') : String.fromCharCode(65 + i); // A, B, C, … — cosmetic only, printed from array position
        doc
          .font('Body')
          .fontSize(6.5)
          .fillColor('#666666')
          .text(optionLabel, mm(bubble.x - 4), mm(bubble.y + template.bubbleRadiusMm + 0.8), {
            width: mm(8),
            align: 'center',
          });
      });
    }
  }
}
