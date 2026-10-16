# EasyKash payment gateway — setup and operations

Source of truth: <https://easykash.gitbook.io/easykash-apis-documentation> (Direct Payment, hosted).
EasyKash replaced Paymob as the only payment gateway. Historical Paymob payments stay in the
database untouched (`payments.provider = 'paymob'`, legacy `paymob_*` columns).

## Flow

1. Backend `POST https://back.easykash.net/api/directpayv1/pay` (header `authorization: <API key>`)
   with `amount` (EGP, major units), `customerReference` = our payment UUID, and a per-payment
   `redirectUrl` = `{BACKEND_URL}/api/v1/payments/easykash/return/{paymentId}`. The response
   `redirectUrl` must be `https://www.easykash.net/DirectPayV1/<code>`; `<code>` is stored as the
   provider order reference and the customer is sent to that link.
2. After payment EasyKash redirects the browser (GET) to our return URL. That request is
   **display-only**: it never changes payment state.
3. EasyKash POSTs a server-to-server callback to the dashboard callback URL **only for successful
   payments**. Access is granted only after the HMAC is verified and amount / merchant reference /
   product code match the stored payment.
4. Reconciliation (every 30 min, and once when the customer returns) calls
   `POST /api/cash-api/inquire` with the `customerReference`, so a missed callback is recovered.

## Dashboard (EasyKash → Settings → Integration Settings)

| Setting | Value |
|---|---|
| Callback URL | `https://api.learnix.school/api/v1/payments/webhook` |
| API key | `EASYKASH_API_KEY` (server-side secret only) |
| HMAC Secret Key | `EASYKASH_HMAC_SECRET`; appears after saving the callback URL |
| Payment options | account-level; the app additionally sends `paymentOptions` (default `2,4,6,31,35,1,5`) |
| Fees / VAT | financial decision, not changed by the application |

Never put either secret in a `NEXT_PUBLIC_*` variable, a log, or Git. Store them in AWS Secrets
Manager (`<project>/production/easykash`, keys `EASYKASH_API_KEY`, `EASYKASH_HMAC_SECRET`) and map
them through `extra_secrets` in the production tfvars.

## Callback verification (verified against the official worked example)

HMAC-**SHA512**, hex digest, key = HMAC secret, over the values of `ProductCode`, `Amount`,
`ProductType`, `PaymentMethod`, `status`, `easykashRef`, `customerReference` concatenated with no
separator, compared with `signatureHash` in constant time. The signature is read from the body.

## Known limits (not documented by EasyKash)

- **No sandbox/test mode** → staging runs without credentials; the isolation guard enforces it.
- **No refund API** → refunds are made in the EasyKash dashboard and recorded in Learnix through the
  manual refund path (`supportsRefunds() === false`).
- **Callback has no currency** → only EGP payments are ever created; other currencies are rejected.
- **Whether callback/inquiry `Amount` includes VAT/fees is undocumented.** The exact-amount guard is
  kept: a mismatch fails closed (no access, event goes to dead letter / reconciliation). Confirm
  with EasyKash or one small authorised live payment before go-live.
- **Callback HTTP method is not stated**; the endpoint accepts POST with JSON or form encoding.
- **Callback `Timestamp` is unsigned** → it is not trusted; late captures on expired orders go to
  the existing compensation path.
- Orders stay payable for `EASYKASH_CASH_EXPIRY_HOURS` + 15 min so Fawry/Aman vouchers can be paid.
