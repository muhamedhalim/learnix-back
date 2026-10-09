import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Queue } from 'bullmq';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { QUEUE_NAMES } from '../../queues/queues.constants';
import { ParentMessageFilterDto } from '../dto/parent-message-filter.dto';
import { ParentMessage, ParentMessageStatus } from '../entities';
import { ParentNotificationJobsService } from './parent-notification-jobs.service';

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

/**
 * Which students a caller may see messages about. An id list, or a SQL subquery
 * selecting student ids (with its named binds) so a large scope never becomes a
 * large bind list. Plain data: notifications does not import teacher-follow-up.
 */
export type StudentScope = string[] | { sql: string; params: Record<string, unknown> };

export interface ParentMessageStats {
  total: number;
  by_status: Record<string, number>;
  /**
   * Share of SENT messages later confirmed delivered by a provider webhook.
   * SMS can never contribute (no delivery callback), so this measures WhatsApp.
   */
  delivery_rate: number;
  read_rate: number;
}

@Injectable()
export class ParentMessageAdminService {
  constructor(
    @InjectRepository(ParentMessage)
    private readonly messages: Repository<ParentMessage>,
    @InjectQueue(QUEUE_NAMES.PARENT_NOTIFICATIONS) private readonly queue: Queue,
    @InjectQueue(QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ) private readonly dlq: Queue,
    private readonly jobs: ParentNotificationJobsService,
  ) {}

  /**
   * `scopeStudentIds`, when passed, restricts the result to those students —
   * used by the teacher-facing controller so a teacher can only ever see
   * messages about their own students. An empty array means "owns nothing",
   * not "no filter", and must return zero rows rather than everyone's. A
   * subquery scope that selects nothing behaves the same way.
   */
  public async list(
    filter: ParentMessageFilterDto,
    scopeStudentIds?: StudentScope,
  ): Promise<PaginatedResponse<ParentMessage>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;

    if (Array.isArray(scopeStudentIds) && scopeStudentIds.length === 0) {
      return { data: [], meta: this.meta(0, page, limit) };
    }

    const qb = this.messages
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.guardian', 'guardian')
      .leftJoinAndSelect('m.student', 'student');

    if (scopeStudentIds) this.applyScope(qb, scopeStudentIds, 'andWhere');
    if (filter.status) qb.andWhere('m.status = :status', { status: filter.status });
    if (filter.event_type)
      qb.andWhere('m.event_type = :eventType', { eventType: filter.event_type });
    if (filter.channel) qb.andWhere('m.channel = :channel', { channel: filter.channel });
    if (filter.student_id)
      qb.andWhere('m.student_id = :studentId', { studentId: filter.student_id });
    if (filter.guardian_id)
      qb.andWhere('m.guardian_id = :guardianId', { guardianId: filter.guardian_id });
    if (filter.search !== undefined && filter.search !== '') {
      qb.andWhere('m.body ILIKE :q', { q: `%${filter.search}%` });
    }

    qb.orderBy('m.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, meta: this.meta(total, page, limit) };
  }

  public async stats(scopeStudentIds?: StudentScope): Promise<ParentMessageStats> {
    if (Array.isArray(scopeStudentIds) && scopeStudentIds.length === 0) {
      return { total: 0, by_status: {}, delivery_rate: 0, read_rate: 0 };
    }

    const qb = this.messages.createQueryBuilder('m');
    if (scopeStudentIds) this.applyScope(qb, scopeStudentIds, 'where');

    const rows = await qb
      .select('m.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.status')
      .getRawMany<{ status: string; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number.parseInt(row.count, 10);
      byStatus[row.status] = count;
      total += count;
    }

    // Anything that reached a provider — the denominator for delivery.
    const reachedProvider =
      (byStatus[ParentMessageStatus.SENT] ?? 0) +
      (byStatus[ParentMessageStatus.DELIVERED] ?? 0) +
      (byStatus[ParentMessageStatus.READ] ?? 0);

    const delivered =
      (byStatus[ParentMessageStatus.DELIVERED] ?? 0) + (byStatus[ParentMessageStatus.READ] ?? 0);
    const read = byStatus[ParentMessageStatus.READ] ?? 0;

    return {
      total,
      by_status: byStatus,
      delivery_rate: reachedProvider === 0 ? 0 : Math.round((delivered / reachedProvider) * 100),
      read_rate: reachedProvider === 0 ? 0 : Math.round((read / reachedProvider) * 100),
    };
  }

  /** Live BullMQ counters for the pipeline and its dead-letter queue. */
  public async queueHealth(): Promise<QueueHealth[]> {
    return Promise.all([this.queue, this.dlq].map(async (queue) => this.countsFor(queue)));
  }

  private async countsFor(queue: Queue): Promise<QueueHealth> {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return {
      name: queue.name,
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      completed: counts['completed'] ?? 0,
      failed: counts['failed'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      paused: await queue.isPaused(),
    };
  }

  /**
   * Re-enqueue one failed/dead message. The worker resets its status and
   * re-claims it; a message that actually reached the guardian is refused.
   *
   * `scopeStudentIds`, when passed, additionally requires the message belong
   * to one of those students — a 404 (not 403) so a teacher probing ids can't
   * distinguish "not yours" from "doesn't exist".
   */
  public async retry(id: string, scopeStudentIds?: StudentScope): Promise<{ queued: boolean }> {
    const message = await this.messages.findOne({ where: { id } });
    if (!message) {
      throw new NotFoundException(biBody('Parent message not found', 'رسالة ولي الأمر غير موجودة'));
    }
    if (scopeStudentIds && !(await this.isInScope(message, scopeStudentIds))) {
      throw new NotFoundException(biBody('Parent message not found', 'رسالة ولي الأمر غير موجودة'));
    }

    if (
      message.status === ParentMessageStatus.DELIVERED ||
      message.status === ParentMessageStatus.READ
    ) {
      return { queued: false };
    }

    await this.jobs.enqueueRedelivery(id);
    return { queued: true };
  }

  /** Restricts `qb` to the scope. The array form keeps its original spread-bind semantics. */
  private applyScope(
    qb: SelectQueryBuilder<ParentMessage>,
    scope: StudentScope,
    method: 'where' | 'andWhere',
  ): void {
    if (Array.isArray(scope)) {
      qb[method]('m.student_id IN (:...scopeStudentIds)', { scopeStudentIds: scope });
    } else {
      qb[method](`m.student_id IN (${scope.sql})`, scope.params);
    }
  }

  private async isInScope(message: ParentMessage, scope: StudentScope): Promise<boolean> {
    if (Array.isArray(scope)) return scope.includes(message.student_id);
    // One EXISTS keyed by the message id: the student is read from the row itself.
    return this.messages
      .createQueryBuilder('m')
      .where('m.id = :scopedMessageId', { scopedMessageId: message.id })
      .andWhere(`m.student_id IN (${scope.sql})`, scope.params)
      .getExists();
  }

  private meta(total: number, page: number, limit: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
