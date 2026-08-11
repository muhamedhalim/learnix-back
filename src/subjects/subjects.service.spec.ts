import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { DataSource, Repository } from 'typeorm';

import type { ActivityLogsService } from '../activity-logs/activity-logs.service';
import type { AuditEvent } from '../activity-logs/events/audit.events';
import { SubjectStatus } from './entities/subject-status.enum';
import type { Subject } from './entities/subject.entity';
import { SubjectsService } from './subjects.service';

const TEACHER_A = 'teacher-a';
const TEACHER_B = 'teacher-b';
const ADMIN = 'admin-1';

function buildSubject(overrides: Partial<Subject> = {}): Subject {
  return {
    id: 'subject-1',
    name: 'Physics',
    description: null,
    description_ar: null,
    status: SubjectStatus.APPROVED,
    created_by_teacher_id: null,
    rejection_reason: null,
    reviewed_by_admin_id: null,
    reviewed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  } as Subject;
}

interface Harness {
  service: SubjectsService;
  findOne: jest.Mock;
  save: jest.Mock;
  softRemove: jest.Mock;
  getExists: jest.Mock;
  query: jest.Mock;
  recordAuditEvent: jest.Mock;
  /** Every audit event handed to ActivityLogsService, in order. */
  auditEvents: () => AuditEvent[];
}

/** No references anywhere — the default for tests that are not about deletion. */
const NO_REFERENCES = [
  {
    lessons: '0',
    packages: '0',
    exams: '0',
    questions: '0',
    books: '0',
    teacherLinks: '0',
    questionSolves: '0',
    practiceSessions: '0',
    studentRatings: '0',
  },
];

function buildService(): Harness {
  const findOne = jest.fn();
  const save = jest.fn(async (subject: Subject) => subject);
  const softRemove = jest.fn(async (subject: Subject) => subject);
  const getExists = jest.fn(async () => false);
  const query = jest.fn(async () => NO_REFERENCES);
  const recordAuditEvent = jest.fn(async () => undefined);

  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists,
  };

  const repository = {
    findOne,
    save,
    softRemove,
    create: jest.fn((data: Partial<Subject>) => data as Subject),
    createQueryBuilder: jest.fn(() => queryBuilder),
  } as unknown as Repository<Subject>;

  const service = new SubjectsService(
    repository,
    { query } as unknown as DataSource,
    { recordAuditEvent } as unknown as ActivityLogsService,
  );

  return {
    service,
    findOne,
    save,
    softRemove,
    getExists,
    query,
    recordAuditEvent,
    auditEvents: () => recordAuditEvent.mock.calls.map((call) => call[0] as AuditEvent),
  };
}

const CREATE_DTO = {
  name: 'Physics',
};

describe('SubjectsService — creation', () => {
  it('creates an admin subject as approved and platform-owned', async () => {
    const { service, save } = buildService();

    const subject = await service.create(CREATE_DTO, { actorId: ADMIN, ipAddress: '10.0.0.1' });

    expect(subject.status).toBe(SubjectStatus.APPROVED);
    expect(subject.created_by_teacher_id).toBeNull();
    expect(subject).not.toHaveProperty('grade_level');
    expect(save).toHaveBeenCalled();
  });

  it('creates a teacher subject as pending and owned by that teacher', async () => {
    const { service, auditEvents } = buildService();

    const subject = await service.createByTeacher(TEACHER_A, CREATE_DTO, '10.0.0.2');

    expect(subject.status).toBe(SubjectStatus.PENDING_APPROVAL);
    expect(subject.created_by_teacher_id).toBe(TEACHER_A);

    const [event] = auditEvents();
    expect(event?.action).toBe('subject_created');
    expect(event?.adminId).toBe(TEACHER_A);
    expect(event?.ipAddress).toBe('10.0.0.2');
  });

  it('trims the stored name', async () => {
    const { service } = buildService();

    const subject = await service.createByTeacher(TEACHER_A, {
      ...CREATE_DTO,
      name: '  Physics  ',
    });

    expect(subject.name).toBe('Physics');
  });

  it.each(['الرياضيات', 'Mathematics'])('accepts a single %s subject name', async (name) => {
    const { service } = buildService();

    await expect(service.create({ name })).resolves.toMatchObject({ name });
  });

  it.each(['', '   '])('rejects a blank subject name', async (name) => {
    const { service } = buildService();

    await expect(service.create({ name })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SubjectsService — duplicate names', () => {
  it('rejects a name that differs only by case or whitespace', async () => {
    const { service, getExists } = buildService();
    getExists.mockResolvedValue(true);

    await expect(
      service.createByTeacher(TEACHER_A, { ...CREATE_DTO, name: '  physics ' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('compares case- and whitespace-insensitively against live rows only', async () => {
    const { service, getExists } = buildService();
    const queryBuilder = (
      service as unknown as {
        subjectsRepository: { createQueryBuilder: jest.Mock };
      }
    ).subjectsRepository.createQueryBuilder();

    await service.createByTeacher(TEACHER_A, CREATE_DTO);

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'lower(btrim(s.name)) = lower(btrim(:name))',
      { name: 'Physics' },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('s.deleted_at IS NULL');
    expect(getExists).toHaveBeenCalled();
  });

  it('excludes the row being renamed, so "Physics" → "physics" is allowed', async () => {
    const { service, findOne, getExists } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.PENDING_APPROVAL, created_by_teacher_id: TEACHER_A }),
    );
    const queryBuilder = (
      service as unknown as {
        subjectsRepository: { createQueryBuilder: jest.Mock };
      }
    ).subjectsRepository.createQueryBuilder();

    await service.updateByTeacher('subject-1', TEACHER_A, { name: 'physics' });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('s.id <> :excludeId', {
      excludeId: 'subject-1',
    });
    expect(getExists).toHaveBeenCalled();
  });

  it('maps the uq_subjects_name_ci unique violation to a 409, closing the insert race', async () => {
    const { service, save } = buildService();
    save.mockRejectedValue({ code: '23505', constraint: 'uq_subjects_name_ci' });

    await expect(service.createByTeacher(TEACHER_A, CREATE_DTO)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rethrows an unrelated unique violation untouched', async () => {
    const { service, save } = buildService();
    const unrelated = { code: '23505', constraint: 'uq_something_else' };
    save.mockRejectedValue(unrelated);

    await expect(service.createByTeacher(TEACHER_A, CREATE_DTO)).rejects.toBe(unrelated);
  });
});

describe('SubjectsService — ownership', () => {
  it('404s when the subject does not exist', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(null);

    await expect(service.findOneForTeacher('missing', TEACHER_A)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("403s on another teacher's approved subject", async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.APPROVED, created_by_teacher_id: TEACHER_B }),
    );

    await expect(service.findOneForTeacher('subject-1', TEACHER_A)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("404s — not 403s — on another teacher's pending subject, so drafts stay unenumerable", async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({
        status: SubjectStatus.PENDING_APPROVAL,
        created_by_teacher_id: TEACHER_B,
      }),
    );

    await expect(service.findOneForTeacher('subject-1', TEACHER_A)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the subject to its owner', async () => {
    const { service, findOne } = buildService();
    const owned = buildSubject({
      status: SubjectStatus.PENDING_APPROVAL,
      created_by_teacher_id: TEACHER_A,
    });
    findOne.mockResolvedValue(owned);

    await expect(service.findOneForTeacher('subject-1', TEACHER_A)).resolves.toBe(owned);
  });
});

describe('SubjectsService — teacher edits', () => {
  it.each(['الفيزياء', 'Physics'])('lets an administrator save the single %s name', async (name) => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(buildSubject());

    await expect(service.update('subject-1', { name })).resolves.toMatchObject({ name });
  });

  it.each(['الفيزياء', 'Physics'])('lets the owning teacher save the single %s name', async (name) => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.PENDING_APPROVAL, created_by_teacher_id: TEACHER_A }),
    );

    await expect(service.updateByTeacher('subject-1', TEACHER_A, { name })).resolves.toMatchObject({
      name,
    });
  });

  it('refuses to let a teacher edit their own approved subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.APPROVED, created_by_teacher_id: TEACHER_A }),
    );

    await expect(
      service.updateByTeacher('subject-1', TEACHER_A, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to let a teacher edit a suspended subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.SUSPENDED, created_by_teacher_id: TEACHER_A }),
    );

    await expect(
      service.updateByTeacher('subject-1', TEACHER_A, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('re-submits a rejected subject on edit, clearing the stale reviewer feedback', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({
        status: SubjectStatus.REJECTED,
        created_by_teacher_id: TEACHER_A,
        rejection_reason: 'Duplicate',
        reviewed_by_admin_id: ADMIN,
        reviewed_at: new Date(),
      }),
    );

    const updated = await service.updateByTeacher('subject-1', TEACHER_A, {
      name: 'Physics II',
    });

    expect(updated.status).toBe(SubjectStatus.PENDING_APPROVAL);
    expect(updated.rejection_reason).toBeNull();
    expect(updated.reviewed_by_admin_id).toBeNull();
    expect(updated.reviewed_at).toBeNull();
  });
});

describe('SubjectsService — moderation transitions', () => {
  it('approves a pending subject and records the actor and IP', async () => {
    const { service, findOne, auditEvents } = buildService();
    findOne.mockResolvedValue(
      buildSubject({
        status: SubjectStatus.PENDING_APPROVAL,
        created_by_teacher_id: TEACHER_A,
      }),
    );

    const approved = await service.approve('subject-1', ADMIN, {}, '10.0.0.3');

    expect(approved.status).toBe(SubjectStatus.APPROVED);
    expect(approved.reviewed_by_admin_id).toBe(ADMIN);
    expect(approved.reviewed_at).toBeInstanceOf(Date);

    const [event] = auditEvents();
    expect(event?.action).toBe('subject_approved');
    expect(event?.adminId).toBe(ADMIN);
    expect(event?.ipAddress).toBe('10.0.0.3');
  });

  it('refuses to approve an already-approved subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(buildSubject({ status: SubjectStatus.APPROVED }));

    await expect(service.approve('subject-1', ADMIN, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('persists the reason and reviewer when rejecting', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({
        status: SubjectStatus.PENDING_APPROVAL,
        created_by_teacher_id: TEACHER_A,
      }),
    );

    const rejected = await service.reject('subject-1', ADMIN, { reason: '  Duplicate  ' });

    expect(rejected.status).toBe(SubjectStatus.REJECTED);
    expect(rejected.rejection_reason).toBe('Duplicate');
    expect(rejected.reviewed_by_admin_id).toBe(ADMIN);
  });

  it('suspends an approved subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(buildSubject({ status: SubjectStatus.APPROVED }));

    const suspended = await service.suspend('subject-1', ADMIN, { reason: 'Reported' });

    expect(suspended.status).toBe(SubjectStatus.SUSPENDED);
    expect(suspended.rejection_reason).toBe('Reported');
  });

  it('refuses to suspend a pending subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(buildSubject({ status: SubjectStatus.PENDING_APPROVAL }));

    await expect(
      service.suspend('subject-1', ADMIN, { reason: 'Reported' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reactivates a suspended subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(
      buildSubject({ status: SubjectStatus.SUSPENDED, rejection_reason: 'Reported' }),
    );

    const reactivated = await service.reactivate('subject-1', ADMIN);

    expect(reactivated.status).toBe(SubjectStatus.APPROVED);
    expect(reactivated.rejection_reason).toBeNull();
  });

  it('refuses to reactivate a pending subject', async () => {
    const { service, findOne } = buildService();
    findOne.mockResolvedValue(buildSubject({ status: SubjectStatus.PENDING_APPROVAL }));

    await expect(service.reactivate('subject-1', ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('SubjectsService — deletion', () => {
  it('refuses to delete a subject that content still references', async () => {
    const { service, findOne, query, softRemove } = buildService();
    findOne.mockResolvedValue(buildSubject());
    query.mockResolvedValue([{ ...NO_REFERENCES[0], lessons: '3' }]);

    await expect(service.remove('subject-1')).rejects.toBeInstanceOf(ConflictException);
    expect(softRemove).not.toHaveBeenCalled();
  });

  it('soft-deletes an unreferenced subject and records the event', async () => {
    const { service, findOne, softRemove, auditEvents } = buildService();
    findOne.mockResolvedValue(buildSubject());

    await service.remove('subject-1', { actorId: ADMIN });

    expect(softRemove).toHaveBeenCalled();
    expect(auditEvents()[0]?.action).toBe('subject_deleted');
  });

  it('applies the same reference guard on the teacher delete path', async () => {
    const { service, findOne, query, softRemove } = buildService();
    findOne.mockResolvedValue(
      buildSubject({
        status: SubjectStatus.PENDING_APPROVAL,
        created_by_teacher_id: TEACHER_A,
      }),
    );
    query.mockResolvedValue([{ ...NO_REFERENCES[0], exams: '1' }]);

    await expect(service.removeByTeacher('subject-1', TEACHER_A)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(softRemove).not.toHaveBeenCalled();
  });
});

describe('SubjectsService — audit payloads', () => {
  it('truncates target_name to the 200 chars audit_logs.target_name allows', async () => {
    const { service, auditEvents } = buildService();
    const longName = 'x'.repeat(255);

    await service.createByTeacher(TEACHER_A, { ...CREATE_DTO, name: longName });

    expect(auditEvents()[0]?.targetName).toHaveLength(200);
  });
});
