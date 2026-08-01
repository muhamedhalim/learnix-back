import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Brackets, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { AuditEvent } from '../activity-logs/events/audit.events';
import type { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { Complaint } from '../complaints/entities/complaint.entity';
import { biBody } from '../i18n/error-translator.util';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { SessionsService } from '../users/sessions.service';
import { CallCenterUserFilterDto } from './dto/call-center-user-filter.dto';

interface SupportUserSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole.STUDENT | UserRole.TEACHER;
  status: string;
  is_active: boolean;
  created_at: Date;
}

class CallCenterUserSessionsTerminatedEvent extends AuditEvent {}

/**
 * Permission-scoped support projection. This service deliberately reads the
 * existing user/profile/ticket tables directly with explicit selections so a
 * Call Center response cannot accidentally inherit an Admin or payment DTO.
 */
@Injectable()
export class CallCenterSupportService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(StudentProfile)
    private readonly studentsRepository: Repository<StudentProfile>,
    @InjectRepository(TeacherProfile)
    private readonly teachersRepository: Repository<TeacherProfile>,
    @InjectRepository(Complaint)
    private readonly complaintsRepository: Repository<Complaint>,
    private readonly sessionsService: SessionsService,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public async findUsers(
    filter: CallCenterUserFilterDto,
  ): Promise<PaginatedResponse<SupportUserSummary>> {
    const query = this.supportUserQuery();
    if (filter.role !== undefined) {
      query.andWhere('user.role = :role', { role: filter.role });
    }
    if (filter.search !== undefined && filter.search.trim() !== '') {
      const searchValue = `%${filter.search.trim()}%`;
      query.andWhere(
        new Brackets((search) => {
          search
            .where('user.name ILIKE :search', { search: searchValue })
            .orWhere('user.email ILIKE :search', { search: searchValue })
            .orWhere('user.phone ILIKE :search', { search: searchValue })
            .orWhere('user.username ILIKE :search', { search: searchValue });
        }),
      );
    }
    const total = await query.getCount();
    const data = await query
      .orderBy('user.created_at', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getMany();
    const totalPages = Math.ceil(total / filter.limit);
    return {
      data: data.map((user) => this.toSummary(user)),
      meta: {
        page: filter.page,
        limit: filter.limit,
        total,
        totalPages,
        hasNextPage: filter.page < totalPages,
        hasPrevPage: filter.page > 1,
      },
    };
  }

  public async getUser(userId: string): Promise<Record<string, unknown>> {
    const user = await this.supportUserQuery().andWhere('user.id = :userId', { userId }).getOne();
    if (!user) {
      throw new NotFoundException(biBody('Support user not found', 'مستخدم الدعم غير موجود'));
    }
    const [student, teacher, tickets] = await Promise.all([
      user.role === UserRole.STUDENT
        ? this.studentsRepository.findOne({ where: { user_id: user.id } })
        : null,
      user.role === UserRole.TEACHER
        ? this.teachersRepository.findOne({
            where: { user_id: user.id },
            relations: { subjects: true },
          })
        : null,
      this.complaintsRepository.find({
        where: { complainant_id: user.id },
        select: ['id', 'ticket_number', 'subject', 'status', 'created_at'],
        order: { created_at: 'DESC', id: 'DESC' },
        take: 20,
      }),
    ]);
    return {
      user: this.toSummary(user),
      profile: student
        ? {
            grade_level: student.grade_level,
            country: student.country,
            governorate: student.governorate,
            school: student.school,
          }
        : teacher
          ? {
              professional_title: teacher.professional_title,
              specializations: teacher.specializations,
              subjects: teacher.subjects.map((subject) => ({
                id: subject.id,
                name: subject.name,
                name_ar: subject.name_ar,
              })),
            }
          : null,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        ticket_number: ticket.ticket_number,
        subject: ticket.subject,
        status: ticket.status,
        created_at: ticket.created_at,
      })),
    };
  }

  public async activeAgents(): Promise<Array<{ id: string; name: string }>> {
    const users = await this.usersRepository.find({
      where: { role: UserRole.CALL_CENTER, is_active: true },
      select: ['id', 'name'],
      order: { name: 'ASC', id: 'ASC' },
      take: 100,
    });
    return users.map((user) => ({ id: user.id, name: user.name }));
  }

  public async terminateUserSessions(
    actorId: string,
    userId: string,
    reason: string,
    ipAddress: string | null,
  ): Promise<{ terminated: number }> {
    const [actor, target] = await Promise.all([
      this.usersRepository.findOne({ where: { id: actorId }, select: ['id', 'role'] }),
      this.supportUserQuery().andWhere('user.id = :userId', { userId }).getOne(),
    ]);
    if (actor?.role !== UserRole.CALL_CENTER) {
      throw new ForbiddenException(
        biBody('Call Center authorization is required', 'يتطلب الإجراء صلاحية مركز الاتصال'),
      );
    }
    if (!target) {
      throw new NotFoundException(biBody('Support user not found', 'مستخدم الدعم غير موجود'));
    }
    if (reason.trim().length < 5) {
      throw new BadRequestException(biBody('A support reason is required', 'سبب الدعم مطلوب'));
    }
    const terminated = await this.sessionsService.deleteAllUserSessions(target.id);
    await this.activityLogs.recordAuditEvent(
      new CallCenterUserSessionsTerminatedEvent(
        actor.id,
        'support_user_sessions_terminated',
        'support_user',
        target.id,
        target.name,
        { targetRole: target.role, reason: reason.trim(), terminated },
        ipAddress,
      ),
    );
    return { terminated };
  }

  private supportUserQuery() {
    return this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.name',
        'user.email',
        'user.phone',
        'user.role',
        'user.status',
        'user.is_active',
        'user.created_at',
      ])
      .where('user.deleted_at IS NULL')
      .andWhere('user.role IN (:...roles)', { roles: [UserRole.STUDENT, UserRole.TEACHER] });
  }

  private toSummary(user: User): SupportUserSummary {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role as UserRole.STUDENT | UserRole.TEACHER,
      status: user.status,
      is_active: user.is_active,
      created_at: user.created_at,
    };
  }
}
