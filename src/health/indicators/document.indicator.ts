import { Injectable } from '@nestjs/common';

import PDFDocument from 'pdfkit';

import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

@Injectable()
export class DocumentHealthIndicator implements HealthIndicator {
  public readonly id = 'pdf-generation';

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    try {
      const bytes = await withHealthTimeout(
        this.id,
        new Promise<number>((resolve, reject) => {
          const document = new PDFDocument({ autoFirstPage: true, compress: true });
          let total = 0;
          document.on('data', (chunk: Buffer) => {
            total += chunk.length;
          });
          document.on('end', () => resolve(total));
          document.on('error', reject);
          document.fontSize(10).text('Learnix health check');
          document.end();
        }),
        5_000,
      );
      return componentResult({
        id: this.id,
        name: 'PDF generation',
        category: 'document',
        status: bytes > 0 ? 'healthy' : 'degraded',
        startedAt,
        message: 'In-memory PDF generation completed without writing persistent data.',
        metadata: { generatedBytes: bytes, engine: 'pdfkit' },
        dependencies: ['backend-api'],
      });
    } catch (error) {
      return componentResult({
        id: this.id,
        name: 'PDF generation',
        category: 'document',
        status: 'down',
        startedAt,
        message: sanitiseMessage(error),
        metadata: { engine: 'pdfkit' },
        errorCode: errorCode(error, 'PDF_GENERATION_FAILED'),
        recommendation: 'Verify PDFKit, fonts, memory headroom, and document templates.',
        dependencies: ['backend-api'],
      });
    }
  }
}
