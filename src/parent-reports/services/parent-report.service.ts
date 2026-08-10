import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { ParentReportPayload } from '../entities/parent-report-payload';
import { ParentReport } from '../entities/parent-report.entity';
import { ParentReportStatus } from '../entities/parent-report-status.enum';
import type { ReportPeriod } from '../logic/report-period';

/** Terminal states: the report's work is finished and must not be redone. */
const TERMINAL: ReadonlySet<ParentReportStatus> = new Set([
  ParentReportStatus.DISPATCHED,
  ParentReportStatus.SKIPPED,
]);

export interface ReportClaim {
  /** False when another worker (or an earlier run) already owns this period. */
  claimed: boolean;
  report: ParentReport;
}

/**
 * Persistence and state for generated reports.
 *
 * Mirrors `ParentMessageService` deliberately, down to the claim semantics:
 * insert first, let Postgres' unique index arbitrate, refuse the claim when the
 * winner is already terminal. Two schedulers firing at once, a worker restarted
 * mid-run, and a manual replay all converge on "exactly one report per student
 * per period" without a lock, a queue guarantee, or an in-memory set.
 */
@Injectable()
export class ParentReportService {
  private readonly logger = new Logger(ParentReportService.name);

  constructor(
    @InjectRepository(ParentReport)
    private readonly reports: Repository<ParentReport>,
  ) {}

  /**
   * Reserve the right to build this student's report for this period.
   *
   * A `FAILED` or `PENDING` row is re-claimable: the first is a retry after
   * aggregation blew up, the second a worker that died before finishing. A
   * `DISPATCHED` or `SKIPPED` row is not — that decision has already reached
   * (or deliberately not reached) a parent, and redoing it would double-send.
   */
  public async claim(studentId: string, period: ReportPeriod): Promise<ReportClaim> {
    const values: Partial<ParentReport> = {
      student_id: studentId,
      report_type: period.type,
      period_key: period.key,
      period_start: period.startsAt,
      period_end: period.endsAt,
      time_zone: period.timeZone,
      status: ParentReportStatus.PENDING,
    };

    const insert = await this.reports
      .createQueryBuilder()
      .insert()
      .into(ParentReport)
      .values(values as QueryDeepPartialEntity<ParentReport>)
      .orIgnore()
      .returning('*')
      .execute();

    const inserted = (insert.raw as ParentReport[])[0];
    if (inserted !== undefined) return { claimed: true, report: inserted };

    // Conflict: a row for this exact period already exists.
    const existing = await this.reports.findOneOrFail({
      where: {
        student_id: studentId,
        report_type: period.type,
        period_start: period.startsAt,
        period_end: period.endsAt,
      },
    });

    if (TERMINAL.has(existing.status)) {
      this.logger.debug(
        `Report ${period.type}/${period.key} for student ${studentId} already ${existing.status} — skipping`,
      );
      return { claimed: false, report: existing };
    }

    return { claimed: true, report: existing };
  }

  public async markGenerated(id: string, payload: ParentReportPayload): Promise<void> {
    // Typed as the entity, then widened once — the same shape as
    // `ParentMessageService.claim`. `QueryDeepPartialEntity` recurses into the
    // `payload` jsonb column, which under `exactOptionalPropertyTypes` no
    // longer accepts a plain object. Annotating as `Partial<ParentReport>`
    // keeps every column name and type checked; the cast only relaxes
    // TypeORM's deep-partial wrapper.
    const values: Partial<ParentReport> = {
      status: ParentReportStatus.GENERATED,
      payload,
      generated_at: new Date(),
      error_message: null,
    };

    await this.reports.update(id, values as QueryDeepPartialEntity<ParentReport>);
  }

  public async markDispatched(id: string, recipientCount: number): Promise<void> {
    await this.reports.update(id, {
      status: ParentReportStatus.DISPATCHED,
      recipient_count: recipientCount,
      dispatched_at: new Date(),
      error_message: null,
    });
  }

  /** A period with nothing in it, or a student with no eligible guardian left. */
  public async markSkipped(id: string, reason: string): Promise<void> {
    await this.reports.update(id, {
      status: ParentReportStatus.SKIPPED,
      error_message: reason,
    });
  }

  public async markFailed(id: string, reason: string): Promise<void> {
    await this.reports.update(id, {
      status: ParentReportStatus.FAILED,
      error_message: reason.slice(0, 2000),
    });
  }

  public async findById(id: string): Promise<ParentReport | null> {
    return await this.reports.findOne({ where: { id } });
  }

  public async findForPeriod(
    studentId: string,
    period: ReportPeriod,
  ): Promise<ParentReport | null> {
    return await this.reports.findOne({
      where: {
        student_id: studentId,
        report_type: period.type,
        period_start: period.startsAt,
        period_end: period.endsAt,
      },
    });
  }
}
