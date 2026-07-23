# Learnix Unified Payment and Entitlement System

## Purpose

Learnix has one commerce pipeline for three permanent payment channels:

1. paid activation codes;
2. admin-reviewed manual payments; and
3. online payment gateways.

The channel proves how money was paid. It does not decide how access, commission,
earnings, refunds, or settlement work. Every successful channel ends in
`PaymentFinalizationService.finalizeSuccessfulPayment()`, inside one database
transaction.

In non-technical terms: a student always receives a Learnix order first. Learnix
does not unlock content because a browser says payment succeeded, because a
receipt was uploaded, or because a code was typed. The trusted backend verifies
the source, records the payment, grants access, and records both the platform and
teacher sides of the sale together.

## Architecture found and reused

The implementation extends the existing NestJS/TypeORM/PostgreSQL application
instead of replacing it:

- `Payment`, `LessonPurchase`, `PackagePurchase`, and `BookPurchase` remain
  compatibility records used by existing content APIs.
- EasyKash remains the configured gateway and its documented HMAC verification
  remains the callback trust boundary.
- `DiscountCodesService` remains independent from activation codes.
- the existing `AttendanceCode`, `CodeBatch`, BullMQ code-generation worker,
  audit rows, and secure export workflow remain in use;
- `StorageService` stores manual receipts privately and creates short-lived
  reviewer URLs;
- Nest authentication, role guards, DTO validation, CSRF handling, throttling,
  notifications, schedules, and event emitter infrastructure remain in use.

The previous independent code-redemption access grant and gateway purchase
routes now feed the canonical order/finalization path. Compatibility purchase
rows are written by finalization so existing lesson, course, exam, homework, and
book surfaces continue to work during migration.

The audited purchasable types are `lesson`, `package` (course), and `book`.
Learnix currently has exams, but no exam price/ownership purchase model;
subscriptions and bundles are not modeled either. They were therefore not
invented as fake products. Adding a future paid type requires a product snapshot
loader plus an entitlement compatibility adapter, while the order, payment,
ledger, refund, and settlement pipeline remains unchanged.

## Canonical domain

### Order

`orders` is the immutable commercial snapshot. It records the student, seller,
product, original price, discount, final amount, currency, channel, collection
party, product/seller labels, 30% commission snapshot, teacher earning snapshot,
expiration, payment, refund totals, and lifecycle timestamps.

Money is stored as integer minor units. For EGP, `10000` means EGP 100.00.
Floating-point frontend values are never accepted as accounting truth.

Active-order uniqueness prevents simultaneous unpaid orders for the same
student/product. Expired, rejected, cancelled, and failed attempts can be
retried legitimately.

Expired lesson access can be reopened through the same order pipeline. The
backend validates the prior purchase, snapshots the 50% reopen price adjustment
in minor units, and starts canonical hosted checkout; the compatibility reopen
route no longer grants access through a separate payment path.

### Payment

`payments` remains the payment-attempt record and now references its canonical
order. It records channel, provider, verified provider reference, currency, and
minor-unit amount. One order can have only one canonical successful payment in
the current product model.

### Entitlement

`entitlements` is the source of truth for paid access. It records the student,
product, source order/channel, start, expiry, status, and revocation. The
finalizer also writes the existing purchase tables for backward-compatible
content queries. Refunds revoke both layers. Existing raw purchase checks now
exclude rows whose `revoked_at` is set.

### Ledger

`financial_ledger_entries` is append-only. Every entry has a unique reference,
order, payment, teacher, account, entry type, integer amount, currency,
debit/credit direction, availability, source channel, collection party, and
optional settlement.

Platform-collected sale:

- debit platform cash for gross;
- credit platform revenue for commission;
- credit teacher payable (pending during the refund hold, otherwise available)
  for the teacher share.

Teacher/center/agent-collected activation-code sale:

- debit collecting-party cash control for gross;
- credit the teacher-collected earning account for the teacher share;
- credit platform receivable for commission.

Historical records with an unknown collector are never reinterpreted as platform
cash. New sales with `collection_party=unknown` post equal debit/credit suspense
entries and appear in reconciliation; they do not create teacher earnings or a
settlement balance.

The default commission is 3000 basis points (30%). The order/code snapshot wins
over later configuration changes. Commission rounds down to the minor unit and
the residual belongs to the teacher, so:

`gross = platform commission + teacher earning`

## Student purchase journeys

### Online gateway

1. The student requests a server quote.
2. The server loads the product and seller, verifies ownership, validates the
   discount, and calculates the EGP total.
3. The server creates the order and pending payment.
4. The provider adapter creates hosted checkout using that trusted total.
5. The browser may return to Learnix, but remains in processing state.
6. EasyKash sends a signed callback.
7. Learnix verifies the HMAC, derives a unique event ID from the signed
   transition fields, persists that event, verifies amount/currency, and
   invokes the finalizer. The stable provider reference identifies the payment;
   it is not incorrectly treated as the webhook event ID, so a later `paid`
   transition is accepted after an earlier `new` transition while exact replay
   is still deduplicated.
8. Only then are payment, access, ledger, events, notifications, and audit
   committed.

The provider interface isolates checkout, status inquiry, refund, payout, and
split-settlement capabilities. Internal commission and settlement do not assume
the provider can split marketplace funds. A future provider is registered in
`PaymentProviderRegistry` without changing order finalization.

### Manual payment

1. An admin configures an enabled method (bank transfer, InstaPay, wallet,
   office cash, or another offline destination).
2. The student creates an expiring manual order.
3. Sensitive destination details are returned only to that authenticated
   student while the order is active.
4. The student transfers the exact amount and uploads a PDF/JPEG/PNG/WebP proof
   up to 5 MB.
5. The backend checks file signatures, uses a random private object key, hashes
   the file, and detects duplicate files/references.
6. Uploading proof changes the order to `payment_submitted`; it never grants
   access.
7. An admin starts review and approves, rejects, or requests more information.
8. Approval verifies the amount, currency, order state, transaction reference,
   and any audited expiry override, then calls the shared finalizer.

Concurrent approvals serialize on the submission and order locks. Once one
approval pays the order, another submission cannot approve it.

### Paid activation code

Code batches snapshot product, teacher, face value, currency, commission,
collection party, expiry, distribution notes, and export permission. Generated
codes receive an indexed SHA-256 lookup digest. Student verification and
redemption use POST bodies, so codes do not appear in URLs.

Before confirmation the student sees the product, teacher, code type, and access
duration. Redemption normalizes and hashes the value, locks the code, validates
status/time/assignment/product/redemption limit, creates an activation-code
order, and calls the same finalizer. The code stays permanently linked to the
student and order. A redeemed code is never made reusable by a refund.

For externally collected batches, the projected commission plus outstanding
platform receivable can be limited with
`TEACHER_CODE_RECEIVABLE_LIMIT_MINOR`. The admin batch detail includes issued
face value, redeemed gross, commission, teacher earning, unused liability,
refunds, and receivable exposure.

Discount codes remain separate payment modifiers. A paid activation code is
prepaid proof and does not combine with a discount in this implementation.

## Teacher earnings and settlements

Platform-collected teacher earnings enter `teacher_payable` until
`TEACHER_EARNING_HOLD_DAYS` passes. The scheduled maintenance job posts a
balanced release from pending into `teacher_payable_available`.

Settlement creation locks eligible available ledger entries and gives each
entry one unique settlement membership. An admin then approves the draft and,
after an actual transfer, records the transfer reference and marks it paid.
Orders with an earning reversal are excluded before drafting and checked again
under locks when payment is recorded. Payout, deduction, liability-clearing,
and receivable-offset clearing entries are appended as a balanced journal;
original entries are never changed or deleted.

The teacher finance API is always scoped to the authenticated teacher. It shows
pending/available/lifetime/paid balances, channel sales, platform commission,
teacher-collected sales, platform receivables, refunds, and settlements. It does
not expose another teacher, payment destination secrets, admin notes, or private
receipt details.

## Refunds

All channels use `RefundsService`:

- gateway refunds call the provider when supported, otherwise an authorized
  admin must record externally confirmed completion;
- manual and activation-code refunds require the actual external method and
  reference;
- current lesson/package/book access supports full refunds only. A partial
  refund is rejected rather than leaving ambiguous access;
- provider refund notifications must match the order's complete remaining
  amount and currency, including when an in-progress refund already exists;
- completion revokes the entitlement and compatibility purchase rows, appends
  commission/earning/cash reversals, updates order/payment state, notifies the
  parties, and emits audited events;
- if earnings were released or paid, the reversal reduces the available
  balance and can create a negative teacher balance that future settlements
  offset.

Financial history is never deleted.

## Security and integrity

- Hybrid authentication and role guards protect student, teacher, and admin
  endpoints.
- Browser mutations retain the existing CSRF cookie/header protection.
- All DTOs are validated and bounded; list queries are paginated.
- Prices, seller, currency, discount, duration, and commission come from the
  backend.
- Database row locks and unique indexes protect finalization, redemption,
  active orders, webhook events, manual references, entitlements, ledger
  references, and settlement membership.
- A gateway failure closes both the payment and its active order under a
  transaction, releases reserved discount use, and permits a legitimate retry;
  a late failure cannot overwrite a completed or refunded payment.
- Activation verify/redeem and receipt submission are throttled.
- HMAC comparison is constant-time and callbacks fail closed when secrets are
  absent.
- Provider callbacks are persisted without signatures or secrets.
- Receipt type is detected from content; objects remain private; reviewer URLs
  expire after five minutes.
- Notifications and outbox events use deterministic dedupe keys.
- Reconciliation flags paid orders without access, payments without paid
  orders, access without paid orders, ledger imbalances, duplicate references,
  failed webhooks, manual inconsistencies, and unknown collectors.

## Operational procedures

### Environment

- `DEFAULT_PLATFORM_COMMISSION_BPS=3000`
- `TEACHER_EARNING_HOLD_DAYS=7`
- `MINIMUM_SETTLEMENT_MINOR=10000`
- `TEACHER_CODE_RECEIVABLE_LIMIT_MINOR=0` (set a positive minor-unit limit to
  enable external-collector credit control)
- `EASYKASH_API_KEY`
- `EASYKASH_HMAC_SECRET`
- `EASYKASH_API_URL`
- `FRONTEND_URL`
- private storage variables (`R2_*` in production, or the documented local
  private store for development)
- PostgreSQL and Redis variables already required by Learnix

### Deployment

1. Back up PostgreSQL.
2. Deploy backend code with `TYPEORM_SYNCHRONIZE=false`.
3. Run `npm run migration:run` (or `migration:run:prod` from the built image).
4. Verify `/admin/finance/reconciliation` before enabling checkout traffic.
5. Configure at least one manual method in the admin finance page.
6. Confirm EasyKash callback URL, API key, and HMAC secret in the provider
   dashboard.
7. Deploy the frontend with `NEXT_PUBLIC_API_URL` pointing at the HTTPS backend.
8. Execute one low-value test per enabled channel and confirm the order,
   entitlement, balanced ledger, and notification.
9. Monitor failed webhook events, the outbox, queue dashboard, and scheduled
   maintenance.

### Reconciliation

Admins should review the reconciliation page daily and after each deployment.
The canonical financial report is available at `/admin/finance/reports` with
date, teacher, product, channel, status, and currency filters. Investigate
unknown collectors before settling them. Compare gateway provider totals using
provider references, compare manual payments using destination/reference, and
compare activation-code distributors using batch financial summaries.

### Rollback

The migration is additive and backfills orders/entitlements without fabricating
historical ledger cash. Application rollback can therefore leave the new tables
in place safely. The provided `down` migration removes new structures and
compatibility columns, but should be used only after a backup and only if no new
orders have been accepted; otherwise it would discard newly created financial
history. In production, prefer rolling application code forward and preserving
the tables.

## Main APIs

Student:

- `POST /payments/checkout/quote`
- `POST /payments/orders`
- `POST /payments/orders/:id/gateway`
- `GET /payments/orders` and `GET /payments/orders/:id`
- `POST /payments/manual/submissions` and `GET /payments/manual/submissions`
- `POST /attendance-codes/verify` and `POST /attendance-codes/redeem`

Admin:

- `/admin/finance/orders`
- `/admin/finance/manual-methods`
- `/admin/finance/manual-submissions/*`
- `/admin/finance/refunds/*`
- `/admin/finance/settlements/*`
- `/admin/finance/reconciliation`
- `/admin/finance/reports`
- existing `/admin/code-batches`, `/admin/codes`, exports, and discount-code APIs

Teacher:

- `GET /teacher/finance/wallet`
- `GET /teacher/finance/orders`
- `GET /teacher/finance/refunds`
- `GET /teacher/finance/settlements`

Gateway:

- signed EasyKash webhook and callback routes under `/payments/webhook`

## Validation

Run before release:

```text
npm run build
npm test -- --runInBand
npm run lint
npm run migration:show
```

For the frontend:

```text
npx tsc --noEmit
npm test
npm run lint
npm run build
```

Production E2E must use PostgreSQL, Redis, private object storage, and the
provider sandbox/test merchant. Never replace webhook verification with fake
success in production code.
