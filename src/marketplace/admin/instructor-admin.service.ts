import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceInstructorStatus } from '../common/enums';
import { BalanceService, MarketplaceBalanceWithShortfall } from '../earnings/balance.service';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { LedgerService } from '../earnings/ledger.service';
import { InstructorApplication, MarketplaceInstructor } from '../instructors/entities';
import { MarketplacePayoutRequest } from '../payouts/entities';

export interface InstructorRosterRow {
  instructor: MarketplaceInstructor;
  totalEarnedMinor: Array<{ currency: string; totalMinor: number }>;
}

export interface InstructorFullRecord {
  instructor: MarketplaceInstructor;
  application: InstructorApplication | null;
  courseCount: number;
  learnerCount: number;
  balances: MarketplaceBalanceWithShortfall[];
  recentLedgerEntries: PaginatedResponse<import('../earnings/entities/marketplace-ledger-entry.entity').MarketplaceLedgerEntry>;
  payoutRequests: MarketplacePayoutRequest[];
}

/**
 * FR-283 (T192). The roster's "financial summary" is one grouped query
 * across the current page's instructor ids (never N+1 — the whole reason
 * this batches rather than calling `BalanceService` per row), summing
 * every earning ever created regardless of status — a simple lifetime
 * total, not the same thing as `BalanceService.getAllBalances()`'s
 * available/pending/paid-out breakdown, which the detail view below
 * provides in full for one instructor at a time.
 *
 * The detail view (`getFullRecord`) is not itself named as a separate
 * route in contracts/README.md §5 (only the roster GET is listed), but
 * FR-283's own text explicitly requires viewing "any instructor's full
 * record" — resolved in favor of the FR, which is the authoritative
 * requirement, by adding `GET /marketplace/admin/instructors/:id` (T192's
 * controller) alongside the roster route the contract does name.
 */
@Injectable()
export class InstructorAdminService {
  constructor(
    @InjectRepository(MarketplaceInstructor) private readonly instructors: Repository<MarketplaceInstructor>,
    @InjectRepository(InstructorApplication) private readonly applications: Repository<InstructorApplication>,
    @InjectRepository(MarketplaceCourse) private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceEnrollment) private readonly enrollments: Repository<MarketplaceEnrollment>,
    @InjectRepository(InstructorEarning) private readonly earnings: Repository<InstructorEarning>,
    @InjectRepository(MarketplacePayoutRequest) private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
    private readonly balance: BalanceService,
    private readonly ledger: LedgerService,
  ) {}

  public async listRoster(
    status?: MarketplaceInstructorStatus,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<InstructorRosterRow>> {
    const where = status ? { status } : {};
    const [rows, total] = await this.instructors.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const ids = rows.map((r) => r.id);
    const totals =
      ids.length === 0
        ? []
        : await this.earnings
            .createQueryBuilder('e')
            .select('e.instructor_id', 'instructor_id')
            .addSelect('e.currency', 'currency')
            .addSelect('COALESCE(SUM(e.net_amount_minor), 0)', 'total')
            .where('e.instructor_id IN (:...ids)', { ids })
            .groupBy('e.instructor_id')
            .addGroupBy('e.currency')
            .getRawMany<{ instructor_id: string; currency: string; total: string }>();

    const data = rows.map((instructor) => ({
      instructor,
      totalEarnedMinor: totals
        .filter((t) => t.instructor_id === instructor.id)
        .map((t) => ({ currency: t.currency, totalMinor: Number.parseInt(t.total, 10) })),
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  public async getFullRecord(instructorId: string): Promise<InstructorFullRecord> {
    const instructor = await this.instructors.findOne({ where: { id: instructorId } });
    if (!instructor) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }

    const [application, courseCount, courseIds, balances, recentLedgerEntries, payoutRequests] = await Promise.all([
      instructor.application_id ? this.applications.findOne({ where: { id: instructor.application_id } }) : Promise.resolve(null),
      this.courses.count({ where: { instructor_id: instructorId } }),
      this.courses.find({ where: { instructor_id: instructorId }, select: ['id'] }),
      this.balance.getAllBalances(instructorId),
      this.ledger.listEntriesAdmin({ instructorId, limit: 50 }),
      this.payoutRequests.find({ where: { instructor_id: instructorId }, order: { requested_at: 'DESC' }, take: 20 }),
    ]);

    const learnerCount = courseIds.length
      ? await this.enrollments.count({ where: { course_id: In(courseIds.map((c) => c.id)) } })
      : 0;

    return { instructor, application, courseCount, learnerCount, balances, recentLedgerEntries, payoutRequests };
  }
}
