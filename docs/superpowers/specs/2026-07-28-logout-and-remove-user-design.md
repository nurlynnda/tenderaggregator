# Logout button + admin can remove users

## Context

Passkey login/sessions/admin role management already exist ([2026-07-17-private-passkey-login-design.md](2026-07-17-private-passkey-login-design.md)). Two gaps remain:

1. The backend `/api/auth/logout` route and `AuthContext.signOut()` both already work, but nothing in the UI calls them — there is no logout control anywhere.
2. Admins can change a user's role (`PATCH /api/admin/users/:id/role`) but cannot remove a user account.

## Logout button

Add a small block at the bottom of the left sidebar in `frontend/src/App.tsx`, below the Settings/About links, showing the signed-in user's email and a "Log out" button.

- Clicking it calls `useAuth().signOut()`.
- `signOut()` already clears `user` to `null` in `AuthContext`; the existing `RequireAuth` wrapper redirects to `/login` once `user` is `null`, so no extra navigation logic is needed.

## Admin remove user

### Backend

- `UserRepository.delete(id: string): Promise<void>` — `this.collection.deleteOne({ _id: id })`.
- `SessionRepository.deleteByUserId(userId: string): Promise<void>` — find all sessions for that user via `collection.find({ userId }).toArray()`, then `deleteOne({ _id })` each. (No `deleteMany` on `QueryableCollection`, so this loops over `deleteOne`.)
- New route in `backend/src/auth/adminRoutes.ts`, mounted under the existing `router.use(requireAuth(...), requireAdmin())`:

  ```
  DELETE /api/admin/users/:id
  ```

  Logic:
  1. Look up the target user by `:id`. 404 `{ error: 'user not found' }` if missing.
  2. If `target._id === req.user._id` (the requesting admin), 400 `{ error: 'cannot remove your own account' }`.
  3. If `target.role === 'admin'` and `countByRole('admin') <= 1`, 409 `{ error: 'cannot remove the last remaining admin' }` (mirrors the existing demote-last-admin rule).
  4. Otherwise: `sessions.deleteByUserId(target._id)`, then `users.delete(target._id)`, respond `200 { ok: true }`.

  `req.user` is available because `AuthedRequest` (from `middleware.ts`) attaches it during `requireAuth`.

### Frontend

- `deleteUser(id: string): Promise<void>` in `frontend/src/api/client.ts` — `DELETE /api/admin/users/:id`, throwing an `Error` with the server's `error` message on non-2xx (same pattern as `updateUserRole`).
- In `AdminUsersPage.tsx`:
  - Read the current user via `useAuth()` to compare against each row's `id` and hide the "Remove" button on the admin's own row.
  - Add a "Remove" button per row, wired to a mutation calling `deleteUser`.
  - On click, show `window.confirm('Remove <email>? This cannot be undone.')`; only call the mutation if confirmed.
  - Reuse the existing `error` state / `role="alert"` banner for 400/409 failures.
  - On success, invalidate the `['admin-users']` query (same as the role mutation).

## Testing

Per `CLAUDE.md`'s TDD rule — write the failing test first for each:

- `backend/test/auth/userRepository.test.ts`: `delete` removes the doc; `findById` returns `null` after.
- `backend/test/auth/sessionRepository.test.ts`: `deleteByUserId` removes all sessions for that user and leaves other users' sessions intact.
- `backend/test/auth/adminRoutes.test.ts`: covers 404 (unknown id), 400 (self-delete), 409 (last admin), and the success path (200 + user actually gone + their session deleted).
- `frontend/src/test/AdminUsersPage.test.tsx`: clicking Remove (with confirm mocked true) calls the delete endpoint and removes the row; a 409 response shows the error banner; the current admin's own row has no Remove button.
- A small test (new file or added to `App.test.tsx`) confirming the sidebar shows the user's email and a Log out button, and clicking it triggers `signOut`.

## Out of scope

- Bulk user removal.
- Soft-delete / undo.
- Audit logging of removals.
