# Phase 4: service migrations in staging

Everything here runs in the **real staging environment** and needs the Phase 3 stack applied, images pushed and
migrations run (`phase3-staging.md`). The application code for each service is already in place behind flags
(Phase 1); Terraform sets the AWS side of every flag, so this phase is mostly *verifying*, one service at a time.
Nothing below has been executed.

First run the generic checks from an allowlisted address:

```bash
node scripts/staging-acceptance.mjs https://<site>
```

## Order and per-service acceptance

| # | Service | Flags (already set by Terraform unless noted) | Acceptance in staging |
|---|---|---|---|
| 1 | **S3 storage** | `S3_BUCKET`, `S3_REGION`, task role (no static keys) | Upload a book (up to 200 MB), a lesson resource and an image through the UI; each key resolves (`HeadObject`); private files are 403 without a signature; the API task's memory stays under 600 MB during a 500 MB upload; a code export made by one task downloads from another (run `split_roles = true`) |
| 2 | **Video** | `VIDEO_SOURCE_BUCKET`, `VIDEO_OUTPUT_BUCKET`, `MEDIACONVERT_ROLE_ARN`, `MEDIA_EVENTS_QUEUE_URL`, `CLOUDFRONT_KEY_PAIR_ID`; operator: signing key pair, `video_public_key_pem`, `inject_cloudfront_key` | A 20 GB upload survives a browser restart (resume); the asset reaches `ready` (events path, then stop the queue consumer to prove the 5-minute reconcile also works); playback on Chrome, Firefox, Safari, Android, iOS; segment without cookies and with expired cookies is 403; delete removes every object; publish gate still requires `ready`. **Validate the MediaConvert job settings here: they were written against the documented schema and never run** |
| 3 | **Email (SES)** | `MAIL_PROVIDER=ses`, `SES_CONFIGURATION_SET`, `MAIL_ALLOWLIST`, `MAIL_EVENTS_QUEUE_URL` | Verify allowlisted recipients in SES; password reset and instructor invitation arrive in ar and en; SES mailbox simulator bounce and complaint addresses appear in the worker log (`ses_bounce`, `ses_complaint`); DKIM/SPF/DMARC pass in Gmail and Outlook headers |
| 4 | **SMS** | `SMS_PROVIDER=aws`, `SMS_MODE=sandbox`, `SMS_AWS_CONFIGURATION_SET`, `SMS_EVENTS_QUEUE_URL`; operator: sender ID registration approved | Send to the **AWS simulator numbers**; `sms_delivery` events appear in the worker log with the destination masked; a non-Egypt destination is refused by the app; real-handset delivery on Vodafone, Orange, e& and WE waits for the approved sender ID |
| 5 | **Web Push** | `PUSH_PROVIDER=webpush`, `VAPID_SUBJECT`; operator: `vapid` secret, `inject_vapid` | Subscribe and receive on Chrome/Edge/Firefox desktop and Android Chrome; an expired subscription (410) is removed; an endpoint outside the browser push-service allowlist is rejected at registration |
| 6 | **Observability** | alarms and `LOG_FORMAT=json` | Trigger each alarm class once (kill a task, stop a consumer so a DLQ fills, log an error line); the notification reaches every `alert_emails` address; Logs Insights can query the JSON fields |

## Rules for this phase

* One service at a time, in the order above, each with its own change and its own evidence (command output or
  screenshot) recorded next to the row.
* Providers stay switchable by env var until the Phase 8 parity window ends; do not delete the old provider code
  in this phase.
* If a check fails, fix the code or the Terraform, redeploy to staging and re-run that row only. Do not move on.
* Staging runs Paymob in TEST mode and SMS in sandbox; real money and real parents' phones are never reachable.

## Still not covered by anything automated

* Real-handset SMS (needs the approved Egypt sender ID).
* Cross-browser playback and push (manual matrix above; Playwright journeys are a separate item in the plan).
* The Firebase ID-token login path is still in the code; removing it needs your approval (plan decision 5).
