# Backend Security Audit Report

Date: 2026-07-09  
Scope: `learning-center-backend` NestJS/Express/TypeORM/PostgreSQL backend, plus token-storage evidence from the sibling frontend where it directly affects backend authentication risk.  
Method: static source review, route/DTO/query review, secret/config inspection, and `npm audit --omit=dev --json`.

## Executive Summary

Overall security rating: **6.2 / 10**

The backend has several strong controls already in place: JWT expiry enforcement, bcrypt password hashing, refresh-token hashing/rotation, global DTO validation, Helmet, role guards on most sensitive controllers, payment HMAC verification, server-side pricing, and pessimistic locking/idempotency around successful payment processing.

The main issues are concentrated in five areas:

1. **Private files can become public when local storage is used** because the entire `uploads` directory is statically exposed.
2. **Payment list sorting accepts unvalidated SQL fragments** in `ORDER BY`.
3. **Access and refresh tokens are exposed to JavaScript-readable storage** on the frontend and returned as JSON by the backend.
4. **Real secrets exist in the local `.env`**, including production-like infrastructure secrets and a weak admin seed password.
5. **Production dependencies currently have high/critical advisories** according to `npm audit`.

I did not verify live production TLS, reverse-proxy rules, WAF rules, production network isolation, or actual deployed environment variables from Railway. Those require deployment access.

## Positive Security Controls Observed

- JWT validation fails closed if `JWT_SECRET` is missing, short, or default-like: `src/auth/jwt.strategy.ts:15-32`.
- JWT expiration is enforced with `ignoreExpiration: false`: `src/auth/jwt.strategy.ts:34`.
- Access token expiry is configured through Nest JWT module: `src/auth/auth.module.ts:25-29`.
- Passwords are hashed with bcrypt and configurable rounds, defaulting to 12: `src/auth/auth.service.ts:43`, `src/auth/auth.service.ts:60`.
- Refresh tokens are opaque random values, stored as bcrypt hashes, and rotated on refresh: `src/auth/auth.service.ts:228-260`, `src/auth/auth.service.ts:374-402`.
- Global validation uses whitelist and forbids unknown body fields: `src/main.ts:144-153`.
- Helmet is enabled with HSTS, frameguard, nosniff, referrer policy, and production CSP: `src/main.ts:84-111`.
- Global throttling is enabled: `src/app.module.ts:223-225`; auth endpoints apply stricter throttle settings: `src/auth/auth.controller.ts:27`, `src/auth/auth.controller.ts:48`, `src/common/constants.ts:33-43`.
- Payment webhooks verify EasyKash HMAC before processing: `src/payments/controllers/payments-webhook.controller.ts:52-55`, `src/payments/services/easykash.service.ts:119-170`.
- Payment amount and currency are checked against server-side payment records: `src/payments/controllers/payments-webhook.controller.ts:93-118`, `src/payments/services/payments.service.ts:781-806`.
- Payment completion uses a pessimistic write lock and skips already-completed payments: `src/payments/services/payments.service.ts:638-678`.
- Metrics endpoint is protected by a bearer-token guard and fails closed when the token is missing: `src/metrics/metrics.controller.ts:8-10`, `src/metrics/metrics-bearer.guard.ts:18-41`.

## Summary Table: Vulnerabilities Ranked

| Rank | Severity | Vulnerability | Evidence | Main Impact |
|---:|---|---|---|---|
| 1 | Critical | Critical/high production dependency advisories | `npm audit --omit=dev --json`: 34 prod vulns, including critical `protobufjs` | Possible RCE/SSRF/DoS depending reachable code paths |
| 2 | High | Local private uploads can be publicly exposed | `src/main.ts:115`; `src/storage/storage.service.ts:283-327`; `src/uploads/teacher-uploads.controller.ts:104-109` | Paid/private PDFs may be downloaded without purchase/auth |
| 3 | High | SQL injection surface in payment sorting | `src/payments/dto/payment-filter.dto.ts:72-83`; `src/payments/services/payments.service.ts:1135-1137`, `1198-1200` | SQL errors, data exposure risk, possible injection via raw `ORDER BY` expression |
| 4 | High | Tokens stored in JavaScript-readable cookies/client storage | Backend: `src/auth/auth.service.ts:181-182`, `401-402`; frontend: `dodline/app/hooks/axios.config.ts:17-42`, `87-91` | XSS can steal access and refresh tokens |
| 5 | High | Local `.env` contains real secrets and weak admin seed password | `.env:4`, `.env:6`, `.env:10`, `.env:12`, `.env:18`, `.env:22-30` | Secret leakage can compromise DB, JWT signing, storage/CDN |
| 6 | Medium/High | File upload memory DoS and MIME spoofing risks | `src/uploads/teacher-uploads.controller.ts:42-43`, `64-72`, `85-109`; `src/uploads/upload.service.ts:101-137` | Large uploads can exhaust memory; malicious files may be accepted |
| 7 | Medium | CORS allows any `*.vercel.app` origin with credentials | `src/main.ts:123-136` | Any Vercel-hosted attacker site can make credentialed CORS requests if user has tokens/cookies |
| 8 | Medium | Logout does not revoke access JWTs | `src/auth/auth.controller.ts:88-94`; `src/auth/auth.service.ts:558-567`; `.env:11` | Stolen access token remains valid until expiry, currently configured as 3600s locally |
| 9 | Medium | External payment/storage calls lack explicit timeouts | `src/payments/services/easykash.service.ts:67`; storage fetch patterns in `src/storage/storage.service.ts` | Slow third-party calls can tie up workers/sockets |
| 10 | Medium | Redis idempotency fails open | `src/idempotency/idempotency.service.ts:149-150`, `168-174`, `203-204`, `252-253`, `297` | Duplicate processing defenses degrade if Redis is unavailable |
| 11 | Medium | Registration validation is weak | `src/auth/dto/register.dto.ts:1-38` | Bad email formats and weak passwords can be accepted |
| 12 | Low/Medium | Sensitive/PII data can be written to logs | `src/auth/auth.service.ts:110`, `126`; `src/payments/services/easykash.service.ts:92-93` | Emails, account states, and provider error bodies can leak into logs |
| 13 | Low | Public health endpoint discloses environment/version/uptime | `src/health/health.controller.ts:33-43` | Minor information disclosure |
| 14 | Low | Activity stats route ignores path parameter | `src/activity-logs/activity-logs.controller.ts:33-37` | Admin endpoint can return wrong/undefined user stats |

## Detailed Findings

### 1. Critical/high production dependency advisories

Severity: **Critical**

Description: `npm audit --omit=dev --json` reports **34 production vulnerabilities**: 1 critical, 13 high, and 20 moderate. The critical advisory is for `protobufjs <=7.6.2` with arbitrary code execution advisories. High advisories include packages in or below the production tree such as `axios`, `multer`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/swagger`, `lodash`, `node-forge`, `path-to-regexp`, and `@grpc/grpc-js`.

Evidence:

```text
Command: npm audit --omit=dev --json
Production vulnerabilities: total=34, critical=1, high=13, moderate=20
Critical package: protobufjs <=7.6.2
Direct production dependencies include axios, multer, firebase-admin, @nestjs/*, typeorm: package.json
```

Potential impact: Depending on reachable package paths, these advisories may allow denial of service, SSRF, prototype pollution, or remote code execution.

Proposed remedy:

- Run `npm audit fix` in a controlled branch.
- For unresolved advisories, update direct dependencies manually and use `overrides` only as a temporary bridge.
- Prioritize `protobufjs`, `axios`, `multer`, and NestJS/Express chain updates.
- Re-run `npm audit --omit=dev` and regression tests before deployment.

### 2. Local private uploads can be publicly exposed

Severity: **High**

Description: The app statically exposes the entire local `uploads` directory at `/uploads/`. The storage layer’s local provider stores all paths under the configured upload directory and returns `/api/v1/uploads/{path}` as a signed URL substitute. Teacher book uploads are marked `visibility: 'private'` and stored under `books/...`, but when local storage is used, those files may still live below the statically exposed `uploads` root.

Evidence:

- Entire upload root is public: `src/main.ts:115`.
- Local storage writes to `join(uploadDir, path)`: `src/storage/storage.service.ts:283-285`.
- Local signed URL returns a public URL: `src/storage/storage.service.ts:325-327`.
- Teacher book upload stores private PDFs under `books/{uuid}.pdf`: `src/uploads/teacher-uploads.controller.ts:104-109`.
- Purchase-gated book download exists separately: `src/books/services/book-purchases.service.ts:161-175`.

Potential impact: Paid/private PDFs or other private files can be downloaded directly if an attacker obtains or guesses the file key, bypassing purchase checks and authorization.

Proposed remedy:

- Do not serve the full `uploads` root statically.
- Move private files outside the public web root.
- Serve public media only through an allowlisted controller or static mount for known public folders.
- For local private storage, implement a signed download route that validates ownership/purchase before streaming the file.

### 3. SQL injection surface in payment sorting

Severity: **High**

Description: `PaymentFilterDto.sortBy` and `order` are typed as unions in TypeScript but are not runtime-validated with `@IsIn` or an enum. The value is interpolated into TypeORM `orderBy()` as `payment.${sortBy}`. TypeScript types do not protect runtime HTTP input.

Evidence:

- `sortBy` uses only `@IsString()`: `src/payments/dto/payment-filter.dto.ts:72-77`.
- `order` uses only `@IsString()`: `src/payments/dto/payment-filter.dto.ts:79-83`.
- Student purchases listing uses dynamic `orderBy`: `src/payments/services/payments.service.ts:1135-1137`.
- Admin payments listing uses dynamic `orderBy`: `src/payments/services/payments.service.ts:1198-1200`.

Potential impact: At minimum, attackers can cause SQL errors and noisy logs. Because `orderBy()` accepts SQL fragments, this is an injection surface and may become exploitable depending on database driver behavior and future query changes.

Proposed remedy:

```ts
const PAYMENT_SORT_COLUMNS = {
  created_at: 'payment.created_at',
  amount: 'payment.amount',
  final_amount: 'payment.final_amount',
  status: 'payment.status',
} as const;

const sortColumn = PAYMENT_SORT_COLUMNS[filter.sortBy ?? 'created_at'];
const direction = filter.order === 'ASC' ? 'ASC' : 'DESC';
queryBuilder.orderBy(sortColumn, direction);
```

Also add DTO validation:

```ts
@IsOptional()
@IsIn(['created_at', 'amount', 'final_amount', 'status'])
sortBy?: keyof typeof PAYMENT_SORT_COLUMNS;

@IsOptional()
@IsIn(['ASC', 'DESC'])
order?: 'ASC' | 'DESC';
```

### 4. Tokens are stored in JavaScript-readable client storage

Severity: **High**

Description: The backend returns access and refresh tokens in JSON responses. The sibling frontend stores them using `js-cookie`, which is JavaScript-readable and cannot set `HttpOnly`. If any XSS exists in the frontend, both access and refresh tokens can be stolen.

Evidence:

- Login returns `{ token, refreshToken }`: `src/auth/auth.service.ts:181-182`.
- Refresh returns `{ token, refreshToken }`: `src/auth/auth.service.ts:401-402`.
- Frontend stores `token` and `refresh_token` with `Cookies.set(...)`: `dodline/app/hooks/axios.config.ts:17-42`.
- Frontend sends access token in `Authorization` header: `dodline/app/hooks/axios.config.ts:87-91`.

Cookie flags observed in frontend:

- `secure: process.env.NODE_ENV === 'production'`
- `sameSite: 'strict'`
- `path: '/'`
- No `HttpOnly` because client-side JavaScript cannot set it.

Potential impact: XSS leads to immediate account takeover and refresh-token theft.

Proposed remedy:

- Set refresh token in an `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict` cookie from the backend.
- Keep access tokens short-lived. Consider memory-only access token storage.
- Add a backend refresh endpoint that reads the refresh cookie.
- Keep CSRF protection enabled if cookie-based refresh or cookie-based auth is used.

### 5. Local `.env` contains real secrets and weak admin seed password

Severity: **High**

Description: A local `.env` file exists with database credentials, JWT secrets, Bunny/R2 credentials, and an admin seed password. The file appears untracked because `.gitignore` includes `.env`, but its presence in the workspace is still a material risk if copied, shared, logged, or included in backups.

Evidence:

- DB password: `.env:4` redacted.
- DB URL: `.env:6` redacted.
- JWT secret: `.env:10` redacted.
- Refresh secret: `.env:12` redacted.
- Admin seed password is weak/trivial: `.env:18` redacted.
- Bunny credentials: `.env:22-25` redacted.
- R2 credentials: `.env:29-30` redacted.
- Git tracking check showed `.env.example` and `.gitignore`, but not `.env`.

Potential impact: If leaked, attackers can forge tokens, access the database, access object storage/CDN, or seed/login with an admin credential depending on deployment behavior.

Proposed remedy:

- Rotate all secrets currently present in `.env` if this workspace has been shared or exposed.
- Replace weak admin seed password with a generated high-entropy value.
- Store production secrets only in Railway/environment secret storage.
- Add secret scanning to CI, for example `gitleaks` or GitHub secret scanning.

### 6. File upload memory DoS and MIME spoofing risks

Severity: **Medium/High**

Description: Teacher upload endpoints use `FileInterceptor('file')` without visible Multer `limits`. The code checks `file.size` after Multer has already accepted the upload into memory. Book uploads accept PDFs based on `file.mimetype`, which is client-controlled unless backed by content sniffing. Generic resource uploads allow executable/source-like extensions such as `js`, `ts`, `py`, `html`, and `css`.

Evidence:

- Max file constants exist but are checked after upload: `src/uploads/teacher-uploads.controller.ts:42-43`.
- File interceptors have no visible `limits`: `src/uploads/teacher-uploads.controller.ts:64-72`, `85-86`.
- Book upload trusts `file.mimetype === 'application/pdf'`: `src/uploads/teacher-uploads.controller.ts:88-96`.
- File buffers are passed in memory to storage: `src/uploads/teacher-uploads.controller.ts:104-109`, `123-136`.
- Source/web extensions are allowlisted for resources: `src/uploads/upload.service.ts:101-137`.

Potential impact: Attackers can exhaust Node process memory with oversized uploads. Malicious files may be stored and served, creating stored-XSS/phishing risks if public and served with executable content types.

Proposed remedy:

- Add Multer limits at interceptor level.
- Prefer streaming upload to object storage for large files.
- Validate file magic bytes using a library such as `file-type`.
- Store untrusted files with safe `Content-Type`, e.g. `application/octet-stream`, unless explicitly safe.
- Do not allow public HTML/JS uploads unless sandboxed and intentional.

### 7. CORS allows any `*.vercel.app` origin with credentials

Severity: **Medium**

Description: CORS allows credentials and accepts any origin ending with `.vercel.app`. This trusts all Vercel projects, not only this application’s preview deployments.

Evidence:

- Allowed origins include wildcard-style Vercel host: `src/main.ts:123`.
- Runtime check allows `origin.endsWith('.vercel.app')`: `src/main.ts:128`.
- Credentials are enabled: `src/main.ts:136`.

Potential impact: A malicious Vercel app can make credentialed CORS requests from a victim browser. The impact is lower while auth uses bearer headers rather than automatic auth cookies, but it becomes more serious if auth cookies are introduced.

Proposed remedy:

- Replace broad `.vercel.app` matching with exact production and preview hostnames.
- If preview deployments are required, generate an allowlist from known project/team preview domains.
- Revisit this before moving auth tokens into cookies.

### 8. Logout does not revoke access JWTs

Severity: **Medium**

Description: Logout clears stored refresh-token state but does not revoke the current access JWT. Because access tokens are stateless, a stolen access token remains valid until it expires. Local config sets access token expiry to `3600s`.

Evidence:

- Logout endpoint calls `authService.logout(req.user.userId)`: `src/auth/auth.controller.ts:88-94`.
- Logout clears refresh token fields: `src/auth/auth.service.ts:558-567`.
- Access token is issued as a stateless JWT: `src/auth/auth.service.ts:181`.
- Local `.env` sets JWT expiration to `3600s`: `.env:11`.

Potential impact: If an access token is stolen, logout does not invalidate it immediately. The attacker keeps access for up to the token lifetime.

Proposed remedy:

- Reduce access-token TTL to 10-15 minutes.
- Add token versioning or `jti` denylist for high-risk accounts/admins.
- On password change, role change, account rejection, or logout-all, increment a user `tokenVersion` checked by the JWT strategy.

### 9. External payment/storage calls lack explicit timeouts

Severity: **Medium**

Description: Payment API calls use `fetch` without an `AbortController` timeout. Storage/CDN calls follow the same pattern in several places. Long-hanging upstream calls can tie up request handlers.

Evidence:

- EasyKash create-payment call: `src/payments/services/easykash.service.ts:67`.
- EasyKash error body logging around failed response: `src/payments/services/easykash.service.ts:92-93`.
- Storage provider uses outbound fetches in `src/storage/storage.service.ts`.

Potential impact: Slow or malicious upstream behavior can exhaust worker capacity and degrade availability.

Proposed remedy:

- Wrap all external HTTP calls with `AbortController`.
- Use conservative timeouts, e.g. 5 seconds for payment creation and 10 seconds for storage/CDN where needed.
- Add retry only for idempotent operations.

### 10. Redis idempotency fails open

Severity: **Medium**

Description: The idempotency service returns safe-looking defaults when Redis is unavailable. This keeps the application available, but duplicate-request protections degrade at the exact moment Redis is down.

Evidence:

- `isAvailable()` returns false when the Redis client is missing or not ready: `src/idempotency/idempotency.service.ts:149-150`.
- Idempotency operations return false/null on Redis failure: `src/idempotency/idempotency.service.ts:168-174`, `203-204`, `252-253`, `297`.
- Payment webhook depends on idempotency check/store: `src/payments/controllers/payments-webhook.controller.ts:68-74`, `155`.

Potential impact: Webhook/request replay protection weakens during Redis outages. The payment success path has database locks and completed-state checks, which reduce financial impact, but the defense-in-depth layer is not reliable.

Proposed remedy:

- For financial webhook idempotency, add a database-backed idempotency table with unique keys.
- Keep Redis as a fast cache, but make the database unique constraint the authority.
- Alert when Redis idempotency is unavailable.

### 11. Registration validation is weak

Severity: **Medium**

Description: Registration email is only checked for non-empty value, not email format. Password has max length but no enforced minimum or complexity in the DTO, despite API docs describing a minimum.

Evidence:

- Register DTO: `src/auth/dto/register.dto.ts:1-38`.
- `email` uses `@IsNotEmpty()` but no `@IsEmail()`.
- `password` uses `@IsNotEmpty()` and `@MaxLength(128)` but no `@MinLength()`.

Potential impact: Weak or malformed credentials enter the system, increasing account-takeover and support risk.

Proposed remedy:

- Add `@IsEmail()` for email.
- Add `@MinLength(8)` or stronger policy for password.
- Consider compromised-password checks for production.

### 12. Sensitive/PII data can be written to logs

Severity: **Low/Medium**

Description: Some logs include user emails and payment provider error bodies. Provider error bodies may contain buyer data or sensitive gateway diagnostics.

Evidence:

- Failed login logging includes email: `src/auth/auth.service.ts:110`, `src/auth/auth.service.ts:126`.
- EasyKash error body is logged: `src/payments/services/easykash.service.ts:92-93`.

Potential impact: PII can leak to centralized logs, support exports, or third-party log processors.

Proposed remedy:

- Log stable user IDs instead of emails where possible.
- Redact provider response bodies before logging.
- Add a structured log sanitizer for keys like `password`, `token`, `authorization`, `card`, `email`, `phone`.

### 13. Public health endpoint discloses environment/version/uptime

Severity: **Low**

Description: The public health endpoint returns environment name, version, uptime, and timestamp.

Evidence:

- `src/health/health.controller.ts:33-43`.

Potential impact: Minor reconnaissance value for attackers.

Proposed remedy:

- Keep `/health` minimal: `{ status: 'ok' }`.
- Leave detailed health data behind admin auth, which already exists for detailed health endpoints.

### 14. Activity stats route ignores path parameter

Severity: **Low**

Description: The route declares `:userId` as a path parameter but reads `userId` from query string. It is admin-protected, so this is not an external IDOR, but it can return incorrect data.

Evidence:

- `src/activity-logs/activity-logs.controller.ts:33-37`.

Potential impact: Admins may see incorrect or empty activity stats for a user.

Proposed remedy:

- Replace `@Query('userId')` with `@Param('userId')`.

## Authentication & Authorization Review

Current mechanism: JWT bearer authentication with Firebase hybrid support. The Nest strategy extracts bearer tokens from the `Authorization` header and validates them using the configured JWT secret.

Evidence:

- Bearer extraction: `src/auth/jwt.strategy.ts:35`.
- JWT payload maps to `userId`, `email`, `role`, `firebaseUid`: `src/auth/jwt.strategy.ts:43-51`.
- Hybrid guard is used on sensitive controllers, for example users and payments: `src/users/users.controller.ts`, `src/payments/controllers/payments.controller.ts`.

Assessment:

- Authentication implementation is mostly correct.
- Password storage is good: bcrypt with salt and cost.
- Refresh-token design is good: opaque token, bcrypt-hashed at rest, rotated.
- Main weaknesses are client-side token storage and lack of access-token revocation.

Authorization:

- Admin routes generally use `HybridAuthGuard` plus `RolesGuard` and `@Roles('admin')`.
- Student payment routes use `@Roles('student')`.
- Teacher/admin payment routes are separated with role guards.
- Ownership checks are present in lesson/package/exam service paths reviewed.
- No confirmed unauthenticated IDOR was found in the reviewed sensitive routes.
- One admin-only route bug was found: activity stats route reads `userId` from query instead of the path parameter.

## Input Validation & Injection Review

Strong control: global `ValidationPipe` uses whitelist and forbids unknown fields: `src/main.ts:144-153`.

SQL injection:

- Most TypeORM QueryBuilder usage is parameterized.
- Confirmed issue: payment `sortBy`/`order` are not runtime allowlisted before dynamic `orderBy()`.

Mass assignment:

- User update is explicitly field-by-field and does not permit direct role/balance/admin changes: `src/users/users.service.ts`.
- Registration creates students by default and does not accept a role from the body.

File upload:

- Image upload code performs good filename/path and image validation in `src/uploads/upload.service.ts`.
- Teacher upload endpoints need request-level size limits and content sniffing.

## Data Protection Review

Sensitive data at rest:

- Passwords and refresh tokens are hashed.
- Payment amounts and user/payment metadata are stored in the database; no evidence of card-number storage was found.
- Payment gateway credentials are expected from environment variables.

Secrets:

- `.env` is ignored by Git, but real-looking secrets are present locally.
- No hardcoded JWT secret was found in source code.

Logs:

- Some PII/provider responses can be logged.
- Error filter avoids stack traces for unexpected production errors: `src/common/filters/http-exception.filter.ts:113-119`.

Transport:

- Helmet HSTS is enabled.
- The code itself does not enforce HTTPS redirects; this must be enforced by Railway/reverse proxy.

## Cookies & Session Storage Review

Backend:

- Backend returns tokens in JSON and does not set auth cookies.
- There is no server session ID; session fixation is not applicable in the traditional server-session sense.
- Logout revokes refresh-token state but not existing access JWTs.

Frontend evidence affecting backend security:

- Tokens are stored using `js-cookie`, which is JavaScript-readable.
- `Secure` and `SameSite=Strict` are configured, but `HttpOnly` is impossible from client-side JavaScript.

Recommendation:

- Move refresh tokens to backend-set `HttpOnly`, `Secure`, `SameSite` cookies.
- Keep access tokens short-lived and memory-only where possible.

## API & Network Security Review

Rate limiting:

- Global rate limiting is present.
- Auth endpoints have stricter throttling.
- Payment endpoints should receive payment-specific throttling; constants exist but are not applied to payment controllers.

CORS:

- Credentials are enabled.
- Exact allowed origins exist, but any `.vercel.app` origin is also accepted.

Security headers:

- Helmet is implemented with strong defaults and production CSP.

CSRF:

- Global CSRF guard is enabled.
- Because auth uses bearer tokens, CSRF risk is lower than cookie-auth systems.
- If auth moves to cookies, CSRF policy must be revalidated.

Metrics:

- `/metrics` is protected by a bearer token guard and fails closed.

## Business Logic & Payment Security Review

Payment flow strengths:

- EasyKash webhook HMAC is verified.
- Price is calculated server-side from lesson/package/book records, not trusted from the client.
- Amount/currency captured by the gateway is verified against expected server-side amount.
- Success processing uses a transaction and pessimistic lock.
- Existing completed payments are not processed again.

Payment flow issues:

- Redis idempotency fails open.
- Webhook replay defense would be stronger with a database-backed idempotency record.
- External payment API calls need explicit timeouts.
- Payment endpoints should use stricter rate limits.

## Dependencies & Infrastructure Review

Dependencies:

- `npm audit --omit=dev --json` found 34 production vulnerabilities.
- Full audit including dev dependencies found 57 total vulnerabilities.

Infrastructure:

- `railway.json` uses Nixpacks and health check `/api/v1/health`.
- No Dockerfile was present in this backend directory.
- Live Railway network isolation, TLS enforcement, and secret storage could not be verified from source code alone.

## Third-Party & Webhook Review

Webhooks:

- EasyKash webhook validates HMAC and fails when the secret is missing.
- Webhook body is persisted/audited through metadata paths.

External APIs:

- EasyKash and storage/CDN calls should use explicit timeout handling.
- Error handling exists, but provider error bodies should be redacted before logging.

## Quick Wins

1. **Fix payment sort validation immediately.** Add `@IsIn` and map sort keys to hardcoded columns. This is low effort and removes a SQL injection surface.
2. **Stop exposing the entire `uploads` directory.** Serve only public allowlisted folders and move private files outside the public root.
3. **Update vulnerable production dependencies.** Start with `protobufjs`, `axios`, `multer`, and NestJS-related advisories; re-run `npm audit --omit=dev`.

## Additional High-Value Remediation Plan

- Move refresh tokens to backend-set `HttpOnly` cookies.
- Reduce access-token lifetime to 10-15 minutes.
- Add database-backed webhook idempotency.
- Add upload `limits` and magic-byte file validation.
- Restrict CORS to exact known origins.
- Add external HTTP call timeouts.
- Rotate local secrets if this workspace has been shared or committed anywhere outside the local machine.

