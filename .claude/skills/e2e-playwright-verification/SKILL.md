---
name: e2e-playwright-verification
description: Use when finishing a feature that changes what a user sees or does in the browser (new page, filter, button, form, etc.) - before reporting the work complete, verify it live in a real browser using the Playwright MCP tools.
---

# Live E2E Verification with Playwright MCP

## Overview

Unit tests (vitest) check functions and components in isolation. They don't
catch bugs that only show up when the frontend and backend are wired together
and running for real — a wrong API path, a filter that doesn't reach the query
params, a button that doesn't fire. This skill closes that gap with a live,
manual-style check using the Playwright MCP browser tools
(`mcp__playwright__*`) — not the Browser pane tools, and not a persisted test
suite. Nothing gets written to disk or committed as part of this workflow.

See `docs/superpowers/specs/2026-07-11-e2e-playwright-verification-design.md`
for the full design rationale.

## When to Use

**Use after implementing:**
- A new page or route
- A new filter, button, form, or other interactive UI element
- Any change to what a user sees or does in the browser

**Skip for:**
- Backend-only changes with no UI surface (e.g. a scraper adapter tweak, an
  internal refactor with no observable behavior change)

If unsure whether a change is browser-visible, use this skill — the cost of
an extra check is low.

## Workflow

1. Get the feature's vitest suite green first (per the TDD rule in
   `CLAUDE.md`). This skill is a live sanity check on top of passing unit
   tests, not a replacement for them.
2. Start the dev servers if they aren't already running:
   - `npm run dev -w backend` (port 3001)
   - `npm run dev -w frontend` (port 5173, proxies `/api` to :3001)

   Use `npm run dev`, not `docker compose up --build` — the compose setup
   runs a production-style build (backend installed with `--omit=dev`,
   frontend served as a static `vite build` via nginx) with no hot-reload.
   Rebuilding after every fix would make the verify-fix-reverify loop slow.
   `npm run dev` gives instant hot-reload (Vite HMR, `tsx watch`).
3. Use the Playwright MCP tools to drive the running app through the
   feature's happy path and at least one edge case:
   - `browser_navigate` to load the relevant page
   - `browser_snapshot`, `browser_click`, `browser_type`,
     `browser_select_option`, etc. to interact with it
   - `browser_console_messages` / `browser_network_request` to check for
     errors if something looks off
4. If a problem surfaces, use the same tools to debug (inspect network
   requests, console errors, DOM state), fix the code, and re-verify.
5. Report what was checked and observed as part of declaring the feature
   complete.

## Safety Note

This runs against the normal dev environment, which has real data from the
actual scrapers (or whatever local data exists). Avoid clicking anything that
triggers a real scrape against the live government sites (e.g. a "rescrape"
button) unless that is literally the feature being verified — same spirit as
the existing rule that automated tests must never hit the real
`myprocurement.treasury.gov.my` (see `CLAUDE.md`).

## Explicitly Not Doing

- No persisted Playwright test suite (`@playwright/test`), no `e2e/`
  workspace, no `npm run test:e2e` script, no fixture data directory.
- No pre-commit or CI integration — this is a manual step, not an automated
  gate.
