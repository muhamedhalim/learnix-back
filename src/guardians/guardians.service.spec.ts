import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DataSource, EntityManager } from 'typeorm';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import {
  Guardian,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from './entities';
import { GuardiansService } from './guardians.service';

/** Minimal fake for the fluent query builder `findNotificationTargets` uses. */
function makeQueryBuilder(rows: unknown[]) {
  const qb = {
    innerJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    select: jest.fn(() => qb),
    getRawMany: jest.fn(async () => rows),
  };
  return qb;
}

describe('GuardiansService', () => {
  let service: GuardiansService;
  let links: { createQueryBuilder: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let guardians: { findOne: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    links = { createQueryBuilder: jest.fn(), findOne: jest.fn(), save: jest.fn() };
    guardians = { findOne: jest.fn(), update: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuardiansService,
        { provide: getRepositoryToken(Guardian), useValue: guardians },
        { provide: getRepositoryToken(StudentGuardian), useValue: links },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    service = module.get(GuardiansService);
  });

  describe('findNotificationTargets', () => {
    const row = {
      guardian_id: 'g1',
      student_id: 's1',
      notification_preferences: null,
      phone_e164: '+201012345678',
      full_name: 'Parent',
      preferred_language: PreferredLanguage.AR,
      whatsapp_capable: true,
    };

    it('gates educational events on verification, opt-out and the link switch', async () => {
      const qb = makeQueryBuilder([row]);
      links.createQueryBuilder.mockReturnValue(qb);

      await service.findNotificationTargets('s1', ParentEventType.EXAM_GRADED);

      const clauses = qb.andWhere.mock.calls.map((call) => String(call[0]));
      expect(clauses).toEqual(
        expect.arrayContaining([
          expect.stringContaining('g.deleted_at IS NULL'),
          expect.stringContaining('link.receives_notifications = true'),
          expect.stringContaining('g.opted_out_at IS NULL'),
          expect.stringContaining('g.verification_status = :verified'),
        ]),
      );
      // Always scoped to the requesting student — no cross-student addressing.
      expect(qb.where).toHaveBeenCalledWith('link.student_id = :studentId', { studentId: 's1' });
    });

    it('does NOT require verification for transactional OTP delivery', async () => {
      const qb = makeQueryBuilder([row]);
      links.createQueryBuilder.mockReturnValue(qb);

      await service.findNotificationTargets('s1', ParentEventType.GUARDIAN_VERIFICATION);

      const clauses = qb.andWhere.mock.calls.map((call) => String(call[0]));
      expect(clauses).not.toEqual(
        expect.arrayContaining([expect.stringContaining('verification_status')]),
      );
    });

    it('applies the per-event default when no explicit preference is stored', async () => {
      links.createQueryBuilder.mockReturnValue(makeQueryBuilder([row]));

      // Both events currently default to true when no per-link override exists.
      await expect(
        service.findNotificationTargets('s1', ParentEventType.EXAM_GRADED),
      ).resolves.toHaveLength(1);

      links.createQueryBuilder.mockReturnValue(makeQueryBuilder([row]));
      await expect(
        service.findNotificationTargets('s1', ParentEventType.LESSON_COMPLETED),
      ).resolves.toHaveLength(1);
    });

    it('honours an explicit per-event opt-out', async () => {
      links.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([{ ...row, notification_preferences: { exam_graded: false } }]),
      );

      await expect(
        service.findNotificationTargets('s1', ParentEventType.EXAM_GRADED),
      ).resolves.toHaveLength(0);
    });
  });

  describe('linkGuardianWith', () => {
    it('claims a new guardian phone atomically and then links the resolved row', async () => {
      const guardian = { id: 'g1', phone_e164: '+201011111111' } as Guardian;
      const link = {
        id: 'link-1',
        student_id: 's1',
        guardian_id: guardian.id,
        is_primary: false,
      } as StudentGuardian;
      const manager = {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(guardian)
          .mockResolvedValueOnce(null),
        query: jest.fn().mockResolvedValue([]),
        create: jest.fn((_entity: unknown, value: unknown) => value),
        save: jest.fn().mockResolvedValue(link),
      } as unknown as EntityManager;

      await expect(
        service.linkGuardianWith(manager, 's1', {
          phone: '01011111111',
          is_primary: false,
        }),
      ).resolves.toBe(link);

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT ("phone_e164") DO NOTHING'),
        expect.arrayContaining(['+201011111111']),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          student_id: 's1',
          guardian_id: 'g1',
        }),
      );
    });

    it('reuses an existing guardian without overwriting guardian-wide attributes', async () => {
      const guardian = {
        id: 'g1',
        phone_e164: '+201011111111',
        full_name: 'Verified Parent',
        verification_status: GuardianVerificationStatus.VERIFIED,
      } as Guardian;
      const manager = {
        findOne: jest.fn().mockResolvedValueOnce(guardian).mockResolvedValueOnce(null),
        query: jest.fn(),
        create: jest.fn((_entity: unknown, value: unknown) => value),
        save: jest.fn(async (value: unknown) => value),
      } as unknown as EntityManager;

      await service.linkGuardianWith(manager, 's2', {
        phone: '01011111111',
        full_name: 'Different Name',
        is_primary: false,
      });

      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ guardian_id: guardian.id, student_id: 's2' }),
      );
    });
  });

  describe('changePhone', () => {
    it('refuses to rewrite a VERIFIED guardian phone', async () => {
      links.findOne.mockResolvedValue({
        student_id: 's1',
        guardian_id: 'g1',
        guardian: { verification_status: GuardianVerificationStatus.VERIFIED },
      });

      await expect(service.changePhone('s1', 'g1', '01099999999')).rejects.toThrow(
        ForbiddenException,
      );
      expect(guardians.update).not.toHaveBeenCalled();
    });

    it('allows changing an UNVERIFIED phone and resets verification state', async () => {
      links.findOne.mockResolvedValue({
        student_id: 's1',
        guardian_id: 'g1',
        guardian: { verification_status: GuardianVerificationStatus.UNVERIFIED },
      });
      guardians.findOne.mockResolvedValue(null); // no clash
      guardians.update.mockResolvedValue({});
      jest.spyOn(service, 'findByIdOrThrow').mockResolvedValue({ id: 'g1' } as Guardian);

      await service.changePhone('s1', 'g1', '01099999999');

      expect(guardians.update).toHaveBeenCalledWith('g1', {
        phone_e164: '+201099999999',
        whatsapp_capable: true,
        verification_status: GuardianVerificationStatus.UNVERIFIED,
        verified_at: null,
      });
    });

    it('rejects a phone that cannot be normalised to E.164', async () => {
      links.findOne.mockResolvedValue({
        student_id: 's1',
        guardian_id: 'g1',
        guardian: { verification_status: GuardianVerificationStatus.UNVERIFIED },
      });

      await expect(service.changePhone('s1', 'g1', '01,12345678')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a phone already owned by a different guardian', async () => {
      links.findOne.mockResolvedValue({
        student_id: 's1',
        guardian_id: 'g1',
        guardian: { verification_status: GuardianVerificationStatus.UNVERIFIED },
      });
      guardians.findOne.mockResolvedValue({ id: 'g2' });

      await expect(service.changePhone('s1', 'g1', '01099999999')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
