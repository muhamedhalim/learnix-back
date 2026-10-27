import 'reflect-metadata';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { PaymentsModule } from '../payments/payments.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { CertificateTemplatesService } from '../certificates/certificate-templates.service';
import { CertificateVerificationService } from '../certificates/certificate-verification.service';
import { CertificatesService } from '../certificates/certificates.service';
import { LessonSessionNotificationService } from './lesson-session-notification.service';
import { LessonSessionsService } from './lesson-sessions.service';

/**
 * SOLID Phase 5 wiring. The notification cron moved from `LessonSessionsService` to its own
 * provider; the schedule must be registered exactly once, with the same cadence and the same
 * cluster-lock name, or the reminders would stop (or double) silently.
 */
describe('lesson session / certificate service split (SOLID Phase 5)', () => {
  const cronMeta = (target: object, method: string): unknown =>
    Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, (target as Record<string, object>)[method]);

  it('registers the notification cron on LessonSessionNotificationService only', () => {
    expect(
      cronMeta(LessonSessionNotificationService.prototype, 'dispatchScheduledSessionNotifications'),
    ).toMatchObject({ cronTime: '0 */5 * * * *' });
    expect('dispatchScheduledSessionNotifications' in LessonSessionsService.prototype).toBe(false);
  });

  it('provides LessonSessionNotificationService wherever LessonSessionsService is provided', () => {
    const providers = Reflect.getMetadata('providers', PaymentsModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([LessonSessionsService, LessonSessionNotificationService]),
    );
  });

  it('provides the certificate template and verification services', () => {
    const providers = Reflect.getMetadata('providers', CertificatesModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        CertificatesService,
        CertificateTemplatesService,
        CertificateVerificationService,
      ]),
    );
  });

  it('keeps template authoring and public reads off CertificatesService', () => {
    for (const method of [
      'createTemplate',
      'publishTemplate',
      'getTemplates',
      'getPublicCertificates',
      'getByVerificationCode',
    ]) {
      expect(method in CertificatesService.prototype).toBe(false);
    }
  });
});
