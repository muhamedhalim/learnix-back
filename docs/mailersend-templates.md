# MailerSend template event map

`MailService` is the only mail transport boundary. It enqueues all mail through
the existing BullMQ `email` queue; `MailProcessor` is the only component that
calls MailerSend. Configure template IDs in the environment, never in source.

| Application event            | MailService method           | Environment variable                       | Personalization                             |
| ---------------------------- | ---------------------------- | ------------------------------------------ | ------------------------------------------- |
| New account welcome          | `sendWelcomeEmail()`         | `MAILERSEND_TEMPLATE_WELCOME`              | Caller-supplied fields                      |
| Password reset requested     | `sendPasswordResetEmail()`   | `MAILERSEND_TEMPLATE_PASSWORD_RESET`       | `name`, `reset_url`, `expires_in`, `locale` |
| Login verification requested | `sendVerificationEmail()`    | `MAILERSEND_TEMPLATE_LOGIN_VERIFICATION`   | Caller-supplied fields                      |
| Invitation created           | `sendInvitationEmail()`      | `MAILERSEND_TEMPLATE_INVITATION`           | Caller-supplied fields                      |
| Payment completed            | `sendPaymentConfirmation()`  | `MAILERSEND_TEMPLATE_PAYMENT_CONFIRMATION` | Caller-supplied fields                      |
| Invoice issued               | `sendInvoice()`              | `MAILERSEND_TEMPLATE_INVOICE`              | Caller-supplied fields                      |
| Certificate issued           | `sendCertificateIssued()`    | `MAILERSEND_TEMPLATE_CERTIFICATE`          | Caller-supplied fields                      |
| Homework assigned            | `sendHomeworkAssigned()`     | `MAILERSEND_TEMPLATE_HOMEWORK`             | Caller-supplied fields                      |
| Exam scheduled               | `sendExamScheduled()`        | `MAILERSEND_TEMPLATE_EXAM`                 | Caller-supplied fields                      |
| Subscription nearing expiry  | `sendSubscriptionExpiring()` | `MAILERSEND_TEMPLATE_SUBSCRIPTION`         | Caller-supplied fields                      |

The existing password-reset path in `AuthService.forgotPassword()` is already
wired to `sendPasswordResetEmail()`. The other methods are reusable boundaries
for their listed domain events; no additional event side effects were introduced
in this refactor. When a template ID is blank, the service sends the supplied
HTML/text fallback instead. When it is set, the worker calls `setTemplateId()`
and `setPersonalization()` and does not embed HTML.
