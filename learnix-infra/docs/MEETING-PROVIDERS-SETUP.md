# Meeting providers (Google Meet, Zoom, Microsoft Teams): setup runbook

Teachers connect their **own** provider account by OAuth and generate meetings for one-to-one appointments.
Nothing here is applied by code: every step below is an owner action in a provider dashboard, in Secrets Manager,
or in a Terraform plan you approve. **Never commit a client secret, webhook token or key to this repository.**

Items marked **[V]** are provider behaviour I could not verify from the repository; confirm them in the provider's
current documentation or dashboard before relying on them.

## 0. Decide the launch scope first

| Provider        | Who can connect                                                      | Gate before real teachers can use it                                                                    |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Google Meet     | Any Google account (a consumer Gmail works)                          | OAuth consent screen verification for the sensitive `calendar.events` scope; test users until then     |
| Zoom            | Only the developer's account until the app is **published**          | Zoom Marketplace review and publishing (the ~100-user development allowlist applies until then)        |
| Microsoft Teams | **Work or school accounts with Teams only**, not personal Microsoft | Entra app registration (multi-tenant); some customer tenants may require admin consent                  |

Recommendation: launch **Google Meet first**; leave Zoom and Teams unmapped. A provider whose secrets are not
mapped simply reports "Not available yet" in `/teacher/integrations`; no code change is needed to add it later.

## 1. URLs to register at the providers

Read them from Terraform rather than typing them: `terraform output provider_callback_urls`.

| Output                   | Value                                                                 | Register as                                                  |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `meeting_oauth_callback` | `https://<api-host>/api/v1/teacher/meeting-accounts/callback`         | Redirect / callback URI at **every** provider                |
| `zoom_webhook`           | `https://<api-host>/api/v1/webhooks/zoom`                             | Zoom Event Subscription endpoint URL                         |

Register the **staging** URL on a separate sandbox app at each provider and the **production** URL on the
production app. The redirect URI must match exactly, including scheme and no trailing slash.

The OAuth handshake is bound to the teacher's browser with a cookie set by the API, so the web app and the API must
be **same-site** (e.g. `learnix.school` and `api.learnix.school`). Verify this on staging (section 6).

## 2. Provider dashboards

### 2.1 Google Meet

1. Google Cloud project: enable the **Google Calendar API**.
2. OAuth consent screen, user type **External**. Scopes: `.../auth/calendar.events`, `.../auth/userinfo.email`, `openid`.
   Add the homepage and privacy-policy URLs.
3. Create an OAuth client of type **Web application**; add the callback URL from section 1.
4. While the consent screen is in **Testing**, only listed test users can connect (cap 100) and **refresh tokens
   expire after 7 days [V]**: connections will flip to "Reconnect" weekly. Submit the app for **verification**
   (sensitive scope) before real teachers rely on it; it can take weeks.
5. Keep: client id and client secret.

### 2.2 Zoom

1. Zoom App Marketplace: create a **General app** with user-managed OAuth.
2. Redirect URL and OAuth allow list: the callback URL from section 1.
3. Scopes: `meeting:write:meeting` and `user:read:user` (granular scope names **[V]**).
4. Features > **Event Subscriptions**: endpoint URL = `zoom_webhook` output; subscribe to the **app deauthorized**
   event (**[V]** exact name in the UI; the API handles `app_deauthorized`). Copy the **Secret Token**.
   Zoom validates the endpoint when you save it, so do this **only after** the API is deployed with
   `ZOOM_WEBHOOK_SECRET_TOKEN` (section 3, step 5), or validation fails.
5. Until the app is published, only your own Zoom account can connect. Publishing needs Marketplace review.
6. Keep: client id, client secret, webhook secret token.

### 2.3 Microsoft Teams

1. Microsoft Entra ID > App registrations > new registration. Supported account types: **multi-tenant
   (any organizational directory)**. Redirect URI (platform **Web**): the callback URL from section 1.
2. API permissions, **delegated**: `OnlineMeetings.ReadWrite`, `User.Read`, `offline_access`. Whether a customer tenant
   needs admin consent depends on its policy **[V]**.
3. Certificates & secrets: create a client secret. **It expires (maximum 24 months): put the expiry date in a calendar.**
4. Keep: application (client) id and client secret. The tenant value is `organizations` for multi-tenant, or a
   specific tenant id. It is not secret.
5. Personal Microsoft accounts cannot create Teams meetings through this API; tell teachers who use one.

## 3. Secrets and Terraform (in this order)

The `meetings` container already exists (`modules/secrets/main.tf`, `<prefix>/meetings`) and is **empty**.

**Hazard:** an `extra_secrets` mapping that points at a JSON key missing from the secret makes ECS fail to start the
task ("unable to retrieve secret"). Always fill the secret **before** adding the mapping, and map only the providers
you filled.

1. Fill the secret with only the keys you have (`put-secret-value` replaces the whole JSON, so include every key
   you want kept):

   | JSON key                      | Provider | Secret |
   | ----------------------------- | -------- | ------ |
   | `GOOGLE_MEET_CLIENT_ID`       | Google   | yes    |
   | `GOOGLE_MEET_CLIENT_SECRET`   | Google   | yes    |
   | `ZOOM_CLIENT_ID`              | Zoom     | yes    |
   | `ZOOM_CLIENT_SECRET`          | Zoom     | yes    |
   | `ZOOM_WEBHOOK_SECRET_TOKEN`   | Zoom     | yes    |
   | `MS_TEAMS_CLIENT_ID`          | Teams    | yes    |
   | `MS_TEAMS_CLIENT_SECRET`      | Teams    | yes    |

2. Confirm `MEETING_TOKEN_ENCRYPTION_KEY` is escrowed **outside AWS**. Production now refuses to boot with a provider
   client id set and no key. Never bump `core_version` on an environment with data (it regenerates the key and every
   stored token becomes unreadable).
3. Uncomment the block for each filled provider in your tfvars (see the commented examples in
   `environments/*/terraform.tfvars.example` and `environments/production/launch.tfvars.example`). For Teams also set
   `extra_environment = { MS_TEAMS_TENANT = "organizations" }`.
4. `terraform plan`, review, and apply through the normal approved path. Expect the task definitions to change and the
   services to roll.
5. Verify, then register the URLs (section 2). Check `/teacher/integrations`: the provider card must now offer
   **Connect** instead of "Not available yet".

## 4. Rotation and removal

- Rotate a provider secret: update the JSON key, then force a new deployment of api and worker.
- A Google/Zoom/Microsoft client secret rotation does **not** invalidate teachers' stored refresh tokens.
- Remove a provider: delete its mappings from tfvars and apply. Existing connections stay in the database but the card
  shows "Not available yet" and no new meetings can be generated for it.

## 5. What the code does for you

- Providers report "Not available yet" until their client id and secret **and** a valid token-encryption key exist.
- Transient provider errors (429, 5xx, timeouts) are retried by the worker; a revoked or expired grant moves the
  account to "Reconnect" and notifies the teacher.
- A Zoom `app_deauthorized` webhook marks the matching connection revoked immediately.
- A cancelled appointment's meeting is deleted at the provider by the maintenance sweep (within about a minute).

## 6. Verification

Run `learnix-back/docs/meetings-sandbox-verification.md` against **staging** for each provider you enable. A provider
is only "verified against the sandbox" when that checklist passes with real provider accounts; mocked tests do not
count.
