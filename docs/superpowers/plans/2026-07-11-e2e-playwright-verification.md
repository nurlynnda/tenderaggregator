# Live E2E Verification with Playwright MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved design (`docs/superpowers/specs/2026-07-11-e2e-playwright-verification-design.md`) into an enforced workflow: a project skill that describes how to live-verify browser-visible features with the Playwright MCP tools, and a CLAUDE.md pointer to it.

**Architecture:** This is a documentation-only change — no application code, no tests, no new dependencies. Two artifacts: a new project skill file (`.claude/skills/e2e-playwright-verification/SKILL.md`) that the harness auto-discovers and can trigger during feature work, and a short new section in `CLAUDE.md` pointing to it.

**Tech Stack:** Markdown (skill file + CLAUDE.md). No code.

## Global Constraints

- Explain everything in plain, layman's terms — no unexplained jargon (per `CLAUDE.md`'s Communication style rule; applies to the skill's own wording too, since it will be read by future Claude instances and by the user).
- No persisted Playwright test suite, no `e2e/` workspace, no `npm run test:e2e` script, no fixture data — explicitly out of scope per the spec.
- No pre-commit or CI integration — this is a manual step run when finishing a feature.
- Skill must trigger only for features with browser-visible behavior, not backend-only changes (per spec Scope section).
- Must warn against triggering real scrapes against live government sites during verification (per spec Safety note).
- Must specify `npm run dev -w backend` / `npm run dev -w frontend` as the servers to use, and explicitly say why not `docker compose` (per spec's "Why npm run dev, not docker compose" section) — this repo already has both `CLAUDE.md`'s Commands section and the spec documenting this reasoning; the skill should carry the operative rule, not repeat the full justification.

---

### Task 1: Create the `e2e-playwright-verification` project skill

**Files:**
- Create: `.claude/skills/e2e-playwright-verification/SKILL.md`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a skill file discoverable by the harness's Skill tool, named `e2e-playwright-verification`. Task 2's CLAUDE.md pointer references this exact path and name.

This task has no code to test in the traditional TDD sense (it's a skill definition, not application logic). "Testing" here means checking the written file against the spec's requirements checklist before moving on — done as the verification step below.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/e2e-playwright-verification/SKILL.md` with this exact content:

```markdown
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
```

- [ ] **Step 2: Verify the file against the spec's requirements checklist**

Read the file back and confirm each of these is present (this is the
"testing" step for a docs-only task — there's no automated check to run):

- [ ] Frontmatter has `name: e2e-playwright-verification` and a `description`
      that mentions "browser-visible" behavior and "before reporting the work
      complete" (so the harness's skill-matching has a clear trigger signal)
- [ ] "When to Use" section lists browser-visible triggers and explicitly
      calls out skipping backend-only changes
- [ ] Workflow step 2 says `npm run dev -w backend` / `npm run dev -w
      frontend` and explains why not `docker compose`
- [ ] Workflow mentions `mcp__playwright__*` tools by name, not the Browser
      pane tools
- [ ] Safety Note about not triggering real scrapes is present
- [ ] "Explicitly Not Doing" section rules out a persisted suite, `e2e/`
      workspace, and CI/pre-commit integration

If any item is missing, fix the file and re-check.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/e2e-playwright-verification/SKILL.md
git commit -m "feat: add e2e-playwright-verification project skill"
```

---

### Task 2: Point CLAUDE.md at the new skill

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the skill name and path produced by Task 1
  (`.claude/skills/e2e-playwright-verification/SKILL.md`, skill name
  `e2e-playwright-verification`)
- Produces: nothing consumed by later tasks (last task)

- [ ] **Step 1: Add the new section to CLAUDE.md**

Open `CLAUDE.md` and locate the end of the `## TDD — non-negotiable` section
(it currently ends with the numbered list item about "Tests must NEVER hit
the real myprocurement.treasury.gov.my..."). Immediately after that section
(before `## Key design rules`), insert:

```markdown
## E2E verification

After implementing any feature with browser-visible behavior, verify it live
using the Playwright MCP tools before reporting the work complete — see
`.claude/skills/e2e-playwright-verification/SKILL.md`.
```

- [ ] **Step 2: Verify the edit**

Read `CLAUDE.md` back and confirm:
- [ ] The new `## E2E verification` heading appears between `## TDD —
      non-negotiable` and `## Key design rules`
- [ ] It references the exact path `.claude/skills/e2e-playwright-verification/SKILL.md`
- [ ] No other existing content in `CLAUDE.md` was altered (diff should be a
      pure addition)

Run: `git diff CLAUDE.md`
Expected: only added lines (all prefixed with `+`), no removed lines.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: point CLAUDE.md at the e2e-playwright-verification skill"
```
