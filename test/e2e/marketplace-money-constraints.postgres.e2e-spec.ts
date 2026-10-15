import type { INestApplication } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { CreateMarketplaceInstructors2093000000000 } from '../../src/migrations/2093000000000-CreateMarketplaceInstructors';
import { CreateMarketplaceCatalog2094000000000 } from '../../src/migrations/2094000000000-CreateMarketplaceCatalog';
import { CreateMarketplaceCommerce2095000000000 } from '../../src/migrations/2095000000000-CreateMarketplaceCommerce';
import { CreateMarketplaceMoney2096000000000 } from '../../src/migrations/2096000000000-CreateMarketplaceMoney';
import { CreateMarketplacePayouts2097000000000 } from '../../src/migrations/2097000000000-CreateMarketplacePayouts';
import { CreateMarketplaceReviews2098000000000 } from '../../src/migrations/2098000000000-CreateMarketplaceReviews';
import { SeedMarketplaceCategories2099000000000 } from '../../src/migrations/2099000000000-SeedMarketplaceCategories';
import { ExtendCertificatesForMarketplace2100000000000 } from '../../src/migrations/2100000000000-ExtendCertificatesForMarketplace';
import {
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
} from '../../src/marketplace/common/enums';
import { MarketplaceMoneyService } from '../../src/marketplace/common/money.service';
import { BalanceService } from '../../src/marketplace/earnings/balance.service';
import { LedgerService } from '../../src/marketplace/earnings/ledger.service';
import { ReconciliationService } from '../../src/marketplace/earnings/reconciliation.service';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { createE2EApp, resetDatabase } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * These tests intentionally execute against PostgreSQL rather than a mocked
 * QueryRunner: they prove the database-level financial guarantees (FR-130,
 * FR-137, FR-162, FR-171, FR-095/FR-096, FR-099/FR-100) that a service-layer
 * bug cannot bypass. Covers T012's constraint-violation requirement and
 * T013's ledger-immutability and currency-seed requirements.
 *
 * Marketplace entities do not exist yet at this point in the build (T018+),
 * so the app's own `synchronize` step does not create these tables — the
 * migrations here are the only source of them, applied once in `beforeAll`.
 */
describe('marketplace money PostgreSQL guarantees', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminId: string;

  const migrations = [
    new CreateMarketplaceInstructors2093000000000(),
    new CreateMarketplaceCatalog2094000000000(),
    new CreateMarketplaceCommerce2095000000000(),
    new CreateMarketplaceMoney2096000000000(),
    new CreateMarketplacePayouts2097000000000(),
    new CreateMarketplaceReviews2098000000000(),
    new SeedMarketplaceCategories2099000000000(),
    new ExtendCertificatesForMarketplace2100000000000(),
  ];

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      for (const migration of migrations) {
        await migration.up(runner);
      }
    } finally {
      await runner.release();
    }
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // `resetDatabase` truncates every entity-known table, and the
    // marketplace tables are all entity-known now that the module is
    // registered — so seed rows written by migrations (the EGP currency
    // row, the eleven categories) are wiped before every test. Every
    // migration's `up()` is idempotent (`IF NOT EXISTS` / `ON CONFLICT DO
    // NOTHING` throughout), so re-running the full set here is the same
    // operation as `beforeAll`'s, just repeated to restore the seed rows.
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      for (const migration of migrations) {
        await migration.up(runner);
      }
    } finally {
      await runner.release();
    }
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [row] = (await dataSource.query(
      `INSERT INTO "users" (username, name, email, phone, role)
       VALUES ($1, 'Admin', $2, $3, 'admin') RETURNING id`,
      [`admin-${suffix}`, `admin-${suffix}@example.com`, `010${suffix}`.slice(0, 11)],
    )) as Array<{ id: string }>;
    adminId = row!.id;
  });

  afterAll(async () => app.close());

  /** Creates an approved instructor, a published course and a course version, ready to back an order. */
  async function seedCourse(): Promise<{
    instructorId: string;
    courseId: string;
    versionId: string;
  }> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [application] = (await dataSource.query(
      `INSERT INTO marketplace_instructor_applications (user_id, display_name, years_of_experience)
       VALUES ($1, 'Test Instructor', 3) RETURNING id`,
      [adminId],
    )) as Array<{ id: string }>;
    const [instructor] = (await dataSource.query(
      `INSERT INTO marketplace_instructors (user_id, application_id, slug, display_name, approved_by)
       VALUES ($1, $2, $3, 'Test Instructor', $1) RETURNING id`,
      [adminId, application!.id, `instr-${suffix}`],
    )) as Array<{ id: string }>;
    const [category] = (await dataSource.query(
      `SELECT id FROM marketplace_categories LIMIT 1`,
    )) as Array<{ id: string }>;
    const [course] = (await dataSource.query(
      `INSERT INTO marketplace_courses
        (instructor_id, category_id, slug, title, summary, description, level, language, currency, cover_image_key)
       VALUES ($1, $2, $3, 'Course', 'Summary', 'Description', 'beginner', 'en', 'EGP', 'key')
       RETURNING id`,
      [instructor!.id, category!.id, `course-${suffix}`],
    )) as Array<{ id: string }>;
    const [version] = (await dataSource.query(
      `INSERT INTO marketplace_course_versions (course_id, version_number, snapshot, published_by)
       VALUES ($1, 1, '{}', $2) RETURNING id`,
      [course!.id, adminId],
    )) as Array<{ id: string }>;
    return { instructorId: instructor!.id, courseId: course!.id, versionId: version!.id };
  }

  function orderRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      order_number: `MP-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      gross_amount_minor: 1000,
      net_amount_minor: 1000,
      currency: 'EGP',
      commission_bps: 3000,
      commission_amount_minor: 300,
      instructor_earning_minor: 700,
      refund_window_days: 14,
      consumption_cap_bps: 3000,
      course_title_snapshot: 'Course',
      instructor_name_snapshot: 'Instructor',
      ...overrides,
    };
  }

  async function insertOrder(
    learnerId: string,
    courseId: string,
    versionId: string,
    instructorId: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const columns = [
      'order_number',
      'learner_id',
      'course_id',
      'course_version_id',
      'instructor_id',
      'gross_amount_minor',
      'net_amount_minor',
      'currency',
      'commission_bps',
      'commission_amount_minor',
      'instructor_earning_minor',
      'refund_window_days',
      'consumption_cap_bps',
      'course_title_snapshot',
      'instructor_name_snapshot',
    ];
    const values = [
      row['order_number'],
      learnerId,
      courseId,
      versionId,
      instructorId,
      row['gross_amount_minor'],
      row['net_amount_minor'],
      row['currency'],
      row['commission_bps'],
      row['commission_amount_minor'],
      row['instructor_earning_minor'],
      row['refund_window_days'],
      row['consumption_cap_bps'],
      row['course_title_snapshot'],
      row['instructor_name_snapshot'],
    ];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    await dataSource.query(
      `INSERT INTO marketplace_orders (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
  }

  it('CHK_mp_orders_split rejects an order whose commission + earning does not reconcile to the net amount (FR-130, FR-327)', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    await expect(
      insertOrder(
        adminId,
        courseId,
        versionId,
        instructorId,
        orderRow({ commission_amount_minor: 300, instructor_earning_minor: 800 }), // 300+800 != 1000
      ),
    ).rejects.toThrow(/CHK_mp_orders_split/);
  });

  it('CHK_mp_orders_zero_value rejects is_zero_value disagreeing with the actual net amount', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_orders
          (order_number, learner_id, course_id, course_version_id, instructor_id, gross_amount_minor,
           net_amount_minor, currency, commission_bps, commission_amount_minor, instructor_earning_minor,
           refund_window_days, consumption_cap_bps, course_title_snapshot, instructor_name_snapshot, is_zero_value)
         VALUES ('MP-ZV-1', $1, $2, $3, $4, 0, 0, 'EGP', 3000, 0, 0, 14, 3000, 'C', 'I', false)`,
        [adminId, courseId, versionId, instructorId],
      ),
    ).rejects.toThrow(/CHK_mp_orders_zero_value/);
  });

  it('UQ_mp_orders_open_per_course rejects a second open order for the same learner and course (FR-095, FR-096)', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    await insertOrder(adminId, courseId, versionId, instructorId, orderRow());
    await expect(
      insertOrder(adminId, courseId, versionId, instructorId, orderRow()),
    ).rejects.toThrow(/UQ_mp_orders_open_per_course/);
  });

  it('UQ_mp_enrollments_order rejects a second enrollment against the same order (FR-099, FR-100)', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    const orderNumber = `MP-ENR-${Date.now()}`;
    await insertOrder(
      adminId,
      courseId,
      versionId,
      instructorId,
      orderRow({ order_number: orderNumber }),
    );
    const [order] = (await dataSource.query(
      `SELECT id FROM marketplace_orders WHERE order_number = $1`,
      [orderNumber],
    )) as Array<{ id: string }>;
    await dataSource.query(
      `INSERT INTO marketplace_enrollments (learner_id, course_id, course_version_id, order_id)
       VALUES ($1, $2, $3, $4)`,
      [adminId, courseId, versionId, order!.id],
    );
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_enrollments (learner_id, course_id, course_version_id, order_id)
         VALUES ($1, $2, $3, $4)`,
        [adminId, courseId, versionId, order!.id],
      ),
    ).rejects.toThrow(/UQ_mp_enrollments_order/);
  });

  it('UQ_mp_earnings_order rejects a second earning for the same order (FR-141)', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    const orderNumber = `MP-EARN-${Date.now()}`;
    await insertOrder(
      adminId,
      courseId,
      versionId,
      instructorId,
      orderRow({ order_number: orderNumber }),
    );
    const [order] = (await dataSource.query(
      `SELECT id FROM marketplace_orders WHERE order_number = $1`,
      [orderNumber],
    )) as Array<{ id: string }>;
    const earning = [instructorId, order!.id, 1000, 300, 700, 'EGP', 3000, new Date()];
    await dataSource.query(
      `INSERT INTO marketplace_instructor_earnings
        (instructor_id, order_id, gross_amount_minor, commission_amount_minor, net_amount_minor, currency, commission_bps, available_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      earning,
    );
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_instructor_earnings
        (instructor_id, order_id, gross_amount_minor, commission_amount_minor, net_amount_minor, currency, commission_bps, available_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        earning,
      ),
    ).rejects.toThrow(/UQ_mp_earnings_order/);
  });

  it('CHK_mp_earnings_amount_positive rejects a zero (or negative) gross earning — no earning row for a free order (T112, FR-114)', async () => {
    const { instructorId, courseId, versionId } = await seedCourse();
    const orderNumber = `MP-EARN-ZERO-${Date.now()}`;
    const [order] = (await dataSource.query(
      `INSERT INTO marketplace_orders
        (order_number, learner_id, course_id, course_version_id, instructor_id, gross_amount_minor,
         net_amount_minor, currency, commission_bps, commission_amount_minor, instructor_earning_minor,
         refund_window_days, consumption_cap_bps, course_title_snapshot, instructor_name_snapshot, is_zero_value)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 'EGP', 3000, 0, 0, 14, 3000, 'C', 'I', true) RETURNING id`,
      [orderNumber, adminId, courseId, versionId, instructorId],
    )) as Array<{ id: string }>;

    await expect(
      dataSource.query(
        `INSERT INTO marketplace_instructor_earnings
          (instructor_id, order_id, gross_amount_minor, commission_amount_minor, net_amount_minor, currency, commission_bps, available_at)
         VALUES ($1, $2, 0, 0, 0, 'EGP', 3000, now())`,
        [instructorId, order!.id],
      ),
    ).rejects.toThrow(/CHK_mp_earnings_amount_positive/);
  });

  it('the ledger is immutable: UPDATE and DELETE on a posted entry both raise (FR-162)', async () => {
    const { instructorId } = await seedCourse();
    await dataSource.query(
      `INSERT INTO marketplace_ledger_entries (instructor_id, entry_type, amount_minor, currency, direction, reference)
       VALUES ($1, 'course_sale', 1000, 'EGP', 'credit', $2)`,
      [instructorId, `ref-${Date.now()}`],
    );
    const [entry] = (await dataSource.query(
      `SELECT id FROM marketplace_ledger_entries WHERE instructor_id = $1`,
      [instructorId],
    )) as Array<{ id: string }>;

    await expect(
      dataSource.query(`UPDATE marketplace_ledger_entries SET amount_minor = 1 WHERE id = $1`, [
        entry!.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      dataSource.query(`DELETE FROM marketplace_ledger_entries WHERE id = $1`, [entry!.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('UQ_mp_ledger_reference makes a replayed post a no-op conflict, never a duplicate row (FR-171)', async () => {
    const { instructorId } = await seedCourse();
    const reference = `dup-ref-${Date.now()}`;
    await dataSource.query(
      `INSERT INTO marketplace_ledger_entries (instructor_id, entry_type, amount_minor, currency, direction, reference)
       VALUES ($1, 'course_sale', 1000, 'EGP', 'credit', $2)`,
      [instructorId, reference],
    );
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_ledger_entries (instructor_id, entry_type, amount_minor, currency, direction, reference)
         VALUES ($1, 'course_sale', 1000, 'EGP', 'credit', $2)`,
        [instructorId, reference],
      ),
    ).rejects.toThrow(/UQ_mp_ledger_reference/);
  });

  it('CHK_mp_ledger_adjustment_reason requires an actor and a reason for a manual_adjustment entry (FR-168)', async () => {
    const { instructorId } = await seedCourse();
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_ledger_entries (instructor_id, entry_type, amount_minor, currency, direction, reference)
         VALUES ($1, 'manual_adjustment', 1000, 'EGP', 'credit', $2)`,
        [instructorId, `adj-${Date.now()}`],
      ),
    ).rejects.toThrow(/CHK_mp_ledger_adjustment_reason/);
  });

  it('the currency registry seeds exactly the launch EGP row from spec.md §Y (FR-325)', async () => {
    const rows = (await dataSource.query(`SELECT * FROM marketplace_currencies`)) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'EGP',
      minor_unit_exponent: 2,
      is_enabled: true,
      min_price_minor: '5000',
      max_price_minor: '2000000',
      min_payout_minor: '50000',
    });
  });

  it('CHK_mp_currencies_bounds rejects a registry row whose maximum is not above its minimum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO marketplace_currencies (code, minor_unit_exponent, min_price_minor, max_price_minor, min_payout_minor)
         VALUES ('USD', 2, 1000, 1000, 100)`,
      ),
    ).rejects.toThrow(/CHK_mp_currencies_bounds/);
  });

  it('seeds exactly the eleven FR-037 categories with a bilingual name each', async () => {
    const rows = (await dataSource.query(
      `SELECT name_en, name_ar FROM marketplace_categories ORDER BY display_order`,
    )) as Array<{ name_en: string; name_ar: string }>;
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.name_en.length).toBeGreaterThan(0);
      expect(row.name_ar.length).toBeGreaterThan(0);
    }
    expect(rows.map((r) => r.name_en)).toContain('Other Professional Skills');
  });

  /** Creates a minimal valid academic `lesson_packages` row and returns its id. */
  async function seedAcademicPackage(): Promise<string> {
    const [pkg] = (await dataSource.query(
      `INSERT INTO lesson_packages (title, title_ar, teacher_id, price)
       VALUES ('Academic Course', 'دورة أكاديمية', $1, 100)
       RETURNING id`,
      [adminId],
    )) as Array<{ id: string }>;
    return pkg!.id;
  }

  it('a freshly issued academic certificate defaults source to academic without the caller stating it (FR-322)', async () => {
    const packageId = await seedAcademicPackage();
    await dataSource.query(
      `INSERT INTO certificates (certificate_number, verification_code, student_id, package_id, student_name, course_title, issued_at)
       VALUES ('CERT-ACAD-1', 'VERIFY-ACAD-1', $1, $2, 'S', 'C', now())`,
      [adminId, packageId],
    );
    const [row] = (await dataSource.query(
      `SELECT source, package_id, marketplace_course_id FROM certificates WHERE certificate_number = 'CERT-ACAD-1'`,
    )) as Array<{ source: string; package_id: string; marketplace_course_id: string | null }>;
    expect(row).toMatchObject({
      source: 'academic',
      package_id: packageId,
      marketplace_course_id: null,
    });
  });

  it('CHK_certificates_one_subject rejects a row naming both an academic package and a marketplace course', async () => {
    const { courseId } = await seedCourse();
    const packageId = await seedAcademicPackage();

    await expect(
      dataSource.query(
        `INSERT INTO certificates
          (certificate_number, verification_code, student_id, package_id, marketplace_course_id, student_name, course_title, issued_at)
         VALUES ('CERT-BOTH', 'VERIFY-BOTH', $1, $2, $3, 'S', 'C', now())`,
        [adminId, packageId, courseId],
      ),
    ).rejects.toThrow(/CHK_certificates_one_subject/);
  });

  it('CHK_certificates_one_subject rejects a row naming neither an academic package nor a marketplace course', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO certificates
          (certificate_number, verification_code, student_id, student_name, course_title, issued_at)
         VALUES ('CERT-NEITHER', 'VERIFY-NEITHER', $1, 'S', 'C', now())`,
        [adminId],
      ),
    ).rejects.toThrow(/CHK_certificates_one_subject/);
  });

  it('accepts a marketplace-sourced certificate naming only marketplace_course_id', async () => {
    const { courseId } = await seedCourse();
    await dataSource.query(
      `INSERT INTO certificates
        (certificate_number, verification_code, student_id, marketplace_course_id, source, student_name, course_title, issued_at)
       VALUES ('CERT-MP-1', 'VERIFY-MP-1', $1, $2, 'marketplace', 'S', 'C', now())`,
      [adminId, courseId],
    );
    const [row] = (await dataSource.query(
      `SELECT source, package_id, marketplace_course_id FROM certificates WHERE certificate_number = 'CERT-MP-1'`,
    )) as Array<{ source: string; package_id: string | null; marketplace_course_id: string }>;
    expect(row).toMatchObject({
      source: 'marketplace',
      package_id: null,
      marketplace_course_id: courseId,
    });
  });

  /**
   * T029 integration coverage: balance derivation against real rows,
   * matching spec.md's Balance derivation table exactly. Nested inside the
   * outer describe so it reuses the same app boot, migrations and `adminId`
   * seeding rather than paying for a second `createE2EApp()`.
   */
  describe('LedgerService.deriveBalance (spec.md §Balance derivation)', () => {
    let ledgerService: LedgerService;

    beforeAll(() => {
      ledgerService = new LedgerService(
        dataSource.getRepository(MarketplaceLedgerEntry),
        dataSource.getRepository(InstructorEarning),
        new MarketplaceMoneyService({ resolve: jest.fn() } as never),
      );
    });

    async function seedInstructor(): Promise<string> {
      const { instructorId } = await seedCourse();
      return instructorId;
    }

    async function seedEarning(
      instructorId: string,
      status: string,
      netAmountMinor: number,
      currency = 'EGP',
    ): Promise<void> {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const [category] = (await dataSource.query(
        `SELECT id FROM marketplace_categories LIMIT 1`,
      )) as Array<{
        id: string;
      }>;
      const [course] = (await dataSource.query(
        `INSERT INTO marketplace_courses
        (instructor_id, category_id, slug, title, summary, description, level, language, currency, cover_image_key)
       VALUES ($1, $2, $3, 'Course', 'Summary', 'Description', 'beginner', 'en', $4, 'key') RETURNING id`,
        [instructorId, category!.id, `course-${suffix}`, currency],
      )) as Array<{ id: string }>;
      const [version] = (await dataSource.query(
        `INSERT INTO marketplace_course_versions (course_id, version_number, snapshot, published_by)
       VALUES ($1, 1, '{}', $2) RETURNING id`,
        [course!.id, adminId],
      )) as Array<{ id: string }>;
      const grossAmountMinor = netAmountMinor + 300;
      const [order] = (await dataSource.query(
        `INSERT INTO marketplace_orders (order_number, learner_id, course_id, course_version_id, instructor_id,
        gross_amount_minor, net_amount_minor, currency, commission_bps, commission_amount_minor,
        instructor_earning_minor, refund_window_days, consumption_cap_bps, course_title_snapshot, instructor_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 3000, 300, $8, 14, 3000, 'C', 'I') RETURNING id`,
        [
          `MP-BAL-${suffix}`,
          adminId,
          course!.id,
          version!.id,
          instructorId,
          grossAmountMinor,
          currency,
          netAmountMinor,
        ],
      )) as Array<{ id: string }>;
      await dataSource.query(
        `INSERT INTO marketplace_instructor_earnings
        (instructor_id, order_id, gross_amount_minor, commission_amount_minor, net_amount_minor, currency, commission_bps, status, available_at)
       VALUES ($1, $2, $3, 300, $4, $5, 3000, $6, now())`,
        [instructorId, order!.id, grossAmountMinor, netAmountMinor, currency, status],
      );
    }

    it('sums pending, clearing and requested earnings by status, scoped to one currency', async () => {
      const instructorId = await seedInstructor();
      await seedEarning(instructorId, 'pending_earnings', 1000);
      await seedEarning(instructorId, 'pending_earnings', 2000);
      await seedEarning(instructorId, 'refund_clearance', 500);
      await seedEarning(instructorId, 'payout_requested', 700);
      await seedEarning(instructorId, 'processing', 300);
      await seedEarning(instructorId, 'available_balance', 900);

      const balance = await ledgerService.deriveBalance(instructorId, 'EGP');

      expect(balance.pendingMinor).toBe(3000);
      expect(balance.clearingMinor).toBe(500);
      expect(balance.requestedMinor).toBe(1000); // payout_requested + processing
      expect(balance.availableMinor).toBe(900);
    });

    it('adds manual_adjustment ledger entries on top of the available_balance earnings sum', async () => {
      const instructorId = await seedInstructor();
      await seedEarning(instructorId, 'available_balance', 1000);
      await ledgerService.post({
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
        amountMinor: 200,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.CREDIT,
        reference: `manual_adjustment:${instructorId}:1`,
        createdBy: adminId,
        metadata: { reason: 'goodwill credit' },
      });
      await ledgerService.post({
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
        amountMinor: 50,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.DEBIT,
        reference: `manual_adjustment:${instructorId}:2`,
        createdBy: adminId,
        metadata: { reason: 'correction' },
      });

      const balance = await ledgerService.deriveBalance(instructorId, 'EGP');

      expect(balance.availableMinor).toBe(1000 + 200 - 50);
    });

    it('derives paid-out as PAYOUT credits less PAYOUT_REVERSAL debits', async () => {
      const instructorId = await seedInstructor();
      await ledgerService.post({
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.PAYOUT,
        amountMinor: 5000,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.DEBIT,
        reference: `payout:${instructorId}:1`,
      });
      await ledgerService.post({
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.PAYOUT_REVERSAL,
        amountMinor: 1200,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.CREDIT,
        reference: `payout_reversal:${instructorId}:1`,
      });

      const balance = await ledgerService.deriveBalance(instructorId, 'EGP');

      expect(balance.paidOutMinor).toBe(5000 - 1200);
    });

    it('derives reversed as the sum of REFUND ledger entries', async () => {
      const instructorId = await seedInstructor();
      await ledgerService.post({
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.REFUND,
        amountMinor: 800,
        currency: 'EGP',
        direction: MarketplaceLedgerDirection.DEBIT,
        reference: `refund:${instructorId}:1`,
      });

      const balance = await ledgerService.deriveBalance(instructorId, 'EGP');

      expect(balance.reversedMinor).toBe(800);
    });

    it('never mixes currencies in one balance figure', async () => {
      const instructorId = await seedInstructor();
      await seedEarning(instructorId, 'pending_earnings', 1000, 'EGP');
      await seedEarning(instructorId, 'pending_earnings', 500, 'KWD');

      const egpBalance = await ledgerService.deriveBalance(instructorId, 'EGP');
      const kwdBalance = await ledgerService.deriveBalance(instructorId, 'KWD');

      expect(egpBalance.pendingMinor).toBe(1000);
      expect(kwdBalance.pendingMinor).toBe(500);
    });

    /**
     * T067 (W4-C5): the grouped derivation must equal the per-pair derivation for every
     * (instructor, currency) pair, in two statements, without ever joining earnings to the
     * ledger before summing. The fixture carries every bucket: all earning statuses,
     * manual adjustments in both directions, payouts in both directions, a payout reversal,
     * refunds, refund shortfall, a ledger-only currency (must stay excluded), a negative
     * available balance, and a second instructor in a shared currency.
     */
    describe('grouped balances (T067)', () => {
      const E = MarketplaceLedgerEntryType;
      const D = MarketplaceLedgerDirection;
      let referenceCounter = 0;

      async function seedInstructorWithUser(tag: string): Promise<string> {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const [user] = (await dataSource.query(
          `INSERT INTO "users" (username, name, email, phone, role)
         VALUES ($1, $2, $3, $4, 'student') RETURNING id`,
          [
            `t067-${tag}-${suffix}`,
            `T067 ${tag}`,
            `t067-${tag}-${suffix}@example.com`,
            `0122${String(40_000_000 + (referenceCounter += 1))}`,
          ],
        )) as Array<{ id: string }>;
        const [application] = (await dataSource.query(
          `INSERT INTO marketplace_instructor_applications (user_id, display_name, years_of_experience)
         VALUES ($1, 'T067 Instructor', 3) RETURNING id`,
          [user!.id],
        )) as Array<{ id: string }>;
        const [instructor] = (await dataSource.query(
          `INSERT INTO marketplace_instructors (user_id, application_id, slug, display_name, approved_by)
         VALUES ($1, $2, $3, 'T067 Instructor', $4) RETURNING id`,
          [user!.id, application!.id, `t067-${tag}-${suffix}`, adminId],
        )) as Array<{ id: string }>;
        return instructor!.id;
      }

      async function earning(
        instructorId: string,
        status: string,
        netAmountMinor: number,
        currency: string,
      ): Promise<void> {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const [category] = (await dataSource.query(
          `SELECT id FROM marketplace_categories LIMIT 1`,
        )) as Array<{
          id: string;
        }>;
        const [course] = (await dataSource.query(
          `INSERT INTO marketplace_courses
          (instructor_id, category_id, slug, title, summary, description, level, language, currency, cover_image_key)
         VALUES ($1, $2, $3, 'Course', 'Summary', 'Description', 'beginner', 'en', $4, 'key') RETURNING id`,
          [instructorId, category!.id, `course-${suffix}`, currency],
        )) as Array<{ id: string }>;
        const [version] = (await dataSource.query(
          `INSERT INTO marketplace_course_versions (course_id, version_number, snapshot, published_by)
         VALUES ($1, 1, '{}', $2) RETURNING id`,
          [course!.id, adminId],
        )) as Array<{ id: string }>;
        const gross = netAmountMinor + 300;
        const [order] = (await dataSource.query(
          `INSERT INTO marketplace_orders (order_number, learner_id, course_id, course_version_id, instructor_id,
          gross_amount_minor, net_amount_minor, currency, commission_bps, commission_amount_minor,
          instructor_earning_minor, refund_window_days, consumption_cap_bps, course_title_snapshot, instructor_name_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 3000, 300, $8, 14, 3000, 'C', 'I') RETURNING id`,
          [
            `MP-GRP-${suffix}`,
            adminId,
            course!.id,
            version!.id,
            instructorId,
            gross,
            currency,
            netAmountMinor,
          ],
        )) as Array<{ id: string }>;
        await dataSource.query(
          `INSERT INTO marketplace_instructor_earnings
          (instructor_id, order_id, gross_amount_minor, commission_amount_minor, net_amount_minor, currency, commission_bps, status, available_at)
         VALUES ($1, $2, $3, 300, $4, $5, 3000, $6, now())`,
          [instructorId, order!.id, gross, netAmountMinor, currency, status],
        );
      }

      async function ledger(
        ledgerService: LedgerService,
        instructorId: string,
        entryType: MarketplaceLedgerEntryType,
        direction: MarketplaceLedgerDirection,
        amountMinor: number,
        currency: string,
      ): Promise<void> {
        referenceCounter += 1;
        await ledgerService.post({
          instructorId,
          orderId: null,
          entryType,
          amountMinor,
          currency,
          direction,
          reference: `t067:${instructorId}:${String(referenceCounter)}`,
          ...(entryType === E.MANUAL_ADJUSTMENT
            ? { createdBy: adminId, metadata: { reason: 't067' } }
            : {}),
        });
      }

      it('equals the per-pair derivation for every pair, in 2 statements, excluding ledger-only currencies', async () => {
        const ledgerService = new LedgerService(
          dataSource.getRepository(MarketplaceLedgerEntry),
          dataSource.getRepository(InstructorEarning),
          new MarketplaceMoneyService({ resolve: jest.fn() } as never),
        );
        const balanceService = new BalanceService(
          ledgerService,
          dataSource.getRepository(MarketplaceLedgerEntry),
        );
        const reconciliation = new ReconciliationService(
          dataSource.getRepository(InstructorEarning),
          dataSource.getRepository(MarketplaceLedgerEntry),
          balanceService,
        );

        const i1 = await seedInstructorWithUser('one');
        const i2 = await seedInstructorWithUser('two');

        // Instructor 1, EGP: every earning status plus every ledger bucket.
        for (const [status, amount] of [
          ['pending_earnings', 1000],
          ['pending_earnings', 2000],
          ['refund_clearance', 500],
          ['payout_requested', 700],
          ['processing', 300],
          ['available_balance', 900],
          ['available_balance', 100],
          ['paid_out', 250],
          ['reversed', 111],
        ] as const) {
          await earning(i1, status, amount, 'EGP');
        }
        await ledger(ledgerService, i1, E.MANUAL_ADJUSTMENT, D.CREDIT, 400, 'EGP');
        await ledger(ledgerService, i1, E.MANUAL_ADJUSTMENT, D.CREDIT, 25, 'EGP');
        await ledger(ledgerService, i1, E.MANUAL_ADJUSTMENT, D.DEBIT, 150, 'EGP');
        await ledger(ledgerService, i1, E.PAYOUT, D.DEBIT, 5000, 'EGP');
        await ledger(ledgerService, i1, E.PAYOUT, D.CREDIT, 70, 'EGP'); // direction-insensitive
        await ledger(ledgerService, i1, E.PAYOUT_REVERSAL, D.CREDIT, 1200, 'EGP');
        await ledger(ledgerService, i1, E.REFUND, D.DEBIT, 800, 'EGP');
        await ledger(ledgerService, i1, E.REFUND, D.CREDIT, 33, 'EGP'); // direction-insensitive
        await ledger(ledgerService, i1, E.REFUND_SHORTFALL, D.DEBIT, 75, 'EGP');
        await ledger(ledgerService, i1, E.REFUND_SHORTFALL, D.DEBIT, 25, 'EGP');
        await ledger(ledgerService, i1, E.REFUND_SHORTFALL, D.CREDIT, 9999, 'EGP'); // not a shortfall
        // Instructor 1, KWD: earnings and a debit only.
        await earning(i1, 'pending_earnings', 500, 'KWD');
        await earning(i1, 'available_balance', 300, 'KWD');
        await ledger(ledgerService, i1, E.MANUAL_ADJUSTMENT, D.DEBIT, 100, 'KWD');
        // Instructor 1, GBP: ledger entries but NO earnings -> not a pair, must stay excluded.
        await ledger(ledgerService, i1, E.MANUAL_ADJUSTMENT, D.CREDIT, 999, 'GBP');
        await ledger(ledgerService, i1, E.REFUND_SHORTFALL, D.DEBIT, 11, 'GBP');
        // Instructor 2: a negative available balance in EGP, only earnings in KWD, nothing in the ledger for KWD.
        await earning(i2, 'available_balance', 100, 'EGP');
        await ledger(ledgerService, i2, E.MANUAL_ADJUSTMENT, D.DEBIT, 400, 'EGP');
        await earning(i2, 'pending_earnings', 50, 'KWD');

        const pairs = (await dataSource.query(
          `SELECT DISTINCT instructor_id, currency FROM marketplace_instructor_earnings`,
        )) as Array<{ instructor_id: string; currency: string }>;
        expect(pairs).toHaveLength(4);

        const grouped = await balanceService.getBalancesGrouped();

        expect(grouped).toHaveLength(pairs.length);
        for (const pair of pairs) {
          const perPair = await balanceService.getBalance(pair.instructor_id, pair.currency);
          const match = grouped.find(
            (row) => row.instructorId === pair.instructor_id && row.currency === pair.currency,
          );
          expect(match).toBeDefined();
          const { instructorId: _instructorId, ...rest } = match!;
          expect(rest).toEqual(perPair);
        }
        // Documented figures for instructor 1 EGP, so a shared bug in both paths cannot hide.
        const one = grouped.find((row) => row.instructorId === i1 && row.currency === 'EGP')!;
        expect(one).toMatchObject({
          pendingMinor: 3000,
          clearingMinor: 500,
          requestedMinor: 1000,
          availableMinor: 900 + 100 + 400 + 25 - 150,
          paidOutMinor: 5000 + 70 - 1200,
          reversedMinor: 800 + 33,
          shortfallMinor: 100,
        });
        expect(grouped.some((row) => row.currency === 'GBP')).toBe(false);

        // getAllBalances: the instructor's own pairs only, in the original (instructor-less) shape.
        const all = await balanceService.getAllBalances(i1);
        const byCurrency = (rows: Array<{ currency: string }>) =>
          [...rows].sort((a, b) => a.currency.localeCompare(b.currency));
        expect(byCurrency(all)).toEqual(
          byCurrency(
            await Promise.all(['EGP', 'KWD'].map(async (c) => balanceService.getBalance(i1, c))),
          ),
        );
        expect(all.every((row) => !('instructorId' in row))).toBe(true);
        expect(await balanceService.getAllBalances('00000000-0000-4000-8000-000000000000')).toEqual(
          [],
        );

        // Reconciliation reports exactly the negative pairs the per-pair loop would.
        const expectedNegative: Array<{
          instructor_id: string;
          currency: string;
          available_minor: number;
        }> = [];
        for (const pair of pairs) {
          const derived = await balanceService.getBalance(pair.instructor_id, pair.currency);
          if (derived.availableMinor < 0) {
            expectedNegative.push({
              instructor_id: pair.instructor_id,
              currency: pair.currency,
              available_minor: derived.availableMinor,
            });
          }
        }
        const report = await reconciliation.getDivergenceReport();
        expect(report['negative_available_balances']).toEqual(expectedNegative);
        expect(expectedNegative).toEqual([
          { instructor_id: i2, currency: 'EGP', available_minor: -300 },
        ]);

        // Statement counts: 2 for the whole grouped derivation (was 9 per pair plus the pair list).
        const counter = new StatementCounter(dataSource);
        counter.start();
        await balanceService.getBalancesGrouped();
        counter.stop();
        expect(counter.count()).toBe(2);
        counter.start();
        await balanceService.getAllBalances(i1);
        counter.stop();
        expect(counter.count()).toBe(2);
        // Neither statement joins earnings to the ledger.
        for (const statement of counter.statements()) {
          const touchesBoth =
            statement.sql.includes('marketplace_instructor_earnings') &&
            statement.sql.includes('marketplace_ledger_entries');
          expect(touchesBoth).toBe(false);
        }
      });
    });
  });
});
