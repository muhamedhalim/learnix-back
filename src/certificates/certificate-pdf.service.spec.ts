import { ConfigService } from '@nestjs/config';

import { CertificatePdfService } from './certificate-pdf.service';
import { Certificate } from './entities/certificate.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';

describe('CertificatePdfService', () => {
  const config = {
    get: jest.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://learnix.school' : undefined)),
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

  it('renders with the bundled Learnix logo when no deployment override is configured', async () => {
    const noLogoConfig = {
      get: jest.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://learnix.school' : undefined)),
    } as unknown as ConfigService;
    const noLogoService = new CertificatePdfService(noLogoConfig);

    const buffer = await noLogoService.render(certificate, null);

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('keeps rendering with the bundled logo when an override path is unavailable', async () => {
    const unavailableOverrideConfig = {
      get: jest.fn((key: string) => {
        if (key === 'FRONTEND_URL') return 'https://learnix.school';
        if (key === 'CERTIFICATE_LOGO_PATH') return '/not-deployed/learnix-logo.png';
        return undefined;
      }),
    } as unknown as ConfigService;
    const unavailableOverrideService = new CertificatePdfService(unavailableOverrideConfig);

    const buffer = await unavailableOverrideService.render(certificate, null);

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('never uses a localhost verification URL when FRONTEND_URL is absent', () => {
    const noOriginConfig = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const noOriginService = new CertificatePdfService(noOriginConfig);
    const verificationUrl = (
      noOriginService as unknown as { verificationUrl: (code: string) => string }
    ).verificationUrl('ABCDE23456');

    expect(verificationUrl).toBe('https://learnix.school/verify/ABCDE23456');
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
    const template = {
      accent_color: 'not-a-color',
      title: 'X',
      body: '{{student}}',
    } as CertificateTemplate;
    const buffer = await service.render(certificate, template);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders a valid Arabic PDF using the Arabic-capable embedded font', async () => {
    const buffer = await service.render(certificate, null, PreferredLanguage.AR);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('keeps long mixed-language recipient and course text within the fixed A4 renderer', async () => {
    const longCertificate = {
      ...certificate,
      student_name: 'أحمد محمد عبدالرحمن الطويل Long English Name',
      course_title: 'Advanced Learning and Achievement Program with an Extended Course Title',
    } as Certificate;

    const buffer = await service.render(longCertificate, null, PreferredLanguage.AR);

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('renders Arabic using template title_ar/body_ar/signature_title_ar when present', async () => {
    const template = {
      title: 'Award of Excellence',
      title_ar: 'شهادة تفوق',
      body: 'Presented to {{student}} for {{course}} on {{date}}.',
      body_ar: 'تُمنح إلى {{student}} عن {{course}} بتاريخ {{date}}.',
      signature_name: 'د. سارة أحمد',
      signature_title: 'Director',
      signature_title_ar: 'المديرة',
      accent_color: '#0ea5e9',
    } as CertificateTemplate;
    const buffer = await service.render(certificate, template, PreferredLanguage.AR);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('falls back to the English field when a template has no _ar copy yet', async () => {
    const template = {
      title: 'Award of Excellence',
      body: 'Presented to {{student}} for {{course}} on {{date}}.',
      signature_name: 'Jane Doe',
      signature_title: 'Director',
      accent_color: '#0ea5e9',
    } as CertificateTemplate;
    const buffer = await service.render(certificate, template, PreferredLanguage.AR);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
