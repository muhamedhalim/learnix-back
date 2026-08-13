import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Not, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { AuditEvent } from '../activity-logs/events/audit.events';
import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { SanitizationService } from '../common/sanitization/sanitization.service';
import { biBody } from '../i18n/error-translator.util';
import { NotificationsService } from '../notifications/services/notifications.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { StorageService } from '../storage/storage.service';
import type { StoredObject } from '../storage/storage.interface';
import { UploadService } from '../uploads/upload.service';
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
import { ComplaintAttachment } from './entities/complaint-attachment.entity';
import { ComplaintStatusPeriod } from './entities/complaint-status-period.entity';
import { Complaint } from './entities/complaint.entity';
import { ComplaintMessageKind } from './enums/complaint-message-kind.enum';
import { ComplaintStatus } from './enums/complaint-status.enum';
import { SupportSlaService } from './support-sla.service';

type ComplainantRole = Extract<UserRole, UserRole.STUDENT | UserRole.TEACHER>;
type SupportActorRole = 'admin' | 'call_center';

interface TicketDetail {
  ticket: Complaint | Record<string, unknown>;
  attachments?: ComplaintAttachment[];
  messages: ComplaintMessage[];
  statusPeriods: ComplaintStatusPeriod[];
}

interface SupportAttachmentDownload {
  attachment: ComplaintAttachment;
  object: StoredObject;
}

interface SupportAttachmentResponse {
  id: string;
  original_filename: string;
  mime_type: string;
  size: string;
  created_at: Date;
}

class SupportTicketAuditEvent extends AuditEvent {}

const SUPPORT_TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  [ComplaintStatus.NEW]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.PENDING]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.IN_PROGRESS]: [
    ComplaintStatus.WAITING_FOR_USER,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.WAITING_FOR_USER]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.ESCALATED]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.RESOLVED,
  ],
  [ComplaintStatus.RESOLVED]: [ComplaintStatus.CLOSED, ComplaintStatus.REOPENED],
  [ComplaintStatus.CLOSED]: [ComplaintStatus.REOPENED],
  [ComplaintStatus.REOPENED]: [
    ComplaintStatus.IN_PROGRESS,
    ComplaintStatus.WAITING_FOR_INTERNAL_REVIEW,
    ComplaintStatus.ESCALATED,
    ComplaintStatus.RESOLVED,
  ],
};

@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger(ComplaintsService.name);

  constructor(
    @InjectRepository(Complaint)
    private readonly complaintsRepository: Repository<Complaint>,
    @InjectRepository(ComplaintMessage)
    private readonly complaintMessagesRepository: Repository<ComplaintMessage>,
    @InjectRepository(ComplaintAttachment)
    private readonly complaintAttachmentsRepository: Repository<ComplaintAttachment>,
    @InjectRepository(ComplaintStatusPeriod)
    private readonly complaintStatusPeriodsRepository: Repository<ComplaintStatusPeriod>,
    @InjectRepository(StudentProfile)
    private readonly studentProfilesRepository: Repository<StudentProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    private readonly notificationsService: NotificationsService,
    private readonly activityLogsService: ActivityLogsService,
    private readonly sanitizationService: SanitizationService,
    private readonly uploads: UploadService,
    private readonly storage: StorageService,
    private readonly supportSla: SupportSlaService,
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

  public async createTeacherComplaint(
    teacherUserId: string,
    dto: CreateComplaintDto,
  ): Promise<Complaint> {
    return await this.createTicket(teacherUserId, UserRole.TEACHER, dto, null);
  }

  public async getStudentComplaints(
    studentId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<Complaint>> {
    return await this.getComplainantTickets(studentId, page, limit);
  }

  public async getTeacherComplaints(
    teacherId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<Complaint>> {
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

  public async getAllComplaints(
    filter: ComplaintFilterDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
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

    return this.toPaginatedResponse(
      complaints.map((complaint) => this.toSafeSupportTicket(complaint)),
      total,
      filter.page,
      filter.limit,
    );
  }

  /**
   * Call Center ticket reads intentionally omit user relations. The planned
   * Phase 5 support lookup facade will expose a permission-scoped, sanitized
   * user projection rather than leaking complete User entities here.
   */
  public async getSupportTickets(
    filter: ComplaintFilterDto,
    actorId?: string,
    actorRole?: SupportActorRole,
  ): Promise<PaginatedResponse<Complaint>> {
    const query = this.buildTicketQuery(filter);
    if (actorRole === UserRole.CALL_CENTER && actorId !== undefined) {
      query.andWhere(
        '(complaint.assigned_agent_id IS NULL OR complaint.assigned_agent_id = :supportActorId)',
        { supportActorId: actorId },
      );
    }
    const [complaints, total] = await query
      .orderBy('complaint.created_at', 'DESC')
      .addOrderBy('complaint.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();
    return this.toPaginatedResponse(complaints, total, filter.page, filter.limit);
  }

  public async getSupportTicket(
    complaintId: string,
    actorId?: string,
    actorRole?: SupportActorRole,
  ): Promise<TicketDetail> {
    const ticket = await this.complaintsRepository.findOne({
      where: { id: complaintId },
      relations: { complainant: true, assigned_agent: true },
    });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    this.requireSupportAccess(ticket, actorId, actorRole, true);
    const [attachments, messages, statusPeriods] = await Promise.all([
      this.complaintAttachmentsRepository.find({
        where: { complaint_id: ticket.id },
        order: { created_at: 'ASC', id: 'ASC' },
      }),
      this.complaintMessagesRepository.find({
        where: { complaint_id: ticket.id },
        order: { created_at: 'ASC', id: 'ASC' },
      }),
      this.complaintStatusPeriodsRepository.find({
        where: { complaint_id: ticket.id },
        order: { started_at: 'ASC', id: 'ASC' },
      }),
    ]);
    return {
      ticket: this.toSafeSupportTicket(ticket),
      attachments,
      messages,
      statusPeriods,
    };
  }

  public async addSupportAttachment(
    complaintId: string,
    agentId: string,
    actorRole: SupportActorRole,
    file: Express.Multer.File,
  ): Promise<SupportAttachmentResponse> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    this.requireSupportAccess(ticket, agentId, actorRole, false);

    const uploaded = await this.uploads.uploadPrivateSupportAttachment(file, ticket.id);
    try {
      const attachment = await this.complaintAttachmentsRepository.save(
        this.complaintAttachmentsRepository.create({
          complaint_id: ticket.id,
          uploader_id: agentId,
          storage_key: uploaded.storageKey,
          original_filename: uploaded.originalFilename,
          mime_type: uploaded.mimeType,
          size: String(uploaded.size),
        }),
      );
      await this.audit(agentId, 'support_ticket_attachment_added', ticket, {
        attachmentId: attachment.id,
        filename: attachment.original_filename,
        mimeType: attachment.mime_type,
        size: attachment.size,
      });
      return this.toSupportAttachmentResponse(attachment);
    } catch (error) {
      await this.storage.tryDelete(uploaded.storageKey);
      throw error;
    }
  }

  public async getSupportAttachment(
    complaintId: string,
    attachmentId: string,
    actorId?: string,
    actorRole?: SupportActorRole,
  ): Promise<SupportAttachmentDownload> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    this.requireSupportAccess(ticket, actorId, actorRole, false);
    // Keep the ticket id inside the predicate so a modified attachment id
    // cannot retrieve evidence belonging to a different ticket.
    const attachment = await this.complaintAttachmentsRepository
      .createQueryBuilder('attachment')
      .addSelect('attachment.storage_key')
      .where('attachment.id = :attachmentId AND attachment.complaint_id = :complaintId', {
        attachmentId,
        complaintId,
      })
      .getOne();
    if (!attachment) {
      throw new NotFoundException(biBody('Attachment not found', 'المرفق غير موجود'));
    }
    return { attachment, object: await this.storage.getObject(attachment.storage_key) };
  }

  public async addComplainantMessage(
    complaintId: string,
    complainantId: string,
    dto: CreateComplaintMessageDto,
  ): Promise<ComplaintMessage> {
    await this.getOwnTicket(complaintId, complainantId);
    const currentTicket = await this.complaintsRepository.findOneByOrFail({ id: complaintId });
    if ([ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED].includes(currentTicket.status)) {
      throw new BadRequestException('Closed or resolved tickets cannot receive new replies.');
    }
    const message = await this.saveMessage(
      complaintId,
      complainantId,
      ComplaintMessageKind.COMPLAINANT_MESSAGE,
      dto.body,
    );
    const ticket = await this.complaintsRepository.findOneByOrFail({ id: complaintId });
    if (ticket.status === ComplaintStatus.WAITING_FOR_USER) {
      await this.transitionWithoutExpectedVersion(
        ticket,
        ComplaintStatus.IN_PROGRESS,
        'Complainant replied',
      );
    }
    await this.audit(complainantId, 'support_ticket_message_added', ticket, {
      kind: ComplaintMessageKind.COMPLAINANT_MESSAGE,
    });
    await this.notifySupportUsers(ticket, 'user_reply');
    return message;
  }

  public async addSupportMessage(
    complaintId: string,
    agentId: string,
    actorRole: SupportActorRole,
    dto: CreateSupportMessageDto,
  ): Promise<ComplaintMessage> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    this.requireSupportAccess(ticket, agentId, actorRole, false);
    const kind = dto.internal
      ? ComplaintMessageKind.INTERNAL_NOTE
      : ComplaintMessageKind.AGENT_REPLY;
    const message = await this.saveMessage(complaintId, agentId, kind, dto.body);
    if (kind === ComplaintMessageKind.AGENT_REPLY && ticket.first_response_at === null) {
      await this.complaintsRepository.update(ticket.id, { first_response_at: new Date() });
    }
    await this.audit(agentId, 'support_ticket_message_added', ticket, { kind });
    if (kind === ComplaintMessageKind.AGENT_REPLY) {
      await this.notificationsService.createSupportTicketNotification(
        ticket.complainant_id,
        ticket,
        'agent_reply',
      );
    }
    return message;
  }

  public async assignTicket(
    complaintId: string,
    actorId: string,
    actorRole: SupportActorRole,
    dto: AssignComplaintDto,
  ): Promise<Complaint> {
    const agent = await this.usersRepository.findOneBy({ id: dto.agent_id });
    if (!agent || agent.role !== UserRole.CALL_CENTER || !agent.is_active) {
      throw new BadRequestException('The assigned user must be an active Call Center employee.');
    }
    const ticket = await this.requireExpectedVersion(complaintId, dto.version);
    if (actorRole === UserRole.CALL_CENTER) {
      if (agent.id !== actorId) {
        throw new ForbiddenException('Call Center employees may only claim tickets for themselves.');
      }
      if (ticket.assigned_agent_id !== null && ticket.assigned_agent_id !== actorId) {
        throw new ForbiddenException('This ticket is assigned to another employee.');
      }
    }
    const result = await this.complaintsRepository
      .createQueryBuilder()
      .update(Complaint)
      .set({ assigned_agent_id: agent.id, version: () => '"version" + 1' })
      .where('id = :id AND version = :version', { id: ticket.id, version: dto.version })
      .returning('*')
      .execute();
    if (result.affected !== 1) {
      throw new ConflictException(
        'This ticket was updated by another employee. Refresh and try again.',
      );
    }
    const updated = result.raw[0] as Complaint;
    await this.audit(actorId, 'support_ticket_assigned', updated, { assignedAgentId: agent.id });
    await this.notificationsService.createSupportTicketNotification(agent.id, updated, 'assigned');
    return updated;
  }

  public async transitionTicket(
    complaintId: string,
    actorId: string,
    actorRole: SupportActorRole,
    dto: TransitionComplaintDto,
  ): Promise<Complaint> {
    const ticket = await this.requireExpectedVersion(complaintId, dto.version);
    this.requireSupportAccess(ticket, actorId, actorRole, false);
    if (!SUPPORT_TRANSITIONS[ticket.status].includes(dto.status)) {
      throw new BadRequestException(
        `Ticket status ${ticket.status} cannot transition to ${dto.status}.`,
      );
    }
    return await this.transitionWithExpectedVersion(ticket, actorId, dto);
  }

  /** Existing admin endpoint adapter: preserve its one-reply-and-resolve behavior. */
  public async respondToComplaint(
    complaintId: string,
    adminId: string,
    dto: RespondComplaintDto,
  ): Promise<Complaint> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    if (!SUPPORT_TRANSITIONS[ticket.status].includes(ComplaintStatus.RESOLVED)) {
      throw new BadRequestException(`Ticket status ${ticket.status} cannot transition to resolved.`);
    }
    if (ticket.version !== dto.version) {
      throw new ConflictException(
        'This ticket was updated by another employee. Refresh and try again.',
      );
    }
    const sanitizedResponse = this.sanitizationService.sanitizeStrict(dto.admin_response);
    const respondedAt = new Date();
    const updated = await this.transitionWithExpectedVersion(
      ticket,
      adminId,
      {
        status: ComplaintStatus.RESOLVED,
        version: dto.version,
        reason: 'Admin response',
        resolution: sanitizedResponse,
      },
      {
        admin_response: sanitizedResponse,
        admin_id: adminId,
        responded_at: respondedAt,
        first_response_at: ticket.first_response_at ?? respondedAt,
      },
    );
    await this.saveMessage(
      complaintId,
      adminId,
      ComplaintMessageKind.AGENT_REPLY,
      sanitizedResponse,
    );
    await this.audit(adminId, 'support_ticket_admin_response', updated, {
      legacyAdminResponse: true,
    });
    return updated;
  }

  private async createTicket(
    complainantId: string,
    complainantRole: ComplainantRole,
    dto: CreateComplaintDto,
    legacyStudentId: string | null,
  ): Promise<Complaint> {
    if (dto.request_id !== undefined) {
      const existing = await this.complaintsRepository.findOneBy({
        complainant_id: complainantId,
        request_id: dto.request_id,
      });
      if (existing) return existing;
    }
    await this.validateComplaintTarget(dto);
    const ticketNumber = await this.nextTicketNumber();
    const createdAt = new Date();
    const complaint = this.complaintsRepository.create({
      student_id: legacyStudentId,
      complainant_id: complainantId,
      complainant_role: complainantRole,
      request_id: dto.request_id ?? null,
      ticket_number: ticketNumber,
      type: dto.type,
      target_id: dto.target_id ?? null,
      subject: this.sanitizationService.sanitizeStrict(dto.subject),
      description: this.sanitizationService.sanitizeStrict(dto.description),
      status: ComplaintStatus.NEW,
      ...(await this.supportSla.dueDates(createdAt)),
    });
    let saved: Complaint;
    try {
      saved = await this.complaintsRepository.save(complaint);
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== '23505' || dto.request_id === undefined) {
        throw error;
      }
      const existing = await this.complaintsRepository.findOneBy({
        complainant_id: complainantId,
        request_id: dto.request_id,
      });
      if (!existing) throw error;
      return existing;
    }
    await this.complaintStatusPeriodsRepository.save(
      this.complaintStatusPeriodsRepository.create({
        complaint_id: saved.id,
        status: saved.status,
        started_at: saved.created_at,
        ended_at: null,
      }),
    );
    await this.audit(complainantId, 'support_ticket_created', saved, { complainantRole });
    await this.notificationsService.createSupportTicketNotification(
      saved.complainant_id,
      saved,
      'created',
    );
    await this.notifySupportUsers(saved, 'new_ticket');
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
    const queryBuilder = this.complaintsRepository
      .createQueryBuilder('complaint')
      .leftJoin('complaint.complainant', 'search_complainant');
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
    if (filter.unassigned === true) {
      queryBuilder.andWhere('complaint.assigned_agent_id IS NULL');
    }
    if (filter.overdue === true) {
      // Mirrors CallCenterSupportService.supportReport()'s `delayed` count
      // exactly, so the dashboard's Overdue card total matches this list.
      queryBuilder
        .andWhere('complaint.status NOT IN (:...overdueTerminal)', {
          overdueTerminal: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
        })
        .andWhere(
          '(complaint.first_response_due_at <= NOW() OR complaint.resolution_due_at <= NOW())',
        );
    }
    if (filter.search !== undefined && filter.search.trim() !== '') {
      queryBuilder.andWhere(
        `(
          complaint.ticket_number ILIKE :search OR
          complaint.subject ILIKE :search OR
          complaint.description ILIKE :search OR
          search_complainant.name ILIKE :search OR
          search_complainant.email ILIKE :search OR
          search_complainant.phone ILIKE :search
        )`,
        {
          search: `%${filter.search.trim()}%`,
        },
      );
    }
    return queryBuilder;
  }

  private toPaginatedResponse<T>(
    data: T[],
    total: number,
    page: number,
    limit: number,
  ): PaginatedResponse<T> {
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

  private toSafeSupportTicket(ticket: Complaint): Record<string, unknown> {
    const safeUser = (user: User | null | undefined) =>
      user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            is_active: user.is_active,
          }
        : null;
    return {
      ...ticket,
      student: safeUser(ticket.student),
      complainant: safeUser(ticket.complainant),
      admin: safeUser(ticket.admin),
      assigned_agent: safeUser(ticket.assigned_agent),
    };
  }

  private requireSupportAccess(
    ticket: Complaint,
    actorId?: string,
    actorRole?: SupportActorRole,
    allowUnassigned = false,
  ): void {
    if (actorRole === undefined || actorId === undefined || actorRole === UserRole.ADMIN) return;
    if (ticket.assigned_agent_id === actorId) return;
    if (allowUnassigned && ticket.assigned_agent_id === null) return;
    throw new ForbiddenException('This ticket is assigned to another employee.');
  }

  private async validateComplaintTarget(dto: CreateComplaintDto): Promise<void> {
    if (dto.target_id === undefined) return;
    if (dto.type === 'technical') {
      throw new BadRequestException('Technical complaints cannot target a teacher or lesson.');
    }
    if (dto.type === 'teacher') {
      const teacher = await this.usersRepository.findOneBy({
        id: dto.target_id,
        role: UserRole.TEACHER,
        is_active: true,
      });
      if (!teacher) throw new BadRequestException('The selected teacher does not exist.');
      return;
    }
    const lesson = await this.lessonsRepository.findOneBy({ id: dto.target_id });
    if (!lesson) throw new BadRequestException('The selected lesson does not exist.');
  }

  private async notifySupportUsers(
    ticket: Complaint,
    event: 'new_ticket' | 'user_reply',
  ): Promise<void> {
    const recipients = ticket.assigned_agent_id
      ? [{ id: ticket.assigned_agent_id }]
      : await this.usersRepository.find({
          where: { role: UserRole.CALL_CENTER, is_active: true },
          select: ['id'],
        });
    const settled = await Promise.allSettled(
      recipients.map((recipient) =>
        this.notificationsService.createSupportTicketNotification(recipient.id, ticket, event),
      ),
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.warn(`Support notification failed: ${String(result.reason)}`);
      }
    }
  }

  private async saveMessage(
    complaintId: string,
    authorId: string,
    kind: ComplaintMessageKind,
    body: string,
  ): Promise<ComplaintMessage> {
    return await this.complaintMessagesRepository.save(
      this.complaintMessagesRepository.create({
        complaint_id: complaintId,
        author_id: authorId,
        kind,
        body: this.sanitizationService.sanitizeStrict(body),
      }),
    );
  }

  private async requireExpectedVersion(
    complaintId: string,
    expectedVersion: number,
  ): Promise<Complaint> {
    const ticket = await this.complaintsRepository.findOneBy({ id: complaintId });
    if (!ticket) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }
    if (ticket.version !== expectedVersion) {
      throw new ConflictException(
        'This ticket was updated by another employee. Refresh and try again.',
      );
    }
    return ticket;
  }

  private async transitionWithExpectedVersion(
    ticket: Complaint,
    actorId: string,
    dto: TransitionComplaintDto,
    extraValues: Omit<Partial<Complaint>, 'version' | 'status'> = {},
  ): Promise<Complaint> {
    const now = new Date();
    const transitionValues: Omit<Partial<Complaint>, 'version'> = {
      status: dto.status,
      ...(dto.status === ComplaintStatus.RESOLVED
        ? { resolved_at: now, resolution: dto.resolution ?? null }
        : {}),
      ...(dto.status === ComplaintStatus.CLOSED
        ? { closed_at: now, close_reason: dto.reason }
        : {}),
      ...(dto.status === ComplaintStatus.ESCALATED ? { escalated_at: now } : {}),
      ...(dto.status === ComplaintStatus.REOPENED
        ? {
            reopen_count: ticket.reopen_count + 1,
            closed_at: null,
            resolution_due_at: (await this.supportSla.dueDates(now)).resolution_due_at,
          }
        : {}),
    };
    const result = await this.complaintsRepository
      .createQueryBuilder()
      .update(Complaint)
      .set({ ...transitionValues, ...extraValues, version: () => '"version" + 1' })
      .where('id = :id AND version = :version', { id: ticket.id, version: ticket.version })
      .returning('*')
      .execute();
    if (result.affected !== 1) {
      throw new ConflictException(
        'This ticket was updated by another employee. Refresh and try again.',
      );
    }
    const updated = result.raw[0] as Complaint;
    await this.complaintStatusPeriodsRepository
      .createQueryBuilder()
      .update(ComplaintStatusPeriod)
      .set({ ended_at: now })
      .where('complaint_id = :complaintId AND ended_at IS NULL', { complaintId: ticket.id })
      .execute();
    await this.complaintStatusPeriodsRepository.save(
      this.complaintStatusPeriodsRepository.create({
        complaint_id: ticket.id,
        status: dto.status,
        started_at: now,
        ended_at: null,
      }),
    );
    await this.audit(actorId, 'support_ticket_status_changed', updated, {
      from: ticket.status,
      to: dto.status,
      reason: dto.reason ?? null,
    });
    const notificationEvent = this.statusNotificationEvent(dto.status);
    if (notificationEvent !== null) {
      await this.notificationsService.createSupportTicketNotification(
        updated.complainant_id,
        updated,
        notificationEvent,
      );
    }
    return updated;
  }

  private async transitionWithoutExpectedVersion(
    ticket: Complaint,
    status: ComplaintStatus,
    reason: string,
  ): Promise<Complaint> {
    return await this.transitionWithExpectedVersion(
      ticket,
      ticket.admin_id ?? ticket.assigned_agent_id ?? ticket.complainant_id,
      {
        status,
        version: ticket.version,
        reason,
      },
    );
  }

  private statusNotificationEvent(
    status: ComplaintStatus,
  ): 'waiting_for_user' | 'escalated' | 'resolved' | 'closed' | 'reopened' | null {
    switch (status) {
      case ComplaintStatus.WAITING_FOR_USER:
      case ComplaintStatus.ESCALATED:
      case ComplaintStatus.RESOLVED:
      case ComplaintStatus.CLOSED:
      case ComplaintStatus.REOPENED:
        return status;
      default:
        return null;
    }
  }

  private async nextTicketNumber(): Promise<string> {
    try {
      const rows = (await this.complaintsRepository.query(
        "SELECT nextval('complaint_ticket_number_seq') AS value",
      )) as Array<{ value: string | number }>;
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

  private async audit(
    actorId: string,
    action: string,
    ticket: Complaint,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.activityLogsService.recordAuditEvent(
      new SupportTicketAuditEvent(
        actorId,
        action,
        'support_ticket',
        ticket.id,
        ticket.ticket_number,
        details,
      ),
    );
  }

  private toSupportAttachmentResponse(attachment: ComplaintAttachment): SupportAttachmentResponse {
    return {
      id: attachment.id,
      original_filename: attachment.original_filename,
      mime_type: attachment.mime_type,
      size: attachment.size,
      created_at: attachment.created_at,
    };
  }
}
