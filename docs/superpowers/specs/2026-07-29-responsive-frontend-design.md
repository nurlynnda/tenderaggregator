# Responsive frontend

## Problem

The app's layout is fixed-width and desktop-only. `AppShell` in `frontend/src/App.tsx`
renders a permanent 224px (`w-56`) sidebar plus a decorative empty header, with no
mobile alternative — on a 375px-wide phone the sidebar alone eats most of the
viewport, leaving almost no room for page content. None of the app's pages or the
shell currently adapt below desktop widths in any coordinated way.

## Investigation (2026-07-29)

Read every page component and the shell:

- **`AppShell` (`App.tsx`)** — the actual blocker. Fixed `w-56` sidebar, always
  rendered, no toggle, no responsive classes at all.
- **`SettingsPage.tsx`, `AdminUsersPage.tsx`** — each row is
  `flex items-center justify-between gap-4` with a cluster of buttons on the right
  (Settings: up to 3 buttons — Fetch open / Full refresh / Refresh awarded results;
  Admin: a role `<select>` + Remove button). These squeeze badly on a narrow phone.
- **Everything else** (`DashboardPage`, `TenderListPage` — used for Open/Closed/
  Awarded — `DetailPage`, `MinistryDetailPage`, `ContractorDetailPage`,
  `AboutPage`, `LoginPage`, `RegisterPage`) already uses fluid layout primitives:
  `max-w-*` containers, `flex-wrap`, responsive `grid-cols-*`
  (`TenderListPage`'s filter grid is already `grid-cols-2 sm:grid-cols-3
  lg:grid-cols-5`). These pages need no changes — they just need the shell to stop
  reserving 224px of width unconditionally.
- **Data tables** (`TenderListPage`'s tender table, `DetailPage`'s Events table)
  already sit inside an `overflow-x-auto` wrapper, giving horizontal-scroll on
  narrow screens today. Decision (brainstormed): keep this as-is rather than
  converting to a stacked-card layout — lower risk, already works, no new markup
  or tests per table.

## Decision (from brainstorming, incl. visual mockup review)

| Topic | Decision |
|---|---|
| Mobile sidebar pattern | Hamburger (☰) button in the header opens the sidebar as a slide-in overlay drawer, with a backdrop that closes it on click. Chosen over a bottom tab bar (this app has 6–7 nav items, more than a tab bar comfortably fits) and an icon-only collapsed sidebar (still eats width, ambiguous with this many sections). |
| Breakpoint | `md` (768px). Below it: sidebar hidden by default, opened via hamburger. At `md:` and above: sidebar permanently visible, exactly like today — desktop is visually unchanged. |
| Data tables | Keep the existing horizontal-scroll behavior. No stacked-card conversion. |
| Row layouts (Settings/Admin) | Stack label above controls on narrow screens (`flex-col sm:flex-row`), wrap button groups. |
| All other pages | No changes — already fluid, confirmed by reading each one. |

## Architecture

### `frontend/src/App.tsx`

`AppShell` gains local `useState` for drawer-open (`isNavOpen`), reset to closed on
every route change (a `useEffect` keyed on `useLocation().pathname`, so navigating
via a nav link — including on mobile — closes the drawer automatically without
each `NavLink`'s `onClick` needing to know about it).

- The header (currently an empty `<header>` bar) gets a hamburger `<button>`,
  visible only below `md` (`md:hidden`), toggling `isNavOpen`.
- The `<nav>` sidebar element gets:
  - Mobile (below `md`): `fixed inset-y-0 left-0 z-40` overlay, translated
    off-screen (`-translate-x-full`) when closed and `translate-x-0` when open,
    with a `transition-transform` for the slide animation.
  - Desktop (`md:` and up): reverts to today's static in-flow `w-56` column
    (`md:static md:translate-x-0`), so nothing about desktop rendering changes.
- A backdrop `<div>` (semi-transparent, `fixed inset-0 z-30`), rendered only when
  `isNavOpen` and only below `md` (`md:hidden`), closes the drawer on click.
- Existing nav content (logo, all `NavLink`s, the sidebar footer with logout) is
  unchanged — only the wrapping element's classes and the new hamburger/backdrop
  are added.

No changes to routing, `RequireAuth`, `RequireAdmin`, or any page component's own
export — this is scoped entirely to `AppShell`'s markup.

### `frontend/src/pages/SettingsPage.tsx`

Each source row's outer `<div role="group" ...>` changes from
`flex items-center justify-between gap-4` to
`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4` — the
label block stacks above the button group below `sm` (640px), sits side-by-side at
`sm:` and up (today's layout, unchanged at that width and above). The button
group (`Fetch open` / `Full refresh` / `Refresh awarded results` / `Cancel`)
additionally gains `flex-wrap` so 3 buttons don't force horizontal overflow on a
narrow phone even before the `sm` breakpoint stacks them under the label.

### `frontend/src/pages/AdminUsersPage.tsx`

Same treatment: each user row's outer `<div>` changes from
`flex items-center justify-between gap-4` to
`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4`.

## Testing

- `frontend/src/test/App.test.tsx`: hamburger button is hidden on desktop-width
  render (jsdom's default viewport is desktop-sized, so `md:hidden` should keep it
  out of the accessibility tree / not clickable in a way that matters — assert via
  class presence rather than viewport simulation, since jsdom doesn't do real
  layout); clicking the hamburger toggles the drawer open; clicking the backdrop
  closes it; navigating via a nav link closes it (drawer state resets on route
  change).
- No new unit tests for the `SettingsPage`/`AdminUsersPage` row-stacking or the
  `TenderListPage`/`DetailPage` table behavior — these are pure Tailwind class
  changes with no new conditional logic, and jsdom doesn't perform real CSS layout
  (a wrapped-vs-not-wrapped assertion would be meaningless in jsdom). Verified
  instead via live Playwright checks at phone width (375px) and desktop width
  after implementation, per the project's e2e-verification rule.

## Out of scope

- Converting data tables to stacked cards on mobile (brainstormed and explicitly
  rejected in favor of keeping horizontal scroll).
- A bottom tab bar or icon-only collapsed sidebar (brainstormed alternatives, not
  chosen).
- Any change to desktop-width rendering — the `md:` and up behavior is
  byte-for-byte the same layout as today.
- Login/Register page's `mt-24` top margin, which is a little generous on short
  mobile viewports but not broken — noted during investigation, not addressed.
