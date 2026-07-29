# Responsive Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app usable on phone-width screens — a hamburger-triggered mobile nav drawer replacing the always-visible sidebar below `md` (768px), and row layouts on two pages that squeeze buttons on narrow screens.

**Architecture:** Two independent slices. `AppShell` (`frontend/src/App.tsx`) gains local open/close state for a slide-in overlay drawer, toggled by a new hamburger button and auto-closed on route change — desktop (`md:` and up) renders byte-for-byte the same as today. `SettingsPage.tsx` and `AdminUsersPage.tsx` get their per-row flex layout changed from a fixed horizontal `justify-between` to stacking vertically below `sm` (640px).

**Tech Stack:** React + Vite + Tailwind (frontend), Vitest + Testing Library for unit tests, Playwright for live verification (per the project's e2e-verification rule).

## Global Constraints

- Write the failing test first, confirm it fails for the right reason, then write minimal code to pass it (`CLAUDE.md` TDD rule) — applies to Task 1 (App.tsx), which has real conditional-rendering behavior to test.
- Commit immediately after each green test run. Never commit red.
- Desktop (`md:` and up) rendering must not visually change — every new class is either `md:hidden`, `md:static`, `md:translate-x-0`, or purely mobile-scoped.
- Follow the existing code style in each file exactly (no new abstractions, no comments beyond what's already there unless a WHY needs explaining).
- After implementing, verify live with Playwright at both phone width (375px) and desktop width, per `CLAUDE.md`'s e2e-verification rule — this is a browser-visible UI change.

---

### Task 1: Hamburger mobile nav drawer

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — Task 2 is independent.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/test/App.test.tsx`, inside `describe('App', ...)`, after the `'shows the signed-in user's email and a Log out button...'` test:

```ts
  it('shows a hamburger button; clicking it opens the mobile nav backdrop, clicking the backdrop closes it', async () => {
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByTestId('nav-backdrop')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /toggle navigation menu/i }));
    expect(screen.getByTestId('nav-backdrop')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('nav-backdrop'));
    expect(screen.queryByTestId('nav-backdrop')).not.toBeInTheDocument();
  });

  it('closes the mobile nav drawer after navigating via a nav link', async () => {
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('button', { name: /toggle navigation menu/i }));
    expect(screen.getByTestId('nav-backdrop')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Data Sources')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-backdrop')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w frontend -- App.test`
Expected: FAIL — no button with accessible name "Toggle navigation menu" exists yet, and no `nav-backdrop` test id exists.

- [ ] **Step 3: Write the implementation**

In `frontend/src/App.tsx`, update the `react-router-dom` import to add `useLocation`:

```tsx
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
```

Add a `react` import at the top of the file (it doesn't currently import anything from `react`):

```tsx
import { useEffect, useState } from 'react';
```

Add a new `HamburgerIcon` component, next to the other icon components (after `SettingsIcon`, before the `ICONS` object):

```tsx
function HamburgerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
    </svg>
  );
}
```

Replace the full `AppShell` function with:

```tsx
function AppShell() {
  const [isNavOpen, setIsNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setIsNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex flex-col h-screen">
      <header className="w-full bg-blue-900 text-white px-6 py-6 flex items-center justify-between md:justify-end shrink-0">
        <button
          type="button"
          onClick={() => setIsNavOpen((open) => !open)}
          aria-label="Toggle navigation menu"
          className="md:hidden text-white"
        >
          <HamburgerIcon />
        </button>
      </header>
      <div className="flex flex-1 overflow-hidden relative">
        {isNavOpen && (
          <div
            data-testid="nav-backdrop"
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setIsNavOpen(false)}
          />
        )}
        <nav
          className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 pt-[22px] flex flex-col overflow-y-auto transition-transform duration-200 md:static md:translate-x-0 ${
            isNavOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center gap-2 mb-4">
            <img src="/favicon.png" alt="" className="w-12 h-12 shrink-0" />
            <div className="text-hero font-semibold text-blue-900">Malaysia Tender Aggregator</div>
          </div>
          <div className="space-y-1">
            <NavLink to="/dashboard" className={navLinkClass}><Icon path={ICONS.dashboard} />Dashboard</NavLink>
            <NavLink to="/open" className={navLinkClass}><Icon path={ICONS.open} />Open Tenders</NavLink>
            <NavLink to="/closed" className={navLinkClass}><Icon path={ICONS.closed} />Closed Tenders</NavLink>
            <NavLink to="/awarded" className={navLinkClass}><Icon path={ICONS.awarded} />Awarded Tenders</NavLink>
          </div>
          <div className="mt-auto space-y-1">
            <NavLink to="/about" className={navLinkClass}><Icon path={ICONS.about} />About</NavLink>
            <NavLink to="/settings" className={navLinkClass}><SettingsIcon />Settings</NavLink>
            {useAuth().user?.role === 'admin' && (
              <NavLink to="/admin/users" className={navLinkClass}>Manage users</NavLink>
            )}
            <SignedInFooter />
          </div>
        </nav>
        <div className="flex-1 flex flex-col overflow-y-auto">
          <main className="px-6 pb-6 pt-[22px] flex-1 bg-[#F8FAFC]">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
```

(Only the wrapping `<header>`, the new hamburger button, the new backdrop `<div>`, and the `<nav>` element's `className` changed — everything inside `<nav>` and the `<main>` block is unchanged from today.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w frontend -- App.test`
Expected: PASS (all tests in this file)

- [ ] **Step 5: Run the full frontend suite**

Run: `npm run test -w frontend`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat: add a hamburger-triggered mobile nav drawer"
```

---

### Task 2: Responsive row layouts in Settings and Manage Users

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/src/pages/AdminUsersPage.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — this is the last code task.

This is a pure Tailwind class change with no new conditional logic — per the design spec, no new unit tests are added (jsdom doesn't perform real CSS layout, so a wrapped-vs-not-wrapped assertion would be meaningless). Verified live in Task 3 instead. Existing tests in `SettingsPage.test.tsx` and `AdminUsersPage.test.tsx` use only role/text queries, not `className` assertions, so they're unaffected by this change — no test updates needed.

- [ ] **Step 1: Update `SettingsPage.tsx`**

In `frontend/src/pages/SettingsPage.tsx`, change:

```tsx
              <div key={s.name} role="group" aria-label={s.name} className="p-4 flex items-center justify-between gap-4">
```
to:
```tsx
              <div key={s.name} role="group" aria-label={s.name} className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
```

And change the button-group wrapper:
```tsx
                    <div className="flex gap-2">
```
to:
```tsx
                    <div className="flex flex-wrap gap-2">
```

- [ ] **Step 2: Update `AdminUsersPage.tsx`**

In `frontend/src/pages/AdminUsersPage.tsx`, change:

```tsx
          <div key={u.id} className="p-4 flex items-center justify-between gap-4">
```
to:
```tsx
          <div key={u.id} className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
```

- [ ] **Step 3: Run the affected test files to confirm nothing broke**

Run: `npm run test -w frontend -- SettingsPage AdminUsersPage`
Expected: PASS (unchanged — these tests query by role/text, not layout)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/src/pages/AdminUsersPage.tsx
git commit -m "feat: stack Settings and Manage Users rows on narrow screens"
```

---

### Task 3: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all workspaces pass (shared, backend, frontend), coverage thresholds met.

- [ ] **Step 2: Live Playwright verification at phone width (375×812)**

Start the frontend dev server. Using Playwright, resize to 375×812 and check, without triggering any scrape (do not click Fetch open / Full refresh / Refresh awarded results / Rescrape — those would hit the real backend/live sites):

- The sidebar is hidden by default; a hamburger button is visible in the header.
- Clicking the hamburger slides the sidebar in as an overlay with a visible backdrop.
- Clicking the backdrop closes it.
- Clicking a nav link (e.g. "Open Tenders") navigates and closes the drawer.
- On the Open/Closed/Awarded Tenders list pages: the filter grid stacks to a single/double column and the tender table scrolls horizontally without breaking the page layout (per the design's decision to keep horizontal scroll, not convert to cards).
- On the Settings page (as an admin, or note if testing as a non-admin that the buttons simply don't render — either is fine): each source row's label stacks above its buttons instead of overflowing.
- On the Dashboard, Detail, About, Login, and Register pages: content fits within the viewport without horizontal overflow of the page itself (the data table's own internal scroll is expected and fine).

- [ ] **Step 3: Live Playwright verification at desktop width (1280×800)**

Resize to 1280×800 and confirm the sidebar is permanently visible (no hamburger button interaction needed, matches today's layout), and spot-check 2-3 pages to confirm nothing regressed visually from before this plan.

- [ ] **Step 4: Report results**

Summarize what was checked and any issues found. If an issue is found, fix it, re-run the affected unit tests, and re-verify the specific page/viewport combination that failed.
