# Creator Portal Verify Email Audit

## Scope audited
- `web/backend/routes/creator-portal.js`
- `web/server.js`
- `prisma/schema.prisma`

## Current flow (what happens today)
1. Signup (`POST /api/signup`) upserts a `Creator` row and generates a 6-digit code with 15-minute expiry.
2. The code is saved in `VerificationCode`.
3. `sendVerificationEmail` is called.
4. Email is sent **only** if `RESEND_API_KEY` exists.
5. If `RESEND_API_KEY` is missing, the app logs the code to server logs and does not actually deliver mail.
6. Login blocks unverified users and tells them to verify email first.

## Why users may never receive email

### 1) Hard dependency on Resend key for real delivery
- The mailer has exactly one real provider path (`RESEND_API_KEY`).
- Without it, behavior is dev-only: warning + code logged to stdout.
- This means signup can appear successful but no inbox email arrives.

### 2) Potential sender/domain deliverability issue
- Default sender is `Onsite Affiliate <no-reply@onsiteaffiliate.com>`.
- If your Resend account/domain is not verified for that from-address, sends can fail or be suppressed.

### 3) No pruning/rate-limit/attempt controls on verification codes
- New codes are always created and old ones remain unused/active until expiry.
- This can create confusion if multiple codes are requested rapidly.

### 4) No admin-facing health check for mail provider config
- There is no explicit runtime check or UI indicator for creator-email readiness.
- Misconfiguration is only visible in server logs.

## Most likely root cause for your symptom
If you "can’t receive an email and login," the most likely issue is missing or invalid `RESEND_API_KEY` and/or an unverified sender domain (`CREATOR_EMAIL_FROM`) in the deployed environment.

## Fast verification checklist
1. Confirm env var `RESEND_API_KEY` is present in the running app.
2. Confirm `CREATOR_EMAIL_FROM` uses a sender/domain verified in Resend.
3. Trigger signup and inspect app logs for either:
   - `[Creator] RESEND_API_KEY is not configured; cannot deliver verification email.`
   - `Resend email failed (<status>): ...`
4. Use `POST /api/resend-code` from portal and confirm Resend dashboard activity.

## Recommended fixes (priority)
1. Add startup/config validation and expose status in admin (green/red check for creator email).
2. Fail signup with a clear 503 when email provider is not configured in production.
3. Add code invalidation policy (mark previous unused codes as used when sending a new one).
4. Add basic resend throttling (e.g., 1 request / 30–60 seconds per email).
5. Add structured email send logs with provider response IDs for support debugging.
