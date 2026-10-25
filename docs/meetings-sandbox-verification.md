# Meeting integrations: sandbox verification checklist

Run this on **staging** (never production) once per provider, with **real provider accounts**. Automated tests use
mocked providers and cannot prove that Google, Zoom or Microsoft accept our requests; this checklist is what moves a
provider from "implemented, unverified" to "verified against the provider sandbox".

Setup and provider registration: `learnix-infra/docs/MEETING-PROVIDERS-SETUP.md`.

## Prerequisites

- [ ] The provider's client id/secret are mapped on staging and the card shows **Connect** (not "Not available yet").
- [ ] Redirect URI (and for Zoom the webhook URL) registered on the **sandbox** app at the provider.
- [ ] Accounts: one **teacher** Learnix account, one **second teacher**, one **student** with a payable test path
      (EasyKash has no test mode, so use a manual/free path or an existing confirmed booking fixture).
- [ ] Provider accounts: a test account for the provider (Google test user / Zoom developer account / Microsoft 365
      developer tenant user with Teams), plus a **second** provider account for the account-switch test.
- [ ] A lesson with `is_group = false`, a duration, and a price, owned by the teacher.
- [ ] Browser devtools open on the Network tab; note the API host.

Record the date, environment, image tag and tester at the bottom.

## A. Connect

- [ ] A1. Open `/teacher/integrations`. Click **Connect** on the provider. The browser goes to the provider's consent screen.
- [ ] A2. Approve. You land back on `/teacher/integrations` with a toast naming the provider, and the card shows
      "Connected as <email>".
- [ ] A3. In Arabic (`/ar/teacher/integrations`): connect again from a disconnected state and confirm you return to
      `/ar/...` (not the English page).
- [ ] A4. Reload the page and sign out and in: the card is still "Connected".
- [ ] A5. **Binding:** start a connect, copy the provider authorize URL from the address bar, open it in a **private
      window** or another browser, approve. Expect the return page to show the "couldn't confirm this browser"
      error and **no** connection to be created for that teacher.
- [ ] A6. Deny consent at the provider: the return page shows the "permission was declined" message.
- [ ] A7. Open the used callback URL again (browser back/refresh): "already used", no second connection.

## B. Generate and join

- [ ] B1. Add an appointment (future time) with this provider. **No** meeting is created yet (status: not requested).
- [ ] B2. Click **Generate Meeting Link**. The row shows "Creating meeting…" and resolves to **Meeting ready** on its
      own within about 10 seconds (no manual refresh).
- [ ] B3. At the provider (calendar / Zoom meetings list / Teams calendar) the meeting exists at the right time, in
      the right time zone, with the lesson title.
- [ ] B4. **Open** the join link in another browser: it opens the provider meeting. Zoom: the teacher can start it by
      signing in to Zoom with the join link.
- [ ] B5. Google only: there is exactly **one** calendar event for the appointment (not two).
- [ ] B6. The student books and the booking is confirmed. On `/student/lessons/<id>` the student sees **Join live
      session** with the same link. Another student, and a logged-out visitor, never see the link (check the
      network responses, not only the UI).
- [ ] B7. Before a link exists, a confirmed student sees "your teacher is preparing the meeting link".

## C. Change and cancel

- [ ] C1. On an **unbooked** appointment with a ready meeting, change the time and Save. The hint says the meeting
      will be updated. Within about a minute the provider shows the **new** time; the join link is unchanged.
- [ ] C2. Remove the meeting ("Remove meeting"): the provider meeting is gone; the appointment returns to "not
      requested"; Generate works again and produces a **new** meeting.
- [ ] C3. Cancel an unbooked appointment that has a ready meeting. Within about a minute the meeting is deleted at the provider.
- [ ] C4. Request cancellation of a **booked** appointment: the student page stops offering Join and says
      cancellation was requested. After the refund completes, the meeting is deleted at the provider.

## D. Failure and recovery

- [ ] D1. Revoke Learnix's access **at the provider** (Google account permissions / Zoom installed apps / Microsoft
      "My apps"). Click Generate: the row fails with a clear message, the card shows **Reconnect**, and the teacher
      receives a "reconnect your account" notification linking to the integrations page.
- [ ] D2. **Zoom only:** uninstall the app from the Zoom account. Without clicking anything, the card flips to
      "Revoked: reconnect required" shortly after (deauthorization webhook).
- [ ] D3. Reconnect and Generate again: succeeds.
- [ ] D4. **Account switch:** with a ready, future meeting on account 1, disconnect and connect **account 2**. Expect the
      "remove your upcoming meetings first" message and account 1 unchanged. Remove the meeting, retry: now it works.
- [ ] D5. Disconnect: the card returns to "Connect"; the provider's app-permissions page no longer lists Learnix
      (Microsoft does not support revoke: removal there is manual and expected).

## E. Isolation

- [ ] E1. As the **second teacher**, request the first teacher's session meeting endpoints
      (`POST/DELETE /teacher/lessons/<lesson>/sessions/<session>/meeting`): 403.
- [ ] E2. The first teacher's `/teacher/meeting-accounts` response never contains tokens, only status and email.
- [ ] E3. Student session payloads contain no `meeting_host_url`, `meeting_passcode`, provider, or error fields.

## F. Notifications

- [ ] F1. The student's 24-hour and 1-hour reminders arrive (email text includes the link) and the in-app
      notification opens the student's lesson page.
- [ ] F2. A failed Generate notifies the teacher and the notification opens the teacher's lessons page.

## Provider-specific checks

**Google:** consent screen status (Testing vs verified) noted; if Testing, record that connections lapse after 7 days **[V]**.
**Zoom:** app is in development or published (record which); webhook endpoint validated in the Zoom UI.
**Microsoft:** tested with a work/school account that has Teams; a personal account shows a clear failure, not a hang.

## Result

| Provider | Date | Environment / image tag | Tester | Result (pass / fail + items) | Notes |
| -------- | ---- | ----------------------- | ------ | ---------------------------- | ----- |
|          |      |                         |        |                              |       |

A provider is **production-ready** only after this checklist passes AND its production app registration, secrets and
(for Google) consent-screen verification / (for Zoom) Marketplace publishing are complete.
