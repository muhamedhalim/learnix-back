import { UnprocessableEntityException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import {
  ACTIVE_PACKAGE_PURCHASE_SQL,
  CertificateEligibilityService,
} from './certificate-eligibility.service';
import { Certificate } from './entities/certificate.entity';
import { CertificateHistory } from './entities/certificate-history.entity';
import { CertificateStatus } from './entities/certificate-status.enum';

describe('CertificateEligibilityService', () => {
  let service: CertificateEligibilityService;
  let query: Record<string, jest.Mock>;
  let purchases: { createQueryBuilder: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const issuedCertificate = (over: Partial<Certificate> = {}): Certificate =>
    ({
      id: 'cert-1',
      certificate_number: 'CERT-2026-ABC',
      verification_code: 'VER123',
      student_id: 'student-1',
      package_id: 'course-1',
      course_title: 'Algorithms',
      status: CertificateStatus.ISSUED,
      is_public: true,
      revoked_at: null,
      revoke_reason: null,
      revoked_by: null,
      revocation_context: null,
      ...over,
    }) as Certificate;

  beforeEach(async () => {
    query = {
      where: jest.fn(() => query),
      andWhere: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      addOrderBy: jest.fn(() => query),
      setLock: jest.fn(() => query),
      getOne: jest.fn().mockResolvedValue(null),
    };
    purchases = { createQueryBuilder: jest.fn(() => query) };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
      create: jest.fn((_entity: unknown, value: unknown) => value),
      // `createQueryBuilder(Entity, alias)` is the locking SELECT; the no-arg
      // form is the notification INSERT builder.
      createQueryBuilder: jest.fn((entity?: unknown) => (entity ? query : insertQuery)),
    };
    // `findActivePurchase` inside the service reaches for a repository off the
    // manager when one is supplied.
    (manager as unknown as { getRepository: jest.Mock }).getRepository = jest.fn(() => purchases);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificateEligibilityService,
        { provide: getRepositoryToken(PackagePurchase), useValue: purchases },
      ],
    }).compile();
    service = module.get(CertificateEligibilityService);
  });

  describe('the canonical predicate', () => {
    it('requires a non-revoked purchase AND a still-active, unexpired entitlement', () => {
      const sql = ACTIVE_PACKAGE_PURCHASE_SQL('pp');
      expect(sql).toContain('pp.revoked_at IS NULL');
      expect(sql).toContain("ent.item_type = 'package'");
      expect(sql).toContain("ent.status <> 'active'");
      expect(sql).toContain('ent.expires_at IS NOT NULL AND ent.expires_at <= now()');
    });

    it('is applied verbatim to any purchase query, so bulk paths cannot drift', () => {
      service.applyActivePurchase(query as never, 'pp');
      expect(query.andWhere).toHaveBeenCalledWith(`(${ACTIVE_PACKAGE_PURCHASE_SQL('pp')})`);
    });
  });

  describe('assertEligible', () => {
    it('rejects a student with no valid purchase', async () => {
      query.getOne.mockResolvedValue(null);
      await expect(service.assertEligible('student-1', 'course-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('returns the purchase that makes the student eligible', async () => {
      const purchase = { id: 'pp-1', course_version_id: 'v2' };
      query.getOne.mockResolvedValue(purchase);
      await expect(service.assertEligible('student-1', 'course-1')).resolves.toBe(purchase);
    });
  });

  describe('lockActivePurchase', () => {
    it('re-reads the purchase after taking the row lock, not before', async () => {
      query.getOne
        .mockResolvedValueOnce({ id: 'pp-1' }) // candidate
        .mockResolvedValueOnce({ id: 'pp-1' }) // the locking SELECT
        .mockResolvedValueOnce(null); // re-read: a refund committed while we waited

      await expect(service.lockActivePurchase(manager as never, 'student-1', 'course-1')).resolves.toBeNull();
      expect(query.setLock).toHaveBeenCalledWith('pessimistic_write');
    });
  });

  describe('revokeForWithdrawnAccess', () => {
    const revocation = {
      studentId: 'student-1',
      packageId: 'course-1',
      reason: 'refund:customer_request',
      actorId: 'admin-1',
      context: { source: 'refund' as const, refund_id: 'refund-1', order_id: 'order-1' },
    };

    it('revokes the certificate, snapshots history, and forces it private', async () => {
      manager.findOne.mockResolvedValue(issuedCertificate());
      query.getOne.mockResolvedValue(null); // no remaining valid purchase

      const revoked = await service.revokeForWithdrawnAccess(manager as never, revocation);

      expect(revoked?.status).toBe(CertificateStatus.REVOKED);
      expect(revoked?.is_public).toBe(false);
      expect(revoked?.revoked_by).toBe('admin-1');
      expect(revoked?.revocation_context).toEqual(revocation.context);
      expect(revoked?.revoked_at).toBeInstanceOf(Date);
      expect(manager.save).toHaveBeenCalledWith(
        CertificateHistory,
        expect.objectContaining({
          certificate_id: 'cert-1',
          certificate_number: 'CERT-2026-ABC',
          verification_code: 'VER123',
          revocation_context: revocation.context,
        }),
      );
    });

    it('is a no-op when there is no certificate at all', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.revokeForWithdrawnAccess(manager as never, revocation),
      ).resolves.toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('writes no second record when the certificate is already revoked', async () => {
      manager.findOne.mockResolvedValue(
        issuedCertificate({ status: CertificateStatus.REVOKED, revoked_at: new Date() }),
      );
      await expect(
        service.revokeForWithdrawnAccess(manager as never, revocation),
      ).resolves.toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('keeps the certificate when another valid purchase of the course survives', async () => {
      manager.findOne.mockResolvedValue(issuedCertificate());
      query.getOne.mockResolvedValue({ id: 'pp-2' }); // re-bought after the refund

      await expect(
        service.revokeForWithdrawnAccess(manager as never, revocation),
      ).resolves.toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('never deletes the historical certificate row', async () => {
      manager.findOne.mockResolvedValue(issuedCertificate());
      query.getOne.mockResolvedValue(null);

      const revoked = await service.revokeForWithdrawnAccess(manager as never, revocation);

      expect(revoked?.id).toBe('cert-1');
      expect(revoked?.certificate_number).toBe('CERT-2026-ABC');
      expect(manager).not.toHaveProperty('remove');
    });
  });
});
