import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Not, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { AuditEvent } from '../activity-logs/events/audit.events';
import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { SanitizationService } from '../common/sanitization/sanitization.service';
import { biBody } from '../i18n/error-translator.util';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import {
  AssignComplaintDto,
  ComplaintFilterDto,
  CreateComplaintDto,
  CreateComplaintMessageDto,
  CreateSupportMessageDto,
  RespondComplaintDto,
  TransitionComplaintDto,
} from './dto';
import { ComplaintMessage } from './entities/complaint-message.entity';
import { ComplaintStatusPeriod } from './entities/complaint-status-period.entity';
import { Complaint } from './entities/complaint.entity';
import { ComplaintMessageKind } from './enums/complaint-message-kind.enum';
import { ComplaintStatus } from './enums/complaint-status.enum';

type ComplainantRole = Extract<UserRole, UserRole.STUDENT | UserRole.TEACHER>;

interface TicketDetail {
  ticket: Complaint;
  messages: ComplaintMessage[];
  statusPeriods: ComplaintStatusPeriod[];
}

class SupportTicketAuditEvent extends AuditEvent {}

const SUPPORT_TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  [ComplaintStatus.NEW]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
  [ComplaintStatus.PENDING]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
  [ComplaintStatus.IN_PROGRESS]: [ComplaintStatus.WAITING_FOR_USER, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
  [ComplaintStatus.WAITING_FOR_USER]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
  [ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
  [ComplaintStatus.ESCALATED]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.RESOLVED],
  [ComplaintStatus.RESOLVED]: [ComplaintStatus.CLOSED, ComplaintStatus.REOPENED],
  [ComplaintStatus.CLOSED]: [ComplaintStatus.REOPENED],
  [ComplaintStatus.REOPENED]: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW, ComplaintStatus.ESCALATED, ComplaintStatus.RESOLVED],
};

@Injectable()
export class ComplaintsService {
  constructor(
    @InjectRepository(Complaint)
    private readonly complaintsRepository: Repository<Complaint>,
    @InjectRepository(ComplaintMessage)
    private readonly complaintMessagesRepository: Repository<ComplaintMessage>,
    @InjectRepository(ComplaintStatusPeriod)
    private readonly complaintStatusPeriodsRepository: Repository<ComplaintStatusPeriod>,
    @InjectRepository(StudentProfile)
    private readonly studentProfilesRepository: Repository<StudentProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly activityLogsService: ActivityLogsService,
    private readonly sanitizationService: SanitizationService,
  ) {}

  public async createComplaint(studentUserId: string, dto: CreateComplaintDto): Promise<Complaint> {
    const studentProfile = await this.studentProfilesRepository.findOne({
      where: { user_id: studentUserId },
    });
    if (!studentProfile) {
      throw new NotFoundException(biBody('Student profile not found', 'ملف الطالب غير موجود'));
    }
    return await this.createTicket(studentUserId, UserRole.STUDENT, dto, studentUserId);
  }

  public async createTeacherComplaint(teacherUserId: string, dto: CreateComplaintDto): Promise<Complaint> {
    return await this.createTicket(teacherUserId, UserRole.TEACHER, dto, null);
  }

  public async getStudentComplaints(studentId: string, page = 1, limit = 20): Promise<PaginatedResponse<Complaint>> {
    return await this.getComplainantTickets(studentId, page, limit);
  }

  public async getTeacherComplaints(teacherId: string, page = 1, limit = 20): Promise<PaginatedResponse<Complaint>> {
    return await this.getComplainantTickets(teacherId, page, limit);
  }

  public async getOwnTicket(complaintId: string, complainantId: string): Promise<TicketDetail> {
    const ticket = await this.complaintsRepository.findOne({
      where: { id: complaintId, complainant_id: complainantId },
    });
    if (!ticket) {
      // A 404, rather than 403, avoids confirming another customer's ticket ID.
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    const [messages, statusPeriods] = await Promise.all([
      this.complaintMessagesRepository.find({
        where: { complaint_id: ticket.id, kind: Not(ComplaintMessageKind.INTERNAL_NOTE) },
        order: { created_at: 'ASC', id: 'ASC' },
      }),
      this.complaintStatusPeriodsRepository.find({
        where: { complaint_id: ticket.id },
        order: { started_at: 'ASC', id: 'ASC' },
      }),
    ]);
    return { ticket, messages, statusPeriods };
  }

  public async getAllComplaints(filter: ComplaintFilterDto): Promise<PaginatedResponse<Complaint>> {
    const queryBuilder = this.buildTicketQuery(filter)
      .leftJoinAndSelect('complaint.student', 'student')
      .leftJoinAndSelect('complaint.admin', 'admin')
      .leftJoinAndSelect('complaint.complainant', 'complainant')
      .leftJoinAndSelect('complaint.assigned_agent', 'assigned_agent');

    const [complaints, total] = await queryBuilder
      .orderBy('complaint.created_at', 'DESC')
      .addOrderBy('complaint.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    return this.toPaginatedResponse(complaints, total, filter.page, filter.limit);
  }

  /**
   * Call Center ticket reads intentionally omit user relations. The planned
   * Phase 5 support lookup facade will expose a permission-scoped, sanitized
   * user projection rather than leaking complete User entities here.
   */
  public async getSupportTickets(filter: ComplaintFilterDto): Promise<PaginatedResponse<Complaint>> {
    const [complaints, total] = await this.buildTicketQuery(filter)
      .orderBy('complaint.created_at', 'DESC')
      .addOrderBy('complaint.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();
    return this.toPaginatedResponse(complaints, total, filter.page, filter.limit);
  }

  public async getSupportTicket(complaintId: string): Promise<TicketDetail> {
    const ticket = await this.complaintsRepository.findOne({
      where: { id: complaintId },
    });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    const [messages, statusPeriods] = await Promise.all([
      this.complaintMessagesRepository.find({
        where: { complaint_id: ticket.id },
        order: { created_at: 'ASC', id: 'ASC' },
      }),
      this.complaintStatusPeriodsRepository.find({
        where: { complaint_id: ticket.id },
        order: { started_at: 'ASC', id: 'ASC' },
      }),
    ]);
    return { ticket, messages, statusPeriods };
  }

  public async addComplainantMessage(
    complaintId: string,
    complainantId: string,
    dto: CreateComplaintMessageDto,
  ): Promise<ComplaintMessage> {
    await this.getOwnTicket(complaintId, complainantId);
    const message = await this.saveMessage(
      complaintId,
      complainantId,
      ComplaintMessageKind.COMPLAINANT_MESSAGE,
      dto.body,
    );
    const ticket = await this.complaintsRepository.findOneByOrFail({ id: complaintId });
    if (ticket.status === ComplaintStatus.WAITING_FOR_USER) {
      await this.transitionWithoutExpectedVersion(ticket, ComplaintStatus.IN_PROGRESS, 'Complainant replied');
    }
    await this.audit(complainantId, 'support_ticket_message_added', ticket, {
      kind: ComplaintMessageKind.COMPLAINANT_MESSAGE,
    });
    return message;
  }

  public async addSupportMessage(
    complaintId: string,
    agentId: string,
    dto: CreateSupportMessageDto,
  ): Promise<ComplaintMessage> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    const kind = dto.internal ? ComplaintMessageKind.INTERNAL_NOTE : ComplaintMessageKind.AGENT_REPLY;
    const message = await this.saveMessage(complaintId, agentId, kind, dto.body);
    if (kind === ComplaintMessageKind.AGENT_REPLY && ticket.first_response_at === null) {
      await this.complaintsRepository.update(ticket.id, { first_response_at: new Date() });
    }
    await this.audit(agentId, 'support_ticket_message_added', ticket, { kind });
    return message;
  }

  public async assignTicket(
    complaintId: string,
    actorId: string,
    dto: AssignComplaintDto,
  ): Promise<Complaint> {
    const agent = await this.usersRepository.findOneBy({ id: dto.agent_id });
    if (!agent || agent.role !== UserRole.CALL_CENTER || !agent.is_active) {
      throw new BadRequestException('The assigned user must be an active Call Center employee.');
    }
    const ticket = await this.requireExpectedVersion(complaintId, dto.version);
    const result = await this.complaintsRepository
      .createQueryBuilder()
      .update(Complaint)
      .set({ assigned_agent_id: agent.id, version: () => '"version" + 1' })
      .where('id = :id AND version = :version', { id: ticket.id, version: dto.version })
      .returning('*')
      .execute();
    if (result.affected !== 1) {
      throw new ConflictException('This ticket was updated by another employee. Refresh and try again.');
    }
    const updated = result.raw[0] as Complaint;
    await this.audit(actorId, 'support_ticket_assigned', updated, { assignedAgentId: agent.id });
    return updated;
  }

  public async transitionTicket(
    complaintId: string,
    actorId: string,
    dto: TransitionComplaintDto,
  ): Promise<Complaint> {
    const ticket = await this.requireExpectedVersion(complaintId, dto.version);
    if (!SUPPORT_TRANSITIONS[ticket.status].includes(dto.status)) {
      throw new BadRequestException(`Ticket status ${ticket.status} cannot transition to ${dto.status}.`);
    }
    return await this.transitionWithExpectedVersion(ticket, actorId, dto);
  }

  /** Existing admin endpoint adapter: preserve its one-reply-and-resolve behavior. */
  public async respondToComplaint(complaintId: string, adminId: string, dto: RespondComplaintDto): Promise<Complaint> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    await this.saveMessage(complaintId, adminId, ComplaintMessageKind.AGENT_REPLY, dto.admin_response);
    ticket.admin_response = this.sanitizationService.sanitizeStrict(dto.admin_response);
    ticket.admin_id = adminId;
    ticket.responded_at = new Date();
    if (ticket.first_response_at === null) {
      ticket.first_response_at = ticket.responded_at;
    }
    const responded = await this.complaintsRepository.save(ticket);
    const current = await this.complaintsRepository.findOneByOrFail({ id: complaintId });
    const updated = await this.transitionWithoutExpectedVersion(current, ComplaintStatus.RESOLVED, 'Admin response');
    await this.notificationsService.create({
      user_id: ticket.complainant_id,
      type: NotificationType.CUSTOM,
      title: 'Complaint Response',
      message: `Your complaint "${ticket.subject}" has been responded to. Please check the app for details.`,
      send_sms: true,
    });
    await this.audit(adminId, 'support_ticket_admin_response', updated, { legacyAdminResponse: true });
    return responded.status === ComplaintStatus.RESOLVED ? responded : updated;
  }

  private async createTicket(
    complainantId: string,
    complainantRole: ComplainantRole,
    dto: CreateComplaintDto,
    legacyStudentId: string | null,
  ): Promise<Complaint> {
    const ticketNumber = await this.nextTicketNumber();
    const complaint = this.complaintsRepository.create({
      student_id: legacyStudentId,
      complainant_id: complainantId,
      complainant_role: complainantRole,
      ticket_number: ticketNumber,
      type: dto.type,
      target_id: dto.target_id ?? null,
      subject: this.sanitizationService.sanitizeStrict(dto.subject),
      description: this.sanitizationService.sanitizeStrict(dto.description),
      status: ComplaintStatus.NEW,
    });
    const saved = await this.complaintsRepository.save(complaint);
    await this.complaintStatusPeriodsRepository.save(this.complaintStatusPeriodsRepository.create({
      complaint_id: saved.id,
      status: saved.status,
      started_at: saved.created_at,
      ended_at: null,
    }));
    await this.audit(complainantId, 'support_ticket_created', saved, { complainantRole });
    return saved;
  }

  private async getComplainantTickets(
    complainantId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<Complaint>> {
    const [complaints, total] = await this.complaintsRepository.findAndCount({
      where: { complainant_id: complainantId },
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.toPaginatedResponse(complaints, total, page, limit);
  }

  private buildTicketQuery(filter: ComplaintFilterDto) {
    const queryBuilder = this.complaintsRepository.createQueryBuilder('complaint');
    if (filter.status !== undefined) {
      queryBuilder.andWhere('complaint.status = :status', { status: filter.status });
    }
    if (filter.type !== undefined) {
      queryBuilder.andWhere('complaint.type = :type', { type: filter.type });
    }
    if (filter.assigned_agent_id !== undefined) {
      queryBuilder.andWhere('complaint.assigned_agent_id = :assignedAgentId', {
        assignedAgentId: filter.assigned_agent_id,
      });
    }
    if (filter.search !== undefined && filter.search.trim() !== '') {
      queryBuilder.andWhere('(complaint.ticket_number ILIKE :search OR complaint.subject ILIKE :search)', {
        search: `%${filter.search.trim()}%`,
      });
    }
    return queryBuilder;
  }

  private toPaginatedResponse<T>(data: T[], total: number, page: number, limit: number): PaginatedResponse<T> {
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
    return { data, meta };
  }

  private async saveMessage(
    complaintId: string,
    authorId: string,
    kind: ComplaintMessageKind,
    body: string,
  ): Promise<ComplaintMessage> {
    return await this.complaintMessagesRepository.save(this.complaintMessagesRepository.create({
      complaint_id: complaintId,
      author_id: authorId,
      kind,
      body: this.sanitizationService.sanitizeStrict(body),
    }));
  }

  private async requireExpectedVersion(complaintId: string, expectedVersion: number): Promise<Complaint> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    if (ticket.version !== expectedVersion) {
      throw new ConflictException('This ticket was updated by another employee. Refresh and try again.');
    }
    return ticket;
  }

  private async transitionWithExpectedVersion(
    ticket: Complaint,
    actorId: string,
    dto: TransitionComplaintDto,
  ): Promise<Complaint> {
    const now = new Date();
    const transitionValues: Omit<Partial<Complaint>, 'version'> = {
      status: dto.status,
      ...(dto.status === ComplaintStatus.RESOLVED ? { resolved_at: now, resolution: dto.resolution ?? null } : {}),
      ...(dto.status === ComplaintStatus.CLOSED ? { closed_at: now, close_reason: dto.reason } : {}),
      ...(dto.status === ComplaintStatus.ESCALATED ? { escalated_at: now } : {}),
      ...(dto.status === ComplaintStatus.REOPENED ? { reopen_count: ticket.reopen_count + 1, closed_at: null } : {}),
    };
    const result = await this.complaintsRepository
      .createQueryBuilder()
      .update(Complaint)
      .set({ ...transitionValues, version: () => '"version" + 1' })
      .where('id = :id AND version = :version', { id: ticket.id, version: ticket.version })
      .returning('*')
      .execute();
    if (result.affected !== 1) {
      throw new ConflictException('This ticket was updated by another employee. Refresh and try again.');
    }
    const updated = result.raw[0] as Complaint;
    await this.complaintStatusPeriodsRepository
      .createQueryBuilder()
      .update(ComplaintStatusPeriod)
      .set({ ended_at: now })
      .where('complaint_id = :complaintId AND ended_at IS NULL', { complaintId: ticket.id })
      .execute();
    await this.complaintStatusPeriodsRepository.save(this.complaintStatusPeriodsRepository.create({
      complaint_id: ticket.id,
      status: dto.status,
      started_at: now,
      ended_at: null,
    }));
    await this.audit(actorId, 'support_ticket_status_changed', updated, {
      from: ticket.status,
      to: dto.status,
      reason: dto.reason ?? null,
    });
    return updated;
  }

  private async transitionWithoutExpectedVersion(
    ticket: Complaint,
    status: ComplaintStatus,
    reason: string,
  ): Promise<Complaint> {
    return await this.transitionWithExpectedVersion(ticket, ticket.admin_id ?? ticket.assigned_agent_id ?? ticket.complainant_id, {
      status,
      version: ticket.version,
      reason,
    });
  }

  private async nextTicketNumber(): Promise<string> {
    try {
      const rows = await this.complaintsRepository.query(
        "SELECT nextval('complaint_ticket_number_seq') AS value",
      ) as Array<{ value: string | number }>;
      const value = Number(rows[0]?.value);
      if (!Number.isSafeInteger(value)) {
        throw new ConflictException('Unable to allocate a ticket number.');
      }
      return `CC-${String(new Date().getUTCFullYear())}-${String(value).padStart(6, '0')}`;
    } catch (error: unknown) {
      // The production migration creates the sequence. TypeORM's isolated
      // synchronize-only test database intentionally has no migrations table;
      // retain a collision-resistant local fallback so its live API contract is
      // still exercised without executing production migration history there.
      if ((error as { code?: unknown }).code !== '42P01') {
        throw error;
      }
      return `CC-${String(new Date().getUTCFullYear())}-${String(Date.now())}-${Math.random().toString().slice(2, 8)}`;
    }
  }

  private async audit(actorId: string, action: string, ticket: Complaint, details: Record<string, unknown>): Promise<void> {
    await this.activityLogsService.recordAuditEvent(new SupportTicketAuditEvent(
      actorId,
      action,
      'support_ticket',
      ticket.id,
      ticket.ticket_number,
      details,
    ));
  }
}
