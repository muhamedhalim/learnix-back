import { ConfigService } from '@nestjs/config';

import { CertificatePdfService } from './certificate-pdf.service';
import { Certificate } from './entities/certificate.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';

describe('CertificatePdfService', () => {
  const config = {
    get: jest.fn().mockReturnValue('https://learnix.school'),
  } as unknown as ConfigService;
  const service = new CertificatePdfService(config);

  const certificate = {
    certificate_number: 'CERT-2026-AB3D9K',
    verification_code: 'ABCDE23456',
    student_name: 'Ada Lovelace',
    course_title: 'Introduction to Algorithms',
    teacher_name: 'Prof X',
    completion_percentage: 100,
    status: CertificateStatus.ISSUED,
    issued_at: new Date('2026-07-10T00:00:00Z'),
  } as Certificate;

  it('renders a valid PDF buffer (magic header) with a default template', async () => {
    const buffer = await service.render(certificate, null);
    expect(buffer.length).toBeGreaterThan(1000);
    // PDF files begin with "%PDF".
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders with a custom template + accent colour', async () => {
    const template = {
      title: 'Award of Excellence',
      body: 'Presented to {{student}} for {{course}} on {{date}}.',
      signature_name: 'Jane Doe',
      signature_title: 'Director',
      accent_color: '#0ea5e9',
    } as CertificateTemplate;
    const buffer = await service.render(certificate, template);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('falls back to a safe colour for a malformed accent value', async () => {
    const template = { accent_color: 'not-a-color', title: 'X', body: '{{student}}' } as CertificateTemplate;
    const buffer = await service.render(certificate, template);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
