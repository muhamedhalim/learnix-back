import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';

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
import { LEARNIX_LOGO_PNG_BASE64 } from './learnix-logo.data';

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
  private readonly logger = new Logger(CertificatePdfService.name);
  private hasLoggedMissingLogo = false;

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
    const serif = tpl.font === 'serif';
    doc.registerFont('Latin', serif ? 'Times-Roman' : 'Helvetica');
    doc.registerFont('Latin-Bold', serif ? 'Times-Bold' : 'Helvetica-Bold');
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
    const fontFor = (text: string, bold = false): string =>
      isArabic && /[\u0600-\u06FF]/u.test(text)
        ? bold ? 'Body-Bold' : 'Body'
        : bold ? 'Latin-Bold' : 'Latin';

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

    /*
     * A single measured A4 grid shared by the template preview and every
     * issued document. It leaves dedicated bands for the brand, recipient,
     * course/description, and footer: dashboard/editor/canvas chrome never
     * reaches the print document.
     */
    const contentX = 84;
    const contentWidth = width - contentX * 2;
    const footerY = height - 132;

    // Platform branding and verification are renderer-owned, never template fields.
    // A wordmark is always rendered; the optional raster mark must never make a
    // student's certificate unavailable when an image was not packaged.
    const logo = this.readLogo(certificate.id);
    if (logo) {
      try {
        doc.image(logo, width / 2 - 24, 48, { fit: [48, 32] });
      } catch (error) {
        this.logLogoFallback(certificate.id, 'logo_image_invalid', error);
      }
    }
    doc
      .fillColor(accent)
      .font('Latin-Bold')
      .fontSize(15)
      .text('Learnix', 0, 86, { align: 'center', characterSpacing: 0.4 });

    // Title.
    const title = isArabic ? tpl.title_ar || tpl.title : tpl.title;
    const renderedTitle = rtlText(isArabic ? title : title.toUpperCase());
    const renderedTitleSize = this.fitTextBlockSize(
      doc,
      renderedTitle,
      fontFor(renderedTitle, true),
      titleSize,
      20,
      contentWidth,
      54,
    );
    doc
      .fillColor(accent)
      .font(fontFor(renderedTitle, true))
      .fontSize(renderedTitleSize)
      .text(renderedTitle, contentX, 119, {
        align: alignment,
        width: contentWidth,
        height: 54,
        lineGap: 1,
      });

    // Body with placeholders replaced. The formatted date always mixes a
    // (possibly Arabic) month name with digits, so it is rendered as a
    // single localized string through the same font as its surrounding
    // Arabic text rather than split like the purely-Latin cert number/URL.
    const issuedDate = certificate.issued_at.toLocaleDateString(isArabic ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const bodyTemplate = isArabic ? tpl.body_ar || DEFAULT_TEMPLATE.body_ar : tpl.body;
    const body = bodyTemplate
      .replace(/\{\{\s*student\s*\}\}/gi, certificate.student_name)
      .replace(/\{\{\s*course\s*\}\}/gi, certificate.course_title)
      .replace(/\{\{\s*date\s*\}\}/gi, issuedDate);

    // The recipient is the visual centre of the certificate, never a line
    // squeezed into surrounding copy. Two lines are allowed; the font only
    // shrinks as far as necessary to remain inside this reserved band.
    doc
      .fillColor('#6b7280')
      .font('Body')
      .fontSize(11)
      .text(rtlText(ui.certifies), contentX, 188, {
        align: 'center',
        width: contentWidth,
      });
    const studentNameSize = this.fitTextBlockSize(
      doc,
      rtlText(certificate.student_name),
      fontFor(certificate.student_name, true),
      38,
      18,
      contentWidth * 0.82,
      62,
    );
    doc
      .fillColor('#111827')
      .font(fontFor(certificate.student_name, true))
      .fontSize(studentNameSize)
      .text(rtlText(certificate.student_name), width * 0.09, 209, {
        align: 'center',
        width: width * 0.78,
        height: 62,
        lineGap: 1,
      });

    // Course is distinct from the free-form template description so it keeps
    // its hierarchy even when the body is long or contains placeholders.
    const courseSize = this.fitTextBlockSize(
      doc,
      rtlText(certificate.course_title),
      fontFor(certificate.course_title, true),
      19,
      13,
      contentWidth * 0.78,
      36,
    );
    doc
      .fillColor(accent)
      .font(fontFor(certificate.course_title, true))
      .fontSize(courseSize)
      .text(rtlText(certificate.course_title), width * 0.11, 282, {
        align: 'center',
        width: width * 0.78,
        height: 36,
        lineGap: 1,
      });

    const renderedBody = rtlText(body);
    const renderedBodySize = this.fitTextBlockSize(
      doc,
      renderedBody,
      fontFor(renderedBody),
      bodySize,
      11,
      contentWidth * 0.72,
      54,
    );
    doc
      .fillColor('#374151')
      .font(fontFor(renderedBody))
      .fontSize(renderedBodySize)
      .text(renderedBody, width * 0.14, 328, {
        align: alignment,
        width: width * 0.72,
        height: 54,
        lineGap: 2,
      });

    if (certificate.teacher_name) {
      doc
        .fillColor('#4b5563')
        .font(fontFor(certificate.teacher_name))
        .fontSize(10)
        .text(rtlText(certificate.teacher_name), contentX, 398, {
          align: 'center',
          width: contentWidth,
          height: 16,
        });
    }

    // Kept only as a legacy copy source; it is not part of the printable
    // certificate grid and therefore must not crowd the footer.
    if (certificate.id === '__never-render-legacy-copy__') {
    doc
      .fillColor('#6b7280')
      .font('Body')
      .fontSize(9)
      .text(rtlText(LEARNIX_QUOTE[isArabic ? PreferredLanguage.AR : PreferredLanguage.EN]), width * 0.18, 365, {
        align: 'center',
        width: width * 0.64,
      });

    }

    // Footer: signature, QR verification, and document metadata occupy one
    // aligned baseline with intentionally separate columns.
    const signatureX = 78;
    const signatureWidth = 210;
    const metadataX = width - signatureX - signatureWidth;
    const signatureTitle = isArabic
      ? tpl.signature_title_ar || tpl.signature_title
      : tpl.signature_title;
    if (tpl.signature_name) {
      doc
        .lineWidth(1)
        .strokeColor('#9ca3af')
        .moveTo(signatureX, footerY)
        .lineTo(signatureX + signatureWidth, footerY)
        .stroke();
      doc
        .fillColor('#111827')
        .font(fontFor(tpl.signature_name, true))
        .fontSize(13)
        .text(rtlText(tpl.signature_name), signatureX, footerY + 8, {
          width: signatureWidth,
          height: 18,
          align: 'center',
        });
      if (signatureTitle) {
        doc
          .fillColor('#6b7280')
          .font(fontFor(signatureTitle))
          .fontSize(9)
          .text(rtlText(signatureTitle), signatureX, footerY + 26, {
            width: signatureWidth,
            height: 14,
            align: 'center',
          });
      }
    }

    doc
      .fillColor('#6b7280')
      .font('Body')
      .fontSize(10)
      .text(rtlText(ui.issued(issuedDate)), metadataX, footerY + 2, {
        width: signatureWidth,
        height: 16,
        align: 'center',
      });
    doc.fillColor('#6b7280').fontSize(9);
    this.drawLabelValue(
      doc,
      ui.certNumber(certificate.certificate_number),
      rtlText,
      metadataX,
      footerY + 22,
      { width: signatureWidth, align: 'center', height: 14 },
    );

    // QR code + verification hint (bottom centre), safely above the inner
    // border and isolated from the neighbouring footer columns.
    doc.image(qrBuffer, width / 2 - 34, footerY - 5, { width: 68, height: 68 });
    doc.fillColor('#9ca3af').fontSize(8);
    this.drawLabelValue(doc, ui.verifyAt(verifyUrl), rtlText, 0, height - 58, {
      align: 'center', width, height: 12,
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
    const label = rtlText(parts.label);
    doc.font('Body');
    const labelWidth = doc.widthOfString(label);
    doc.font('Helvetica');
    const valueWidth = doc.widthOfString(parts.value);
    const availableWidth = opts.width ?? labelWidth + valueWidth;
    const startX =
      opts.align === 'center'
        ? x + (availableWidth - labelWidth - valueWidth) / 2
        : opts.align === 'right'
          ? x + availableWidth - labelWidth - valueWidth
          : x;

    // Do not use PDFKit's `continued` with a centred text box: it recentres
    // each fragment independently. Measured coordinates keep the two fonts
    // adjacent for both English and Arabic labels.
    doc.font('Body').text(label, startX, y, { ...opts, align: 'left', width: labelWidth });
    doc
      .font('Helvetica')
      .text(parts.value, startX + labelWidth, y, { ...opts, align: 'left', width: valueWidth });
  }

  private verificationUrl(code: string): string {
    const base = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      // A certificate can leave the deployment where it was issued. Never
      // bake a loopback or container-only URL into its QR code.
      'https://learnix.school',
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

  /** Keep long Arabic and Latin text inside its exact fixed-A4 grid box. */
  private fitTextBlockSize(
    doc: PDFKit.PDFDocument,
    text: string,
    font: string,
    maxSize: number,
    minSize: number,
    width: number,
    maxHeight: number,
  ): number {
    doc.font(font);
    for (let size = maxSize; size >= minSize; size -= 1) {
      if (doc.fontSize(size).heightOfString(text, { width, lineGap: 2 }) <= maxHeight) return size;
    }
    return minSize;
  }

  /**
   * The default raster logo is embedded with this backend; it never depends
   * on another workspace/application or a runtime path. An operator may set
   * `CERTIFICATE_LOGO_PATH` to deliberately override it with a read-only
   * asset included in the backend image or mounted storage.
   *
   * The PDF's text wordmark is the secure fallback, so an omitted or corrupt
   * optional image can never turn a valid certificate request into a 500.
   */
  private readLogo(certificateId: string | undefined): Buffer | null {
    const configured = this.configService.get<string>('CERTIFICATE_LOGO_PATH')?.trim();
    if (!configured) {
      return Buffer.from(LEARNIX_LOGO_PNG_BASE64, 'base64');
    }
    if (!existsSync(configured)) {
      this.logLogoFallback(certificateId, 'logo_path_not_found');
      return Buffer.from(LEARNIX_LOGO_PNG_BASE64, 'base64');
    }
    try {
      return readFileSync(configured);
    } catch (error) {
      this.logLogoFallback(certificateId, 'logo_read_failed', error);
      return Buffer.from(LEARNIX_LOGO_PNG_BASE64, 'base64');
    }
  }

  private logLogoFallback(
    certificateId: string | undefined,
    reason: 'logo_path_not_configured' | 'logo_path_not_found' | 'logo_read_failed' | 'logo_image_invalid',
    error?: unknown,
  ): void {
    // Missing static branding is a deploy concern, not a certificate failure.
    // Log once per process to retain a useful signal without flooding logs.
    if (this.hasLoggedMissingLogo) return;
    this.hasLoggedMissingLogo = true;
    this.logger.warn(
      JSON.stringify({
        event: 'certificate_logo_fallback',
        reason,
        certificateId: certificateId ?? null,
        error: error instanceof Error ? error.message : undefined,
      }),
    );
  }
}
