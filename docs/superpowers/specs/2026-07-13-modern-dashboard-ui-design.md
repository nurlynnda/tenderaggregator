# Modern SaaS-style UI redesign — design doc

Date: 2026-07-13

## Goal

Redesign the tender list and dashboard UI to look like a modern, minimal SaaS
product (Linear/Stripe/Vercel-ish), without changing any existing data or
API behavior.

## Scope

`TenderListPage.tsx` is shared across three routes: Open Tenders (`/open`),
Closed Tenders (`/closed`), and Awarded Tenders (`/awarded`, `hasWinners`).

- **Open Tenders route only**: page header ("Open Tenders" + short
  description) and the 4 stat cards (Open Tenders, Closing Today, Closing
  This Week, Awarded — Awarded is a global count across all tenders, not
  just open ones).
- **All three list routes**: filter card styling, redesigned table (sticky
  header, zebra rows, badges, days-left indicator, row action buttons),
  sidebar icons, color/font system.
- Dashboard page (`DashboardPage.tsx`) already has its own card styling
  from a previous change; not part of this redesign except sharing the
  same background/color tokens.

## New components (`frontend/src/components/`)

- `StatCard.tsx` — `{ label, value }` — white rounded card, used 4x on the
  Open Tenders page header row.
- `Badge.tsx` — `{ label, colorKey }` — colored pill. Fixed color map keyed
  by lowercased value (e.g. procurement types, sources); unrecognized
  values fall back to a neutral gray badge. Used for Tender Type, Source,
  Field Code.
- `DaysLeftBadge.tsx` — `{ closingDate: string | null }` — computes days
  remaining from today to `closingDate`:
  - closing date in the past or today → **red**, label "Overdue" / "Today"
  - 1–7 days away → **orange**, label "N days left"
  - 8+ days away → **green**, label "N days left"
  - `closingDate === null` → renders nothing (no badge)
- Sidebar icons: small inline SVGs defined inline in `App.tsx` (no new
  dependency) for Dashboard / Open / Closed / Awarded / Settings.

## Row actions

- **View** — unchanged behavior, same as today's row click → navigate to
  detail page.
- **Save** — local component state only (`useState<Set<string>>` of saved
  dedupKeys), toggles a filled/unfilled bookmark icon. Not persisted
  anywhere; resets on reload. No backend involvement.
- **Share** — copies `${window.location.origin}/tenders/<referenceNo>` to
  the clipboard via `navigator.clipboard.writeText`. Real, harmless,
  client-only action.

Both action buttons use `stopPropagation()` so they don't also trigger the
row's navigate-on-click.

## Visual system

- Page background: `#F8FAFC` (light gray), applied to the `<main>` wrapper
  in `App.tsx`.
- Cards: white, `border border-gray-200`, `rounded-lg`, `shadow-sm`.
- Font: keep Inter (already loaded via Google Fonts in `index.html` and
  set as `--font-sans` in `index.css`) — no new font added.
- Table: sticky `<thead>` (`sticky top-0 bg-gray-100 z-10`), zebra striping
  on `<tbody>` rows (even rows `bg-gray-50/50`), increased cell padding
  (`py-3`), existing hover state kept.
- Filters + search live inside one white rounded card with
  `shadow-sm`, replacing the current borderless flex rows.

## Testing

New components get test-first coverage (`Badge.test.tsx`,
`DaysLeftBadge.test.tsx`, `StatCard.test.tsx`) covering the color/threshold
logic. `TenderListPage.test.tsx` updated for the new markup (badges,
days-left, action buttons, filter card wrapper). `App.test.tsx` updated if
sidebar markup assertions break. No changes to `backend/` or `shared/` —
this is frontend-only, no data or API shape changes.

## Out of scope

- Persisting "Save" server-side (would need a new backend endpoint —
  future work if wanted).
- Actual social/link sharing beyond clipboard copy.
- Mobile nav collapse/hamburger — sidebar stays a fixed-width column but
  gets responsive width adjustments (`w-56` → narrower on small screens
  isn't part of this pass unless testing reveals it's needed; the table's
  `overflow-x-auto` already handles horizontal scroll on narrow viewports).
