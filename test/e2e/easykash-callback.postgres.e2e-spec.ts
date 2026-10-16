import * as crypto from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import {
  CollectionParty,
  Entitlement,
  ItemType,
  Order,
  OrderStatus,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createE2EApp, resetDatabase } from './fixtures';

const HMAC_SECRET = 'e2e-easykash-hmac-secret';
const PRODUCT_CODE = 'E2EPROD1';

/**
 * Signed EasyKash callback → grant, over real HTTP and a real database.
 * Only the outbound EasyKash API is absent (no network); the callback path,
 * HMAC verification, amount binding, idempotency and the browser return
 * endpoint are the production code.
 */
describe('EasyKash callback and return (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['EASYKASH_API_KEY', 'EASYKASH_HMAC_SECRET', 'BACKEND_URL']) {
      saved[key] = process.env[key];
    }
    process.env['EASYKASH_API_KEY'] = 'e2e-api-key';
    process.env['EASYKASH_HMAC_SECRET'] = HMAC_SECRET;
    process.env['BACKEND_URL'] ??= 'http://localhost:3001';
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function sign(payload: Record<string, string>): Record<string, string> {
    const content = [
      'ProductCode',
      'Amount',
      'ProductType',
      'PaymentMethod',
      'status',
      'easykashRef',
      'customerReference',
    ]
      .map((key) => payload[key])
      .join('');
    return {
      ...payload,
      signatureHash: crypto.createHmac('sha512', HMAC_SECRET).update(content).digest('hex'),
    };
  }

  const callback = (payment: Payment, overrides: Record<string, string> = {}) =>
    sign({
      ProductCode: PRODUCT_CODE,
      Amount: '100.00',
      ProductType: 'Direct Pay',
      PaymentMethod: 'Credit & Debit Card',
      status: 'PAID',
      easykashRef: '5550001',
      customerReference: payment.id,
      ...overrides,
    });

  async function seed(provider = 'easykash'): Promise<{ payment: Payment; order: Order }> {
    const users = dataSource.getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'ek-teacher',
        name: 'Teacher',
        first_name: null,
        last_name: null,
        email: 'ek-teacher@example.test',
        phone: '01000000011',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const student = await users.save(
      users.create({
        username: 'ek-student',
        name: 'Student',
        first_name: null,
        last_name: null,
        email: 'ek-student@example.test',
        phone: '01000000012',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const subject = await dataSource.getRepository(Subject).save(
      dataSource.getRepository(Subject).create({
        name: 'EK subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
      }),
    );
    const lessons = dataSource.getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'EK lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        video_asset_id: null,
        video_status: null,
        video_width: null,
        video_height: null,
        video_thumbnail: null,
        video_size_bytes: null,
        price: 100,
        duration: null,
      }),
    );
    const orders = dataSource.getRepository(Order);
    const order = await orders.save(
      orders.create({
        order_number: `EK-ORDER-${provider}`,
        student_id: student.id,
        teacher_id: teacher.id,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        quantity: 1,
        original_amount_minor: 10_000,
        discount_amount_minor: 0,
        final_amount_minor: 10_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: provider,
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: lesson.title,
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 3000,
        teacher_earning_minor: 7000,
        discount_snapshot: null,
        metadata: { access_duration_days: 7 },
        expires_at: new Date(Date.now() + 3_600_000),
        paid_at: null,
        cancelled_at: null,
      }),
    );
    const payments = dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: student.id,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider,
        provider_reference: PRODUCT_CODE,
        provider_order_reference: PRODUCT_CODE,
        provider_transaction_id: null,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `ek-key-${provider}`,
        failure_reason: null,
        completed_at: null,
      }),
    );
    order.payment_id = payment.id;
    await orders.save(order);
    return { payment, order };
  }

  const post = (body: Record<string, string>) =>
    request(app.getHttpServer()).post(`${API_PREFIX}/payments/webhook`).send(body);

  it('grants access once for a validly signed callback and ignores a replay', async () => {
    const { payment, order } = await seed();

    const first = await post(callback(payment));
    expect(first.status).toBeLessThan(300);
    expect(first.body.status ?? first.body.data?.status).toBe('success');

    const replay = await post(callback(payment));
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.status ?? replay.body.data?.status).toBe('already_processed');

    const stored = await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id });
    expect(stored.status).toBe(PaymentStatus.COMPLETED);
    expect(stored.provider).toBe('easykash');
    expect(stored.provider_transaction_id).toBe('5550001');
    expect((await dataSource.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(
      OrderStatus.PAID,
    );
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(1);
  });

  it('rejects a callback with a tampered or missing signature without granting access', async () => {
    const { payment, order } = await seed();

    const tampered = { ...callback(payment), Amount: '1.00' };
    expect((await post(tampered)).status).toBe(401);
    const unsigned: Record<string, string> = { ...callback(payment) };
    delete unsigned['signatureHash'];
    expect((await post(unsigned)).status).toBe(401);

    expect(
      (await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })).status,
    ).toBe(PaymentStatus.PROCESSING);
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
  });

  it('rejects a correctly signed callback whose amount does not match the order', async () => {
    const { payment, order } = await seed();

    const res = await post(callback(payment, { Amount: '1.00' }));

    expect(res.status).toBe(400);
    expect(
      (await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })).status,
    ).toBe(PaymentStatus.PROCESSING);
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
  });

  it('rejects a signed callback for a different product code than the stored order', async () => {
    const { payment, order } = await seed();

    const res = await post(callback(payment, { ProductCode: 'OTHER999' }));

    expect(res.status).toBe(400);
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
  });

  it('answers 404 for an unknown merchant reference', async () => {
    const { payment } = await seed();

    const res = await post(
      callback(payment, { customerReference: '00000000-0000-4000-8000-000000000000' }),
    );

    expect(res.status).toBe(404);
  });

  it('never applies an EasyKash callback to a historical Paymob payment', async () => {
    const { payment, order } = await seed('paymob');

    const res = await post(callback(payment));

    expect(res.status).toBe(400);
    const stored = await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id });
    expect(stored.provider).toBe('paymob');
    expect(stored.status).toBe(PaymentStatus.PROCESSING);
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
  });

  it('redirects the browser return to the frontend without confirming any payment', async () => {
    const { payment, order } = await seed();

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/payments/easykash/return/${payment.id}`)
      .query({ status: 'success', providerRefNum: '1', customerReference: payment.id });

    expect(res.status).toBe(302);
    expect(String(res.headers['location'])).toMatch(
      new RegExp(`/student/payment-return[?]orderId=${order.id}&gateway_status=success$`),
    );
    expect(
      (await dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })).status,
    ).toBe(PaymentStatus.PROCESSING);
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
  });

  it('rejects a non-UUID payment id on the return endpoint', async () => {
    const res = await request(app.getHttpServer()).get(
      `${API_PREFIX}/payments/easykash/return/not-a-uuid`,
    );
    expect(res.status).toBe(400);
  });
});
