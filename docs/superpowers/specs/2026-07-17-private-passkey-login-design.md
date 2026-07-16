# Private Passkey Login — Design

**Date:** 2026-07-17
**Status:** Approved by user

## Problem

The site is currently open to anyone. It needs to sit behind a private login so only
approved people can reach it. There is no self-service signup: a hardcoded admin email
address is the only one ever emailed, and that person decides — outside the website
entirely — whether to hand the registering person a one-time code. Once someone has
proven they got that human approval, they register a WebAuthn passkey and use it for
all future logins. No passwords, no usernames at login (email only, to look up which
passkey to challenge).

## Decisions made during brainstorming

- Registrant provides **name + their own email** when requesting to register. The OTP
  is still only ever emailed to the hardcoded `ADMIN_EMAIL`, never to the registrant.
- The browser that starts a registration is bound to it via a **server-side pending
  registration record + httpOnly cookie** (not a single global in-flight OTP).
- Logged-in state is a **server-side session** (Mongo-backed, cookie holds only the
  session id) — not a JWT — so a session can be revoked by deleting its row.
- **One passkey per person** (no multi-passkey accounts, no shared/multi-device
  accounts for v1). Losing the device means re-registering as a new account via the
  OTP flow.
- Rate limiting (via a `RateLimiter` abstraction, injected/fakeable) covers **both**
  OTP-request spam and OTP-guessing brute force.
- **Entire site is gated**, not just the API: unauthenticated users are redirected to
  `/login` for any route, enforced both client-side (router guard) and server-side
  (`401` on any API call other than `/api/auth/*`).
- OTP: **10-minute expiry, 3 wrong guesses locks it** (must restart from a fresh OTP
  request after that).
- **Login is email-scoped, not usernameless.** The user types their email; the server
  looks up their one passkey and challenges only that credential. (Originally designed
  as a discoverable-credential/usernameless flow, changed during review.) Because of
  this, passkeys registered here do **not** need to be resident/discoverable
  credentials.
- **RBAC: two roles, `admin` and `member`.** The rescrape functionality (starting or
  cancelling a scrape) is the only thing gated by role — everything else any logged-in
  user can see. The first admin is bootstrapped without any manual DB edit: whoever
  registers using the `ADMIN_EMAIL` address becomes `admin` automatically; everyone
  else becomes `member`. Existing admins can later promote/demote other members
  through a small admin-only screen, with a safety rail preventing the last remaining
  admin from being demoted.

## Architecture & data model

New `backend/src/auth/` module. Three new Mongo collections:

- **`pendingRegistrations`**: `{ _id, name, email, otpHash, otpAttempts, expiresAt, verified, challenge? }`.
  `_id` is a random, unguessable token — this is the value stored (signed) in the
  registrant's httpOnly cookie, so only that browser can advance this specific pending
  registration. TTL-indexed on `expiresAt` for automatic cleanup; no cron needed.
- **`users`**: `{ _id, name, email, role: 'admin' | 'member', credential: { id, publicKey, counter, transports }, createdAt }`.
  Exactly one `credential` per user. `email` has a unique index (one account per
  email).
- **`sessions`**: `{ _id, userId, createdAt, expiresAt }`. TTL-indexed on `expiresAt`;
  sliding expiry (refreshed on use), e.g. 30 days.

Libraries:
- `@simplewebauthn/server` (backend) + `@simplewebauthn/browser` (frontend) for the
  WebAuthn registration/authentication ceremonies.
- `mailersend` npm package for sending the OTP email to `ADMIN_EMAIL`.
- A small injectable `RateLimiter` interface (backend concept, not necessarily the
  literal npm package named `throttler`) for both OTP-request and OTP-guess limits.

New env vars, following the existing `MONGO_URI` pattern in `docker-compose.yml`:
`MAILERSEND_API_KEY`, `ADMIN_EMAIL`, `SESSION_SECRET`, `RP_ID`, `RP_NAME`, `ORIGIN`.

## Registration flow

1. `POST /api/auth/register/request { name, email }`
   Rate-limited per IP (e.g. 3/hour). Generates a 6-digit OTP, stores its **hash**
   (never the raw code) plus `name`/`email` in `pendingRegistrations` with a
   10-minute `expiresAt`. Sets the httpOnly `pendingRegId` cookie to the record's
   `_id`. Emails the OTP, along with the registrant's name and email, to
   `ADMIN_EMAIL` via MailerSend. The admin relays the code to the registrant
   out-of-band (chat, verbally, etc.) at their own discretion.

2. `POST /api/auth/register/verify-otp { otp }`
   Reads the pending registration via the `pendingRegId` cookie. Compares the OTP
   against the stored hash. Wrong guesses increment `otpAttempts`; on the 3rd wrong
   guess, or once `expiresAt` has passed, the pending registration is invalidated
   (`410 Gone`) and the registrant must go back to step 1. On success, marks the
   record `verified: true`.

3. `POST /api/auth/register/passkey/options`
   Only allowed when the pending registration is `verified`. Returns WebAuthn
   registration options (non-resident credential) and stores the generated challenge
   on the pending registration record for later verification.

4. `POST /api/auth/register/passkey/verify`
   Verifies the attestation response against the stored challenge. Only on success
   does it create the `users` document (with the new credential) and delete the
   pending registration — so a failed or abandoned passkey ceremony never leaves a
   half-created account. `role` is set here: `admin` if the pending registration's
   email matches `ADMIN_EMAIL` (case-insensitive), otherwise `member`. Immediately
   creates a session and sets the session cookie (auto-login after registering).

## Login flow

1. `POST /api/auth/login/options { email }`
   Looks up the user by email. If found, returns WebAuthn authentication options with
   `allowCredentials` scoped to that user's one stored credential. If not found,
   returns a same-shaped generic error so the response doesn't leak which emails are
   registered.

2. `POST /api/auth/login/verify { email, ...assertion }`
   Re-looks-up the user by email, verifies the assertion (signature + counter) via
   `@simplewebauthn/server` against their stored credential, creates a session row,
   and sets the session cookie.

3. `POST /api/auth/logout`
   Deletes the session document and clears the cookie.

An Express `requireAuth` middleware validates the session cookie against `sessions`
and wraps every route except `/api/auth/*`. On the frontend, a router guard calls
`GET /api/auth/me` on load; a `401` from that or any other API call redirects to
`/login`. `GET /api/auth/me` returns `{ name, email, role }` so the frontend knows
whether to show admin-only UI.

## RBAC (roles & rescrape gating)

Two roles: `admin` and `member`. Rescrape is the only functionality gated by role —
every other authenticated route is open to any logged-in user.

- `POST /api/scrape` and `POST /api/scrape/cancel` are wrapped in a `requireAdmin`
  middleware (stacks on top of `requireAuth`; checks `role === 'admin'`, else `403`).
  `GET /api/scrape/status` stays open to all logged-in users (read-only, not
  sensitive).
- `GET /api/admin/users` — admin-only. Lists all accounts: `name`, `email`, `role`,
  `createdAt`.
- `PATCH /api/admin/users/:id/role { role }` — admin-only. Changes a user's role.
  Rejects (`409`) any change that would leave zero `admin` users in the system, so an
  admin can never accidentally demote the last admin (including themselves) and lock
  everyone out of the rescrape function and the admin screen itself.
- Frontend: `/admin/users` is an admin-only route (redirects non-admins away); it
  lists accounts with a role toggle calling the endpoint above. The rescrape button
  elsewhere in the UI is hidden/disabled for `member` accounts based on the `role`
  from `GET /api/auth/me`.

## Error handling & security

- OTP-request throttle exceeded → `429` with retry-after.
- Wrong OTP → `400`; 3rd wrong guess → `410 Gone`, must restart.
- Expired pending registration → same `410`, cleaned up automatically by Mongo TTL.
- Passkey ceremony fails/cancelled client-side → surfaced as an error message; no
  account or credential is persisted, so the registrant can just retry the passkey
  step without redoing the OTP (as long as the pending registration hasn't expired).
- Login with an unrecognized email or a credential mismatch → generic `401`, no
  distinction in the response between "no such email" and "wrong passkey".
- Session expiry → sliding TTL via Mongo TTL index on `sessions.expiresAt`.
- Non-admin hitting a `requireAdmin` route (rescrape, `/api/admin/users`) → `403`.
- Attempting to demote the last remaining admin → `409`, role unchanged.

## Testing

Per repo TDD rules, nothing in the test suite hits MailerSend or a real authenticator:

- `EmailSender` is an injected interface; tests use an in-memory fake that records
  sent messages, for asserting the OTP email content/recipient without a real API call.
- WebAuthn ceremonies are tested using `@simplewebauthn`'s documented mock-authenticator
  test vectors, not real hardware.
- `RateLimiter` is injected with a fake clock, so throttle/lockout behavior (OTP resend
  limits, 3-guess lockout, 10-minute expiry) is deterministic in tests.
- Route-level tests use `supertest` against `createApp`, consistent with existing API
  tests.
- RBAC is covered at the route level: a `member` session gets `403` on rescrape and
  admin-user routes; an `admin` session succeeds; demoting the last admin returns
  `409` and leaves the role unchanged; registering with `ADMIN_EMAIL` yields `role:
  'admin'` and any other email yields `role: 'member'`.
