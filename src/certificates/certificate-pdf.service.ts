import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

import { Certificate } from './entities/certificate.entity';
import { CertificateTemplate } from './entities/certificate-template.entity';

/** Sensible defaults used when no template row exists. */
const DEFAULT_TEMPLATE = {
  title: 'Certificate of Completion',
  body: 'This is proudly presented to {{student}} for successfully completing {{course}}.',
  signature_name: null as string | null,
  signature_title: null as string | null,
  accent_color: '#6d28d9',
};

@Injectable()
export class CertificatePdfService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Render a certificate to a PDF buffer. Deterministic from the certificate +
   * template data, so it can be produced on demand (no stored file needed).
   */
  public async render(
    certificate: Certificate,
    template: CertificateTemplate | null,
  ): Promise<Buffer> {
    const tpl = template ?? DEFAULT_TEMPLATE;
    const accent = this.safeColor(tpl.accent_color);

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

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const width = doc.page.width;
    const height = doc.page.height;

    // Background + decorative border.
    doc.rect(0, 0, width, height).fill('#ffffff');
    doc
      .lineWidth(6)
      .strokeColor(accent)
      .rect(24, 24, width - 48, height - 48)
      .stroke();
    doc
      .lineWidth(1)
      .strokeColor(accent)
      .rect(36, 36, width - 72, height - 72)
      .stroke();

    // Title.
    doc
      .fillColor(accent)
      .font('Helvetica-Bold')
      .fontSize(34)
      .text(tpl.title.toUpperCase(), 0, 90, { align: 'center' });

    // Body with placeholders replaced.
    const issuedDate = certificate.issued_at.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const body = tpl.body
      .replace(/\{\{\s*student\s*\}\}/gi, certificate.student_name)
      .replace(/\{\{\s*course\s*\}\}/gi, certificate.course_title)
      .replace(/\{\{\s*date\s*\}\}/gi, issuedDate);

    doc
      .fillColor('#111827')
      .font('Helvetica')
      .fontSize(16)
      .text('This certifies that', 0, 170, { align: 'center' });

    doc
      .fillColor('#111827')
      .font('Helvetica-Bold')
      .fontSize(30)
      .text(certificate.student_name, 0, 200, { align: 'center' });

    doc
      .fillColor('#374151')
      .font('Helvetica')
      .fontSize(15)
      .text(body, width * 0.15, 250, {
        align: 'center',
        width: width * 0.7,
      });

    // Signature (left) + issue date.
    const baseY = height - 150;
    if (tpl.signature_name) {
      doc
        .fillColor('#111827')
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(tpl.signature_name, 90, baseY, { width: 220, align: 'center' });
      if (tpl.signature_title) {
        doc
          .fillColor('#6b7280')
          .font('Helvetica')
          .fontSize(10)
          .text(tpl.signature_title, 90, baseY + 18, {
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
      .font('Helvetica')
      .fontSize(11)
      .text(`Issued: ${issuedDate}`, width - 360, baseY, {
        width: 220,
        align: 'center',
      });
    doc
      .fillColor('#6b7280')
      .fontSize(10)
      .text(`Certificate No. ${certificate.certificate_number}`, width - 360, baseY + 18, {
        width: 220,
        align: 'center',
      });

    // QR code + verification hint (bottom centre).
    doc.image(qrBuffer, width / 2 - 40, height - 130, { width: 80, height: 80 });
    doc
      .fillColor('#9ca3af')
      .fontSize(8)
      .text(`Verify at ${verifyUrl}`, 0, height - 44, { align: 'center' });

    doc.end();
    return done;
  }

  private verificationUrl(code: string): string {
    const base =
      this.configService.get<string>('FRONTEND_URL') ?? 'https://learnix.school';
    return `${base.replace(/\/$/, '')}/verify/${code}`;
  }

  /** Guard against a malformed stored colour crashing the renderer. */
  private safeColor(color: string): string {
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_TEMPLATE.accent_color;
  }
}
