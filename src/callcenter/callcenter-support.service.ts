import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Brackets, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { AuditEvent } from '../activity-logs/events/audit.events';
import type { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { Complaint } from '../complaints/entities/complaint.entity';
import { ComplaintStatus } from '../complaints/enums/complaint-status.enum';
import { FinancialLedgerEntry, Order, Payment, Settlement } from '../payments/entities';
import { Notification } from '../notifications/entities';
import { biBody } from '../i18n/error-translator.util';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { SessionsService } from '../users/sessions.service';
import { CallCenterUserFilterDto } from './dto/call-center-user-filter.dto';
import { CallCenterFinanceFilterDto } from './dto/call-center-finance-filter.dto';
import { CallCenterNotificationFilterDto } from './dto/call-center-notification-filter.dto';

interface PageFilter {
  page: number;
  limit: number;
}

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
    @InjectRepository(Order) private readonly ordersRepository: Repository<Order>,
    @InjectRepository(Settlement) private readonly settlementsRepository: Repository<Settlement>,
    @InjectRepository(FinancialLedgerEntry)
    private readonly ledgerRepository: Repository<FinancialLedgerEntry>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
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

  /** Explicit finance allowlist; never serializes payment, order, settlement, or ledger entities. */
  public async listFinancePayments(filter: CallCenterFinanceFilterDto) {
    const query = this.ordersRepository
      .createQueryBuilder('order')
      .leftJoin(User, 'student', 'student.id = order.student_id')
      .leftJoin(User, 'teacher', 'teacher.id = order.teacher_id')
      .leftJoin(Payment, 'payment', 'payment.id = order.payment_id')
      .select([
        'order.id AS order_id',
        'order.order_number AS order_number',
        'order.item_type AS item_type',
        'order.product_title_snapshot AS product_title',
        'order.final_amount_minor AS total_amount_minor',
        'order.platform_commission_minor AS platform_commission_minor',
        'order.teacher_earning_minor AS teacher_net_receivable_minor',
        'order.currency AS currency',
        'order.status AS order_status',
        'order.created_at AS created_at',
        'payment.status AS payment_status',
        'student.name AS user_name',
        'teacher.name AS teacher_name',
      ]);
    if (filter.status) query.andWhere('order.status = :status', { status: filter.status });
    if (filter.search?.trim())
      query.andWhere(
        '(order.order_number ILIKE :search OR student.name ILIKE :search OR teacher.name ILIKE :search)',
        { search: `%${filter.search.trim()}%` },
      );
    return await this.rawPage(query, filter, (row) => {
      const { order_id: _orderId, ...payment } = row;
      return {
        ...payment,
        total_amount_minor: Number(payment['total_amount_minor']),
        platform_commission_minor: Number(payment['platform_commission_minor']),
        teacher_net_receivable_minor: Number(payment['teacher_net_receivable_minor']),
      };
    });
  }

  public async listFinanceSettlements(filter: CallCenterFinanceFilterDto) {
    const query = this.settlementsRepository
      .createQueryBuilder('settlement')
      .leftJoin(User, 'teacher', 'teacher.id = settlement.teacher_id')
      .select([
        'settlement.id AS settlement_id',
        'settlement.settlement_number AS settlement_number',
        'teacher.name AS teacher_name',
        'settlement.gross_amount_minor AS total_amount_minor',
        'settlement.deductions_minor AS deductions_minor',
        'settlement.receivable_offset_minor AS receivable_offset_minor',
        'settlement.payout_amount_minor AS teacher_net_receivable_minor',
        'settlement.currency AS currency',
        'settlement.status AS status',
        'settlement.transfer_reference AS financial_reference',
        'settlement.created_at AS created_at',
        'settlement.paid_at AS paid_at',
      ]);
    if (filter.status) query.andWhere('settlement.status = :status', { status: filter.status });
    if (filter.search?.trim())
      query.andWhere('(settlement.settlement_number ILIKE :search OR teacher.name ILIKE :search)', {
        search: `%${filter.search.trim()}%`,
      });
    return await this.rawPage(query, filter, (row) => {
      const { settlement_id: _settlementId, ...settlement } = row;
      return {
        ...settlement,
        total_amount_minor: Number(settlement['total_amount_minor']),
        deductions_minor: Number(settlement['deductions_minor']),
        receivable_offset_minor: Number(settlement['receivable_offset_minor']),
        teacher_net_receivable_minor: Number(settlement['teacher_net_receivable_minor']),
      };
    });
  }

  public async listTeacherReceivables(filter: CallCenterFinanceFilterDto) {
    const query = this.ledgerRepository
      .createQueryBuilder('entry')
      .leftJoin(User, 'teacher', 'teacher.id = entry.teacher_id')
      .select('entry.teacher_id', 'teacher_id')
      .addSelect('teacher.name', 'teacher_name')
      .addSelect('entry.currency', 'currency')
      .addSelect('MAX(entry.created_at)', 'created_at')
      .addSelect(
        "COALESCE(SUM(CASE WHEN entry.account = 'teacher_payable_available' THEN CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END), 0)",
        'teacher_net_receivable_minor',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN entry.account = 'platform_receivable' THEN CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END), 0)",
        'platform_receivable_minor',
      )
      .where('entry.teacher_id IS NOT NULL')
      .groupBy('entry.teacher_id')
      .addGroupBy('teacher.name')
      .addGroupBy('entry.currency');
    if (filter.search?.trim())
      query.having('teacher.name ILIKE :search', { search: `%${filter.search.trim()}%` });
    const totalQuery = this.ledgerRepository
      .createQueryBuilder('entry')
      .leftJoin(User, 'teacher', 'teacher.id = entry.teacher_id')
      .select('COUNT(DISTINCT (entry.teacher_id, entry.currency))', 'total')
      .where('entry.teacher_id IS NOT NULL');
    if (filter.search?.trim()) {
      totalQuery.andWhere('teacher.name ILIKE :search', {
        search: `%${filter.search.trim()}%`,
      });
    }
    const totalResult = await totalQuery.getRawOne<{ total: string }>();
    return await this.rawPage(
      query,
      filter,
      (row) => {
        const { teacher_id: _teacherId, ...receivable } = row;
        return {
          ...receivable,
          teacher_net_receivable_minor: Number(receivable['teacher_net_receivable_minor']),
          platform_receivable_minor: Number(receivable['platform_receivable_minor']),
        };
      },
      Number(totalResult?.total ?? 0),
    );
  }

  /** Read-only ticket dispatch projection; bodies and recipient details are never selected. */
  public async listSupportNotifications(filter: CallCenterNotificationFilterDto) {
    const query = this.notificationsRepository
      .createQueryBuilder('notification')
      .select([
        "notification.data -> 'support_ticket' ->> 'number' AS ticket_number",
        "notification.data -> 'support_ticket' ->> 'event' AS event",
        'notification.status AS status',
        'notification.attempts AS attempts',
        'notification.sent_at AS sent_at',
        'notification.delivered_at AS delivered_at',
      ])
      .where("notification.data ? 'support_ticket'");
    if (filter.status?.trim()) {
      query.andWhere('notification.status = :status', { status: filter.status.trim() });
    }
    if (filter.search?.trim()) {
      query.andWhere("notification.data -> 'support_ticket' ->> 'number' ILIKE :search", {
        search: `%${filter.search.trim()}%`,
      });
    }
    return await this.rawPage(
      query,
      filter,
      (row) => ({ ...row, attempts: Number(row['attempts']) }),
      undefined,
      'sent_at',
    );
  }

  /** Aggregate-only support report; no complaint, finance, or user entity is serialized. */
  public async supportReport(): Promise<Record<string, unknown>> {
    // Five independent aggregates, each its own statement (no GROUPING SETS, no
    // shared join): issued together so the response waits for the slowest, not the sum.
    const [statusRows, roleRows, typeRows, times, delayed] = await Promise.all([
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .select('complaint.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('complaint.deleted_at IS NULL')
        .groupBy('complaint.status')
        .getRawMany<{ status: string; count: string }>(),
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .select('complaint.complainant_role', 'role')
        .addSelect('COUNT(*)', 'count')
        .where('complaint.deleted_at IS NULL')
        .groupBy('complaint.complainant_role')
        .getRawMany<{ role: string; count: string }>(),
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .select('complaint.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('complaint.deleted_at IS NULL')
        .groupBy('complaint.type')
        .getRawMany<{ type: string; count: string }>(),
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .select(
          'AVG(EXTRACT(EPOCH FROM (complaint.first_response_at - complaint.created_at)))',
          'first',
        )
        .addSelect(
          'AVG(EXTRACT(EPOCH FROM (complaint.resolved_at - complaint.created_at)))',
          'resolution',
        )
        .where('complaint.deleted_at IS NULL')
        .getRawOne<{ first: string | null; resolution: string | null }>(),
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .where('complaint.deleted_at IS NULL')
        .andWhere('complaint.status NOT IN (:...terminal)', {
          terminal: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
        })
        .andWhere(
          '(complaint.first_response_due_at <= NOW() OR complaint.resolution_due_at <= NOW())',
        )
        .getCount(),
    ]);
    return {
      by_status: statusRows.map((row) => ({ status: row.status, count: Number(row.count) })),
      by_complainant_role: roleRows.map((row) => ({ role: row.role, count: Number(row.count) })),
      by_type: typeRows.map((row) => ({ type: row.type, count: Number(row.count) })),
      delayed,
      average_first_response_seconds: times?.first ? Math.round(Number(times.first)) : null,
      average_resolution_seconds: times?.resolution ? Math.round(Number(times.resolution)) : null,
    };
  }

  public async slaSummary(): Promise<Record<string, unknown>> {
    const now = new Date();
    const [firstResponseOverdue, resolutionOverdue] = await Promise.all([
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .where('complaint.status NOT IN (:...terminal)', {
          terminal: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
        })
        .andWhere('complaint.first_response_at IS NULL')
        .andWhere('complaint.first_response_due_at <= :now', { now })
        .getCount(),
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .where('complaint.status NOT IN (:...terminal)', {
          terminal: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
        })
        .andWhere('complaint.resolution_due_at <= :now', { now })
        .getCount(),
    ]);
    return { first_response_overdue: firstResponseOverdue, resolution_overdue: resolutionOverdue };
  }

  /**
   * DEF-012: the counts the dashboard landing page needs that `supportReport`/
   * `slaSummary` don't already provide — workload split by agent and
   * near-breach (not yet overdue) SLA risk. `warningWindowHours` mirrors the
   * same active SLA policy the `sla()` endpoint already resolves, so "approaching"
   * uses one canonical warning window rather than a second, divergent constant.
   */
  public async dashboardCounts(
    agentId: string,
    warningWindowHours: number,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const warningHorizon = new Date(now.getTime() + warningWindowHours * 60 * 60 * 1000);
    const terminal = [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED];
    const openBase = () =>
      this.complaintsRepository
        .createQueryBuilder('complaint')
        .where('complaint.deleted_at IS NULL')
        .andWhere('complaint.status NOT IN (:...terminal)', { terminal });

    const [
      openTickets,
      assignedToMe,
      unassignedTickets,
      firstResponseApproaching,
      resolutionApproaching,
    ] = await Promise.all([
      openBase().getCount(),
      openBase().andWhere('complaint.assigned_agent_id = :agentId', { agentId }).getCount(),
      openBase().andWhere('complaint.assigned_agent_id IS NULL').getCount(),
      openBase()
        .andWhere('complaint.first_response_at IS NULL')
        .andWhere('complaint.first_response_due_at > :now', { now })
        .andWhere('complaint.first_response_due_at <= :horizon', { horizon: warningHorizon })
        .getCount(),
      openBase()
        .andWhere('complaint.resolution_due_at > :now', { now })
        .andWhere('complaint.resolution_due_at <= :horizon', { horizon: warningHorizon })
        .getCount(),
    ]);

    return {
      open_tickets: openTickets,
      assigned_to_me: assignedToMe,
      unassigned_tickets: unassignedTickets,
      first_response_approaching: firstResponseApproaching,
      resolution_approaching: resolutionApproaching,
    };
  }

  private async rawPage(
    query: SelectQueryBuilder<ObjectLiteral>,
    filter: PageFilter,
    map: (row: Record<string, unknown>) => Record<string, unknown>,
    totalOverride?: number,
    orderColumn = 'created_at',
  ) {
    const total = totalOverride ?? (await query.getCount());
    const data = await query
      .orderBy(orderColumn, 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getRawMany();
    const totalPages = Math.ceil(total / filter.limit);
    return {
      data: data.map(map),
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
