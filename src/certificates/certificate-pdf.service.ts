import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

import {
  buildAbsoluteUrl,
  getConfiguredPublicOrigin,
} from '../config/public-url.util';
import { shapeArabicForPdf } from './arabic-pdf-text.util';
import type { CertificateTemplateSnapshot } from './entities/certificate.entity';
import { Certificate } from './entities/certificate.entity';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';

/** Sensible defaults used when no template row exists. */
const DEFAULT_TEMPLATE = {
  title: 'Certificate of Completion',
  title_ar: 'شهادة إتمام',
  body: 'This is proudly presented to {{student}} for successfully completing {{course}}.',
  body_ar: 'يُقدَّم هذا التكريم بفخر إلى {{student}} لإتمامه {{course}} بنجاح.',
  signature_name: null as string | null,
  signature_title: null as string | null,
  signature_title_ar: null as string | null,
  accent_color: '#6d28d9',
  layout: 'classic' as const,
  font: 'sans' as const,
  title_font_size: 34,
  body_font_size: 16,
  text_alignment: 'center' as const,
};

const LEARNIX_QUOTE = {
  [PreferredLanguage.EN]:
    'At Learnix, we believe every achievement is a step toward a brighter future. Keep learning, growing, and moving forward.',
  [PreferredLanguage.AR]:
    'في Learnix، نؤمن بأن كل إنجاز هو خطوة نحو مستقبل أكثر إشراقاً. واصل التعلّم والتقدّم.',
};

/**
 * Static UI copy around the template-driven content, in both languages.
 *
 * `certNumber`/`verifyAt` split their translated label from the Latin/
 * numeric value — the bundled Arabic font (see ARABIC_FONT_REGULAR) has no
 * Latin, digit, or punctuation glyphs at all, so genuinely Latin-only
 * content (a code, a URL) must be drawn with a different (Helvetica) font
 * than its Arabic label.
 *
 * `issued` stays a single combined string instead: a localized date (e.g.
 * `toLocaleDateString('ar-EG', …)`) mixes an Arabic month name with digits,
 * so it is NOT safe to hand to the Latin-only font — it's rendered as one
 * shaped Arabic string using Arabic-Indic digits instead.
 */
const UI_STRINGS = {
  [PreferredLanguage.EN]: {
    certifies: 'This certifies that',
    issued: (date: string) => `Issued: ${date}`,
    certNumber: (n: string) => ({ label: 'Certificate No. ', value: n }),
    verifyAt: (url: string) => ({ label: 'Verify at ', value: url }),
  },
  [PreferredLanguage.AR]: {
    certifies: 'تشهد هذه الوثيقة بأن',
    issued: (date: string) => `تاريخ الإصدار: ${date}`,
    certNumber: (n: string) => ({ label: 'رقم الشهادة: ', value: n }),
    verifyAt: (url: string) => ({ label: 'للتحقق: ', value: url }),
  },
};

const ARABIC_FONT_REGULAR = require.resolve('noto-sans-arabic/fonts/Regular.ttf');
const ARABIC_FONT_BOLD = require.resolve('noto-sans-arabic/fonts/Bold.ttf');

@Injectable()
export class CertificatePdfService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Render a certificate to a PDF buffer. Deterministic from the certificate +
   * template data + locale, so it can be produced on demand (no stored file
   * needed).
   */
  public async render(
    certificate: Certificate,
    // A live template or an issue-time snapshot — both carry the same design
    // fields; the renderer never needs ids/timestamps.
    template: CertificateTemplateSnapshot | null,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    const isArabic = locale === PreferredLanguage.AR;
    const tpl = template ?? DEFAULT_TEMPLATE;
    const ui = UI_STRINGS[isArabic ? PreferredLanguage.AR : PreferredLanguage.EN];
    const accent = this.safeColor(tpl.accent_color);
    const alignment = tpl.text_alignment === 'left' || tpl.text_alignment === 'right'
      ? tpl.text_alignment
      : 'center';
    const titleSize = this.clamp(tpl.title_font_size, 24, 54, DEFAULT_TEMPLATE.title_font_size);
    const bodySize = this.clamp(tpl.body_font_size, 12, 24, DEFAULT_TEMPLATE.body_font_size);

    const verifyUrl = this.verificationUrl(certificate.verification_code);
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      margin: 0,
      width: 120,
    });
    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1] ?? '', 'base64');

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
    });

    // PDFKit's built-in "standard 14" fonts (Helvetica, …) have no Arabic
    // glyphs at all, and PDFKit performs no Arabic contextual shaping or
    // bidi reordering on its own — both are handled ahead of time by
    // shapeArabicForPdf() before any Arabic string reaches doc.text().
    const serif = tpl.font === 'serif' && !isArabic;
    doc.registerFont('Body', isArabic ? ARABIC_FONT_REGULAR : serif ? 'Times-Roman' : 'Helvetica');
    doc.registerFont('Body-Bold', isArabic ? ARABIC_FONT_BOLD : serif ? 'Times-Bold' : 'Helvetica-Bold');

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const width = doc.page.width;
    const height = doc.page.height;
    const rtlText = (text: string): string => (isArabic ? shapeArabicForPdf(text) : text);

    // Background + fixed, pre-configured layout treatments.
    doc.rect(0, 0, width, height).fill(tpl.layout === 'modern' ? '#f8fafc' : '#ffffff');
    if (tpl.layout !== 'minimal') {
      doc
        .lineWidth(tpl.layout === 'modern' ? 10 : 6)
        .strokeColor(accent)
        .rect(24, 24, width - 48, height - 48)
        .stroke();
    }
    if (tpl.layout === 'classic') {
      doc
        .lineWidth(1)
        .strokeColor(accent)
        .rect(36, 36, width - 72, height - 72)
        .stroke();
    }

    // Platform branding and verification are renderer-owned, never template fields.
    const logo = this.readLogo();
    doc.image(logo, width / 2 - 34, 48, { fit: [68, 44] });
    doc.fillColor(accent).font('Body-Bold').fontSize(16).text('Learnix', 0, 52, { align: 'center' });

    // Title.
    const title = isArabic ? tpl.title_ar || tpl.title : tpl.title;
    doc
      .fillColor(accent)
      .font('Body-Bold')
      .fontSize(titleSize)
      .text(rtlText(isArabic ? title : title.toUpperCase()), 0, 105, { align: alignment });

    // Body with placeholders replaced. The formatted date always mixes a
    // (possibly Arabic) month name with digits, so it is rendered as a
    // single localized string through the same font as its surrounding
    // Arabic text rather than split like the purely-Latin cert number/URL.
    const issuedDate = certificate.issued_at.toLocaleDateString(isArabic ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const bodyTemplate = isArabic ? tpl.body_ar || tpl.body : tpl.body;
    const body = bodyTemplate
      .replace(/\{\{\s*student\s*\}\}/gi, certificate.student_name)
      .replace(/\{\{\s*course\s*\}\}/gi, certificate.course_title)
      .replace(/\{\{\s*date\s*\}\}/gi, issuedDate);

    doc
      .fillColor('#111827')
      .font('Body')
      .fontSize(bodySize)
      .text(rtlText(ui.certifies), 0, 182, { align: alignment });

    doc
      .fillColor('#111827')
      .font('Body-Bold')
      .fontSize(30)
      .text(rtlText(certificate.student_name), 0, 212, { align: alignment });

    doc
      .fillColor('#374151')
      .font('Body')
      .fontSize(bodySize)
      .text(rtlText(body), width * 0.15, 262, {
        align: alignment,
        width: width * 0.7,
      });

    if (certificate.teacher_name) {
      doc
        .fillColor('#4b5563')
        .font('Body')
        .fontSize(11)
        .text(rtlText(certificate.teacher_name), 0, 337, { align: alignment });
    }

    doc
      .fillColor('#6b7280')
      .font('Body')
      .fontSize(9)
      .text(rtlText(LEARNIX_QUOTE[isArabic ? PreferredLanguage.AR : PreferredLanguage.EN]), width * 0.18, 365, {
        align: 'center',
        width: width * 0.64,
      });

    // Signature (left) + issue date.
    const baseY = height - 150;
    const signatureTitle = isArabic
      ? tpl.signature_title_ar || tpl.signature_title
      : tpl.signature_title;
    if (tpl.signature_name) {
      doc
        .fillColor('#111827')
        .font('Body-Bold')
        .fontSize(14)
        .text(rtlText(tpl.signature_name), 90, baseY, { width: 220, align: 'center' });
      if (signatureTitle) {
        doc
          .fillColor('#6b7280')
          .font('Body')
          .fontSize(10)
          .text(rtlText(signatureTitle), 90, baseY + 18, {
            width: 220,
            align: 'center',
          });
      }
      doc
        .lineWidth(1)
        .strokeColor('#9ca3af')
        .moveTo(90, baseY - 6)
        .lineTo(310, baseY - 6)
        .stroke();
    }

    doc
      .fillColor('#6b7280')
      .font('Body')
      .fontSize(11)
      .text(rtlText(ui.issued(issuedDate)), width - 360, baseY, {
        width: 220,
        align: 'center',
      });
    doc.fillColor('#6b7280').fontSize(10);
    this.drawLabelValue(
      doc,
      ui.certNumber(certificate.certificate_number),
      rtlText,
      width - 360,
      baseY + 18,
      { width: 220, align: 'center' },
    );

    // QR code + verification hint (bottom centre).
    doc.image(qrBuffer, width / 2 - 40, height - 130, { width: 80, height: 80 });
    doc.fillColor('#9ca3af').fontSize(8);
    this.drawLabelValue(doc, ui.verifyAt(verifyUrl), rtlText, 0, height - 44, {
      align: 'center',
    });

    doc.end();
    return done;
  }

  /**
   * Draws a "label: value" pair where the label is translated (and may need
   * Arabic shaping) but the value is Latin/numeric content (a date, a code,
   * a URL) that the bundled Arabic font has no glyphs for at all. Each part
   * is drawn with its own font via PDFKit's `continued` text chaining, so a
   * single line can mix the Arabic-shaped label with an unshaped Latin
   * value.
   */
  private drawLabelValue(
    doc: PDFKit.PDFDocument,
    parts: { label: string; value: string },
    rtlText: (text: string) => string,
    x: number,
    y: number,
    opts: PDFKit.Mixins.TextOptions,
  ): void {
    doc.font('Body').text(rtlText(parts.label), x, y, { ...opts, continued: true });
    doc.font('Helvetica').text(parts.value, { continued: false });
  }

  private verificationUrl(code: string): string {
    const base = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    return buildAbsoluteUrl(base, `/verify/${code}`);
  }

  /** Guard against a malformed stored colour crashing the renderer. */
  private safeColor(color: string): string {
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_TEMPLATE.accent_color;
  }

  private clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }

  /** The fixed platform logo is bundled/configured by the deployment, never user supplied. */
  private readLogo(): Buffer {
    const configured = this.configService.get<string>('CERTIFICATE_LOGO_PATH');
    const candidates = [
      configured,
      join(process.cwd(), 'assets', 'Art 2.png'),
      join(process.cwd(), '..', 'dodline', 'public', 'Art 2.png'),
    ].filter((path): path is string => Boolean(path));
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) {
      throw new Error('Learnix certificate logo is not deployed');
    }
    return readFileSync(path);
  }
}
