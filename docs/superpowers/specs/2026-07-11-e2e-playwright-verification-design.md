# Live E2E verification with Playwright MCP

## Problem

`npm test` (vitest) checks that individual functions and components behave correctly
in isolation, but nothing currently exercises a feature end-to-end through a real
browser against the real running app. Bugs that only show up when the frontend and
backend are wired together — a wrong API path, a filter that doesn't reach the query
params, a button that doesn't fire — can slip through unit tests and only get caught
by the user manually.

## Goal

After implementing any feature with browser-visible behavior, drive the actual
running app through a real browser using the Playwright MCP tools
(`mcp__playwright__*`) to confirm the feature works, before reporting the work as
complete. This is a live verification/debugging step, not an automated regression
suite — no test files are written or committed as part of this workflow.

## Scope

**In scope:** any feature with browser-visible behavior — a new page, filter, button,
form, or any change to what a user sees or does in the UI.

**Out of scope:** backend-only changes with no UI surface (e.g. a scraper adapter
change, an internal refactor). These stay covered by vitest alone.

## Workflow

1. Implement the feature and get its vitest suite green (per the existing TDD rule
   in `CLAUDE.md`).
2. Start the dev servers if not already running:
   - `npm run dev -w backend` (port 3001)
   - `npm run dev -w frontend` (port 5173, proxies `/api` to :3001)
3. Use the Playwright MCP tools to drive the running app through the feature's
   happy path and at least one edge case:
   - `browser_navigate` to load the relevant page
   - `browser_snapshot` / `browser_click` / `browser_type` / `browser_select_option`
     etc. to interact with it
   - `browser_console_messages` / `browser_network_request` to check for errors if
     something looks off
4. If a problem surfaces, use the same tools to debug (inspect network requests,
   console errors, DOM state), fix the code, and re-verify.
5. Report what was checked and observed as part of declaring the feature complete.

## Why `npm run dev`, not `docker compose`

`docker compose up --build` runs a production-style build (backend installed with
`--omit=dev` and run from compiled output; frontend is a static `vite build` served
via nginx) — no hot-reload. Rebuilding after every fix would make the
verify → find bug → fix → re-verify loop slow. `npm run dev` gives instant hot-reload
(Vite HMR, `tsx watch`), keeping the loop fast. Docker compose remains available as a
separate, coarser pre-ship sanity check, but is out of scope for this workflow.

## Safety note

This runs against the normal dev environment, which has real data from the actual
scrapers (or whatever local data exists). Avoid clicking anything that triggers a
real scrape against the live government sites (e.g. a "rescrape" button) unless that
is literally the feature being verified — same spirit as the existing rule that
automated tests must never hit the real `myprocurement.treasury.gov.my` (see
`CLAUDE.md`).

## Enforcement

- **New project skill**: `.claude/skills/e2e-playwright-verification/SKILL.md` —
  triggers when wrapping up a feature with browser-visible behavior. Encodes this
  workflow, the scope rule, and the safety note above.
- **CLAUDE.md**: short pointer under a new "E2E verification" heading, referencing
  the skill.

## Explicitly not doing

- No persisted Playwright test suite (`@playwright/test`), no `e2e/` workspace, no
  `npm run test:e2e` script, no fixture data directory. This was considered and
  rejected in favor of the simpler live-verification-only approach above.
- No pre-commit or CI integration — this is a manual step I run as part of finishing
  a feature, not an automated gate.
