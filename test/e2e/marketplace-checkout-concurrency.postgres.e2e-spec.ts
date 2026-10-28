import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { ItemType } from '../../src/payments/entities/item-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '../../src/payments/providers/payment-gateway.interface';
import { buildInstructorFixture } from './factories/marketplace.factory';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

jest.setTimeout(180_000);

const BILLING = {
  first_name: 'Nour',
  last_name: 'Ahmed',
  email: 'nour@example.com',
  phone_number: '01012345678',
};

/**
 * SOLID audit Phase 1 (S-02). Two `POST .../orders/:id/pay` requests with DIFFERENT
 * Idempotency-Keys race on one marketplace order (a double click across tabs, or a client that
 * regenerates its key on retry). The idempotency cache cannot help — the keys differ — so only
 * the claim taken under the order/payment row locks stops a second provider order. The gateway is
 * stubbed with a slow `createCheckoutOrder` so the race window is wide and deterministic.
 */
describe('marketplace checkout — concurrent initiation (e2e, Postgres)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let gateway: PaymentGateway;
  let createCheckoutOrder: jest.SpyInstance;
  let createCheckoutSession: jest.SpyInstance;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    createCheckoutOrder = jest.spyOn(gateway, 'createCheckoutOrder').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(`provider-order-${String(Math.random()).slice(2, 10)}`), 400);
        }),
    );
    createCheckoutSession = jest
      .spyOn(gateway, 'createCheckoutSession')
      .mockImplementation((_input, providerReference) =>
        Promise.resolve({
          redirectUrl: `https://pay.example.test/${providerReference}`,
          providerReference,
        }),
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => app.close());

  async function seedPaidCourseOrder() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Checkout Concurrency Course ${Date.now()}`,
        summary: 'Learn to build backend systems',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 5000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Build a REST API'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);
    await dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } });

    const order = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({ courseId })
      .expect(201);
    return { learner, orderId: order.body.id as string };
  }

  const pay = (
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    orderId: string,
    key: string,
  ) =>
    learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders/${orderId}/pay`)
      .set('Idempotency-Key', key)
      .send(BILLING);

  it('creates exactly one provider order and one Payment when two different-key requests race', async () => {
    const { learner, orderId } = await seedPaidCourseOrder();

    const [a, b] = await Promise.all([
      pay(learner, orderId, 'race-key-a'),
      pay(learner, orderId, 'race-key-b'),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(createCheckoutOrder).toHaveBeenCalledTimes(1);

    const payments = await dataSource
      .getRepository(Payment)
      .find({ where: { item_type: ItemType.MARKETPLACE_COURSE, item_id: orderId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: PaymentStatus.PROCESSING });
    expect(payments[0]?.provider_order_reference).toMatch(/^provider-order-/);

    const order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: orderId });
    expect(order.payment_id).toBe(payments[0]?.id);
  });

  it('lets a later retry with a new key reuse the stored provider order instead of creating another', async () => {
    const { learner, orderId } = await seedPaidCourseOrder();

    const first = await pay(learner, orderId, 'sequential-key-a').expect(201);
    const second = await pay(learner, orderId, 'sequential-key-b').expect(201);

    expect(createCheckoutOrder).toHaveBeenCalledTimes(1);
    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(second.body.payment_id).toBe(first.body.payment_id);
  });
});
