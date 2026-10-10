import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
  NotificationsService,
  type SupportTicketNotificationEvent,
} from '../notifications/services/notifications.service';
import { Complaint } from './entities/complaint.entity';
import { ComplaintStatus } from './enums/complaint-status.enum';
import { SupportManagementService } from './support-management.service';
import { CronSingleRunner } from '../common/utils/cron-lock.util';

/**
 * Baseline policy pending the Phase 8 supervisor-managed SLA settings surface.
 * It is deliberately one global policy: the current domain has no approved
 * category or priority configuration source from which to derive variants.
 */
export const SUPPORT_SLA_POLICY = Object.freeze({
  firstResponseHours: 24,
  resolutionHours: 72,
  warningWindowHours: 4,
});

@Injectable()
export class SupportSlaService {
  constructor(
    @InjectRepository(Complaint)
    private readonly complaintsRepository: Repository<Complaint>,
    private readonly notifications: NotificationsService,
    private readonly supportManagement: SupportManagementService,
  ) {}

  public async dueDates(createdAt: Date): Promise<{
    first_response_due_at: Date;
    resolution_due_at: Date;
  }> {
    const policy = await this.supportManagement.activePolicy();
    const values = policy
      ? {
          firstResponseHours: policy.first_response_hours,
          resolutionHours: policy.resolution_hours,
          warningWindowHours: policy.warning_window_hours,
        }
      : SUPPORT_SLA_POLICY;
    return {
      first_response_due_at: new Date(
        createdAt.getTime() + values.firstResponseHours * 60 * 60 * 1000,
      ),
      resolution_due_at: new Date(createdAt.getTime() + values.resolutionHours * 60 * 60 * 1000),
    };
  }

  @Cron('0 */15 * * * *')
  @CronSingleRunner('support.sla_evaluate')
  public async evaluate(): Promise<void> {
    const now = new Date();
    const policy = await this.supportManagement.activePolicy();
    const warningWindowHours =
      policy?.warning_window_hours ?? SUPPORT_SLA_POLICY.warningWindowHours;
    const warningAt = new Date(now.getTime() + warningWindowHours * 60 * 60 * 1000);
    await Promise.all([
      this.notifyDueTickets('first_response_due_at', 'first_response_at', now, warningAt),
      this.notifyDueTickets('resolution_due_at', null, now, warningAt),
    ]);
  }

  private async notifyDueTickets(
    dueColumn: 'first_response_due_at' | 'resolution_due_at',
    completedColumn: 'first_response_at' | null,
    now: Date,
    warningAt: Date,
  ): Promise<void> {
    const base = this.complaintsRepository
      .createQueryBuilder('complaint')
      .where('complaint.assigned_agent_id IS NOT NULL')
      .andWhere('complaint.status NOT IN (:...terminalStatuses)', {
        terminalStatuses: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
      });
    if (completedColumn !== null) {
      base.andWhere(`complaint.${completedColumn} IS NULL`);
    }
    const warningTickets = await base
      .clone()
      .andWhere(`complaint.${dueColumn} > :now AND complaint.${dueColumn} <= :warningAt`, {
        now,
        warningAt,
      })
      .getMany();
    const overdueTickets = await base
      .clone()
      .andWhere(`complaint.${dueColumn} <= :now`, { now })
      .getMany();
    const eventPrefix =
      dueColumn === 'first_response_due_at' ? 'sla_first_response' : 'sla_resolution';
    await Promise.all([
      ...warningTickets.map((ticket) =>
        this.notifyAssignee(ticket, `${eventPrefix}_warning` as SupportTicketNotificationEvent),
      ),
      ...overdueTickets.map((ticket) =>
        this.notifyAssignee(ticket, `${eventPrefix}_exceeded` as SupportTicketNotificationEvent),
      ),
    ]);
  }

  private async notifyAssignee(
    ticket: Complaint,
    event: SupportTicketNotificationEvent,
  ): Promise<void> {
    if (ticket.assigned_agent_id === null) return;
    await this.notifications.createSupportTicketNotification(
      ticket.assigned_agent_id,
      ticket,
      event,
    );
  }
}
