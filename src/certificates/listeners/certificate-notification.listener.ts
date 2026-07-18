import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { NotificationsService } from '../../notifications/services/notifications.service';
import {
  CERTIFICATE_ISSUED_EVENT,
  type CertificateIssuedEvent,
} from '../certificates.service';
import { Certificate } from '../entities/certificate.entity';

/**
 * Tells the student their certificate is ready. Fires for both automatic
 * (course-completion) and manual/bulk issuance since all paths emit
 * CERTIFICATE_ISSUED_EVENT. Failures are logged, never propagated — a broken
 * notification must not fail an issuance.
 */
@Injectable()
export class CertificateNotificationListener {
  private readonly logger = new Logger(CertificateNotificationListener.name);

  constructor(
    @InjectRepository(Certificate)
    private readonly certificatesRepository: Repository<Certificate>,
    private readonly notificationsService: NotificationsService,
  ) {}

  @OnEvent(CERTIFICATE_ISSUED_EVENT)
  public async handleCertificateIssued(event: CertificateIssuedEvent): Promise<void> {
    try {
      const certificate = await this.certificatesRepository.findOne({
        where: { id: event.certificateId },
      });
      if (!certificate) return;

      await this.notificationsService.create(
        {
          user_id: event.studentId,
          type: NotificationType.CUSTOM,
          title: 'Certificate earned! 🎓',
          message:
            `Congratulations — your certificate for "${certificate.course_title}" is ready. ` +
            `Certificate No. ${certificate.certificate_number}.`,
          data: {
            certificate_id: certificate.id,
            certificate_number: certificate.certificate_number,
          },
        },
        false, // in-app only; no SMS for certificate notices
      );
    } catch (error) {
      this.logger.warn(
        `Certificate notification failed for student ${event.studentId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }
}
