# Logout button + admin can remove users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working logout control to the UI, and let admins permanently remove a user account (including their sessions).

**Architecture:** Two independent slices on top of the existing passkey-auth system (`backend/src/auth/`, `frontend/src/auth/`). The logout slice only touches the frontend (`App.tsx`) — the backend route and `signOut()` already exist. The remove-user slice adds a `delete` method to `UserRepository`, a `deleteByUserId` method to `SessionRepository`, a `DELETE /api/admin/users/:id` route, and frontend wiring in `AdminUsersPage.tsx`.

**Tech Stack:** Express + TypeScript (backend), React + Vite + Tailwind + TanStack Query (frontend), Vitest + Supertest (backend tests), Vitest + Testing Library + MSW (frontend tests).

## Global Constraints

- Write the failing test first, confirm it fails for the right reason, then write minimal code to pass it (`CLAUDE.md` TDD rule).
- Commit immediately after each green test run. Never commit red.
- Tests must never hit real external services — this feature has none, so this constraint is automatically satisfied.
- Follow the existing code style in each file exactly (no new abstractions, no comments beyond what's already there unless a WHY needs explaining).

---

### Task 1: `SessionRepository.deleteByUserId`

**Files:**
- Modify: `backend/src/auth/sessionRepository.ts`
- Test: `backend/test/auth/sessionRepository.test.ts`

**Interfaces:**
- Consumes: `QueryableCollection<SessionDoc>.find(filter)` (already used elsewhere in this file), `.deleteOne(filter)`.
- Produces: `SessionRepository.deleteByUserId(userId: string): Promise<void>` — used by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/auth/sessionRepository.test.ts`, inside the existing `describe('SessionRepository', ...)` block, after the `'delete removes the session'` test:

```ts
  it('deleteByUserId removes every session for that user but leaves other users\' sessions', async () => {
    const repo = new SessionRepository(new FakeCollection<SessionDoc>(), () => new Date('2026-07-17T00:00:00.000Z'));
    const s1 = await repo.create('user-1', 1000);
    const s2 = await repo.create('user-1', 1000);
    const s3 = await repo.create('user-2', 1000);
    await repo.deleteByUserId('user-1');
    expect(await repo.findById(s1._id)).toBeNull();
    expect(await repo.findById(s2._id)).toBeNull();
    expect(await repo.findById(s3._id)).toEqual(s3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- sessionRepository`
Expected: FAIL — `repo.deleteByUserId is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/auth/sessionRepository.ts`, add this method after `delete`:

```ts
  async deleteByUserId(userId: string): Promise<void> {
    const docs = await this.collection.find({ userId }).toArray();
    for (const doc of docs) await this.collection.deleteOne({ _id: doc._id });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- sessionRepository`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/sessionRepository.ts backend/test/auth/sessionRepository.test.ts
git commit -m "feat: add SessionRepository.deleteByUserId"
```

---

### Task 2: `UserRepository.delete`

**Files:**
- Modify: `backend/src/auth/userRepository.ts`
- Test: `backend/test/auth/userRepository.test.ts`

**Interfaces:**
- Consumes: `QueryableCollection<UserDoc>.deleteOne(filter)`.
- Produces: `UserRepository.delete(id: string): Promise<void>` — used by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/auth/userRepository.test.ts`, inside `describe('UserRepository', ...)`, after the `updateCredentialCounter` test:

```ts
  it('delete removes the user', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    const created = await repo.create({ name: 'A', email: 'a@example.com', role: 'member', credential });
    await repo.delete(created._id);
    expect(await repo.findById(created._id)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- userRepository`
Expected: FAIL — `repo.delete is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/auth/userRepository.ts`, add this method after `updateCredentialCounter`:

```ts
  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- userRepository`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/userRepository.ts backend/test/auth/userRepository.test.ts
git commit -m "feat: add UserRepository.delete"
```

---

### Task 3: `DELETE /api/admin/users/:id` route

**Files:**
- Modify: `backend/src/auth/adminRoutes.ts`
- Test: `backend/test/auth/adminRoutes.test.ts`

**Interfaces:**
- Consumes: `UserRepository.findById`, `.countByRole`, `.delete` (Task 2); `SessionRepository.deleteByUserId` (Task 1); `AuthedRequest` type from `./middleware.js` (already exists — `req.user?: UserDoc`).
- Produces: `DELETE /api/admin/users/:id` — 404 (unknown id) / 409 (removing the sole remaining admin) / 400 (removing your own account, when not the sole admin) / 200 `{ ok: true }` (success). Mounted under the router's existing `requireAuth` + `requireAdmin` middleware, so unauthenticated/non-admin callers already get 401/403 before reaching this handler.

**Design note on check order:** the last-remaining-admin check runs *before* the self-delete check. If a lone admin tries to delete their own account, `countByRole('admin') <= 1` is true, so they get the more informative 409 ("cannot remove the last remaining admin") rather than the generic self-delete 400. The self-delete 400 only fires when there's at least one other admin around (so deleting yourself wouldn't zero out the admin count, but is still disallowed to avoid an accidental self-lockout).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/auth/adminRoutes.test.ts`, inside `describe('admin routes', ...)`, after the existing last test:

```ts
  it('DELETE /users/:id removes a member and their sessions', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const memberSession = await sessions.create(member._id, 1000 * 60 * 60);
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.delete(`/api/admin/users/${member._id}`);
    expect(res.status).toBe(200);
    expect(await users.findById(member._id)).toBeNull();
    expect(await sessions.findById(memberSession._id)).toBeNull();
  });

  it('DELETE /users/:id 404s for an unknown user', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);
    expect((await adminAgent.delete('/api/admin/users/nope')).status).toBe(404);
  });

  it('DELETE /users/:id refuses to remove the last remaining admin, even if it is your own account', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.delete(`/api/admin/users/${admin._id}`);
    expect(res.status).toBe(409);
    expect(await users.findById(admin._id)).not.toBeNull();
  });

  it('DELETE /users/:id refuses to remove your own account when another admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    const admin1Agent = await agentAs(admin1._id);

    const res = await admin1Agent.delete(`/api/admin/users/${admin1._id}`);
    expect(res.status).toBe(400);
    expect(await users.findById(admin1._id)).not.toBeNull();
  });

  it('DELETE /users/:id allows removing another admin when a third admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    const admin2 = await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    await users.create({ name: 'Admin3', email: 'admin3@example.com', role: 'admin', credential });
    const admin1Agent = await agentAs(admin1._id);

    const res = await admin1Agent.delete(`/api/admin/users/${admin2._id}`);
    expect(res.status).toBe(200);
    expect(await users.findById(admin2._id)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w backend -- adminRoutes`
Expected: FAIL — all five new tests fail with 404 (no such route registered yet, since Express has no `DELETE /users/:id` handler).

- [ ] **Step 3: Write minimal implementation**

In `backend/src/auth/adminRoutes.ts`, add the import and route:

```ts
import type { AuthedRequest } from './middleware.js';
```

(add alongside the existing imports at the top)

```ts
  router.delete('/users/:id', ah(async (req, res) => {
    const target = await deps.users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });

    if (target.role === 'admin') {
      const adminCount = await deps.users.countByRole('admin');
      if (adminCount <= 1) return res.status(409).json({ error: 'cannot remove the last remaining admin' });
    }

    const requester = (req as AuthedRequest).user;
    if (target._id === requester?._id) return res.status(400).json({ error: 'cannot remove your own account' });

    await deps.sessions.deleteByUserId(target._id);
    await deps.users.delete(target._id);
    res.json({ ok: true });
  }));
```

Add this route inside `createAdminRoutes`, after the `router.patch('/users/:id/role', ...)` block and before `return router;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w backend -- adminRoutes`
Expected: PASS (10 tests total in this file)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/adminRoutes.ts backend/test/auth/adminRoutes.test.ts
git commit -m "feat: add DELETE /api/admin/users/:id route"
```

---

### Task 4: Frontend — admin "Remove" button

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/pages/AdminUsersPage.tsx`
- Test: `frontend/src/test/AdminUsersPage.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` from `../auth/AuthContext` (already exists, returns `{ user: CurrentUser | null, ... }`, where `CurrentUser = { name, email, role }` — no `id` field, so the "is this my own row" check compares by `email`).
- Produces: `deleteUser(id: string): Promise<void>` in `client.ts`, used only within `AdminUsersPage.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/test/AdminUsersPage.test.tsx`, inside `describe('AdminUsersPage', ...)`, after the existing tests. First add this import at the top of the file (alongside the others):

```ts
import { server } from './mocks';
```

(already imported — no change needed there; just confirm it's present)

Now append these tests:

```ts
  it('removes a user when Remove is clicked and confirmed', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let deletedId: string | undefined;
    server.use(http.delete('/api/admin/users/2', ({ params }) => {
      deletedId = params.id as string;
      return HttpResponse.json({ ok: true });
    }));

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove member@example\.com/i }));

    await waitFor(() => expect(deletedId).toBe('2'));
  });

  it('does not call the delete endpoint when the confirm dialog is cancelled', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    let deleteCalled = false;
    server.use(http.delete('/api/admin/users/2', () => {
      deleteCalled = true;
      return HttpResponse.json({ ok: true });
    }));

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove member@example\.com/i }));

    expect(deleteCalled).toBe(false);
  });

  it('shows an error message when removal is rejected with 409', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    server.use(http.delete('/api/admin/users/1', () =>
      HttpResponse.json({ error: 'cannot remove the last remaining admin' }, { status: 409 }),
    ));

    renderPage();
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove admin@example\.com/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cannot remove the last remaining admin/i));
  });

  it('does not show a Remove button on the signed-in admin\'s own row', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /remove admin@example\.com/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove member@example\.com/i })).toBeInTheDocument();
  });
```

Also add `vi` to the vitest import at the top of the file:

```ts
import { describe, expect, it, vi } from 'vitest';
```

**Note:** these tests call `useAuth()`, which fetches `/api/auth/me` — but `AdminUsersPage` is rendered directly (not through `AuthProvider`) in `renderPage()`. Update `renderPage()` in this same file to wrap with `AuthProvider`:

```ts
import { AuthProvider } from '../auth/AuthContext';

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AdminUsersPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}
```

The two pre-existing tests in this file (`'lists users and can change a role'`, `'shows an error message when demoting...'`) don't set a `/api/auth/me` handler override, so they'll use the default mock (`role: 'member'`, from `mocks.ts`) — that's fine, since those tests don't depend on admin identity, only on the users list and role-change flow.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w frontend -- AdminUsersPage`
Expected: FAIL — no "Remove" buttons exist yet, `screen.getByRole('button', { name: /remove .../i })` throws not found.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api/client.ts`, add after `updateUserRole`:

```ts
export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const message = await res
      .json()
      .then((body: { error?: string }) => body?.error)
      .catch(() => undefined);
    throw new Error(message ?? `remove user failed: ${res.status}`);
  }
}
```

Replace the full contents of `frontend/src/pages/AdminUsersPage.tsx` with:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteUser, fetchAdminUsers, updateUserRole } from '../api/client';
import type { Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: users } = useQuery({ queryKey: ['admin-users'], queryFn: fetchAdminUsers });
  const roleMutation = useMutation({
    mutationFn: (params: { id: string; role: Role }) => updateUserRole(params.id, params.role),
    onMutate: () => setError(null),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not update role. Please try again.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onMutate: () => setError(null),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not remove user. Please try again.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">Manage users</h1>
      {error && <div role="alert" className="text-sm text-red-700">{error}</div>}
      <div className="border border-[#e0e0e0] rounded-lg divide-y">
        {(users ?? []).map((u) => (
          <div key={u.id} className="p-4 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-gray-500">
                <span>{u.email}</span> · joined {u.createdAt.slice(0, 10)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm">
                <span className="sr-only">Role for {u.email}</span>
                <select
                  aria-label={`Role for ${u.email}`}
                  value={u.role}
                  onChange={(e) => roleMutation.mutate({ id: u.id, role: e.target.value as Role })}
                  className="border border-[#e0e0e0] rounded-md px-2 py-1"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              {u.email !== currentUser?.email && (
                <button
                  onClick={() => {
                    if (window.confirm(`Remove ${u.email}? This cannot be undone.`)) removeMutation.mutate(u.id);
                  }}
                  disabled={removeMutation.isPending}
                  className="border border-red-700 text-red-700 text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                >
                  Remove {u.email}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Note the button's accessible name is `Remove {u.email}` (visible text, no `aria-label` needed) so the test's `{ name: /remove member@example\.com/i }` matches directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w frontend -- AdminUsersPage`
Expected: PASS (6 tests total in this file)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/pages/AdminUsersPage.tsx frontend/src/test/AdminUsersPage.test.tsx
git commit -m "feat: let admins remove a user from Manage users"
```

---

### Task 5: Frontend — sidebar logout control

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`{ user: CurrentUser | null, signOut: () => Promise<void> }`, already exists).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/test/App.test.tsx`, inside `describe('App', ...)`, after the `'shows a Manage users link for an admin...'` test:

```ts
  it('shows the signed-in user\'s email and a Log out button in the sidebar, which signs them out', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    render(<App />);
    await waitFor(() => expect(screen.getByText('jane@example.com')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument()); // redirected to /login
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w frontend -- App.test`
Expected: FAIL — `screen.getByText('jane@example.com')` not found.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/App.tsx`, modify the `AppShell` function's bottom nav block. Current code (around line 80-86):

```tsx
          <div className="mt-auto space-y-1">
            <NavLink to="/about" className={navLinkClass}><Icon path={ICONS.about} />About</NavLink>
            <NavLink to="/settings" className={navLinkClass}><SettingsIcon />Settings</NavLink>
            {useAuth().user?.role === 'admin' && (
              <NavLink to="/admin/users" className={navLinkClass}>Manage users</NavLink>
            )}
          </div>
```

Replace with:

```tsx
          <div className="mt-auto space-y-1">
            <NavLink to="/about" className={navLinkClass}><Icon path={ICONS.about} />About</NavLink>
            <NavLink to="/settings" className={navLinkClass}><SettingsIcon />Settings</NavLink>
            {useAuth().user?.role === 'admin' && (
              <NavLink to="/admin/users" className={navLinkClass}>Manage users</NavLink>
            )}
            <SignedInFooter />
          </div>
```

Add this new component just above `function AppShell()`:

```tsx
function SignedInFooter() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <div className="px-4 pt-3 mt-2 border-t border-[#e0e0e0] space-y-1">
      <div className="text-xs text-gray-500 truncate">{user.email}</div>
      <button
        onClick={() => void signOut()}
        className="text-[12px] font-bold text-blue-900 hover:underline"
      >
        Log out
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w frontend -- App.test`
Expected: PASS (all tests in this file)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat: add a logout button to the sidebar"
```

---

### Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all workspaces pass (shared, backend, frontend), coverage thresholds met.

- [ ] **Step 2: Manually verify in the browser**

Start the dev servers (`npm run dev -w backend`, `npm run dev -w frontend`), log in, confirm:
- The sidebar shows your email and a "Log out" button; clicking it returns you to `/login`.
- As an admin, `/admin/users` shows a "Remove" button on every row except your own; clicking it prompts for confirmation, then removes the user from the list.
- Attempting to remove the last remaining admin shows the error banner instead of removing them.
