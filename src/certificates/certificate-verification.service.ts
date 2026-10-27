import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { biBody } from '../i18n/error-translator.util';
import { Certificate } from './entities/certificate.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import type { PaginatedList, PublicCertificateCard } from './certificates.service';

/** T038 (W1-C6 d): anonymous, viewer-independent public catalog reads. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

/**
 * Read-only, unauthenticated certificate surfaces: the public achievements gallery and
 * verification by code. Extracted unchanged from `CertificatesService` so these public reads do
 * not need the issuance dependencies (eligibility, PDF, event bus, transactions).
 */
@Injectable()
export class CertificateVerificationService {
  constructor(
    @InjectRepository(Certificate)
    private readonly certificatesRepository: Repository<Certificate>,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /**
   * The public achievements gallery: only certificates their owners chose to
   * publish, and only while still valid. Returns a sanitized projection —
   * the DB id, student id, and grades never leave the server.
   *
   * Cached (T038, W1-C6 d), `public_catalog`/`public`, 60 s TTL. Privacy-
   * sensitive: revoke/reissue (`revokeCertificate`) and the visibility toggle
   * (`setVisibility`) reach this via the interceptor's global invalidateAll()
   * fallback (neither route declares `@InvalidatesCache`); the non-HTTP
   * revoke path (`CertificateEligibilityService.revokeForWithdrawnAccess`,
   * reachable from refund crons with no HTTP request) invalidates explicitly
   * — see that method. No rule-7 TTL-drift exception was needed.
   */
  public async getPublicCertificates(options: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedList<PublicCertificateCard>> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'certificates.public',
        scope: 'public',
        parts: [
          options.page ?? 1,
          options.limit ?? 12,
          (options.search ?? '').trim().toLowerCase(),
        ],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computePublicCertificates(options),
    );
  }

  private async computePublicCertificates(options: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedList<PublicCertificateCard>> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 50) : 12;

    const qb = this.certificatesRepository
      .createQueryBuilder('c')
      .where('c.is_public = true')
      .andWhere('c.status = :status', { status: CertificateStatus.ISSUED });

    if (options.search?.trim()) {
      qb.andWhere(
        '(c.student_name ILIKE :search OR c.course_title ILIKE :search OR c.certificate_number ILIKE :search)',
        { search: `%${options.search.trim()}%` },
      );
    }

    const [rows, total] = await qb
      .orderBy('c.issued_at', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);
    return {
      data: rows.map((c) => ({
        publicId: c.verification_code,
        certificate_number: c.certificate_number,
        student_name: c.student_name,
        course_title: c.course_title,
        teacher_name: c.teacher_name,
        issued_at: c.issued_at,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /** Public verification by code — returns the certificate (any status). */
  public async getByVerificationCode(code: string): Promise<Certificate> {
    const certificate = await this.certificatesRepository.findOne({
      where: { verification_code: code },
    });
    if (!certificate) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    return certificate;
  }

  /**
   * A downloadable public document is available only while the certificate is
   * valid. A revoked certificate — including one revoked by a full refund —
   * is never rendered as a document, so it can never be presented as proof.
   */
  public async getVerifiedCertificateByCode(code: string): Promise<Certificate> {
    const certificate = await this.getByVerificationCode(code);
    if (certificate.status !== CertificateStatus.ISSUED) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    return certificate;
  }
}
