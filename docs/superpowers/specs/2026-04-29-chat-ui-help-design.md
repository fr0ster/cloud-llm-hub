# Chat UI Help Dialog — Design

**Status:** draft
**Date:** 2026-04-29
**Location:** `app/chat/webapp/`

## Purpose

Add a Help button to the chat UI sub-header that opens an in-app dialog explaining the UI in ADHD-friendly chunks. The user should be able to find:

- What the toolbar elements mean
- What RAG OP cards mean and how the new DL/UPLOAD flow works
- What MCP TOOL CALL cards mean and what to check when a tool fails
- Where to find tutorials

…without leaving the chat session and without facing a wall of text.

## Non-goals

- Online/external help portal. Help content is bundled with the UI.
- Localization. UI strings stay English (project rule).
- Screenshots or animated GIFs in v1. Text-only is enough; we can add visuals later if a section proves unclear.

## Constraints

- All UI text in English.
- ADHD-friendly content rules apply (see `feedback_tutorial_style.md`):
  - TL;DR first per tab
  - Short bullets, bold imperatives, ≤12 words
  - One concept per chunk; one tab visible at a time

## UX

A `HELP` button is added to the first `.system-bar` in `index.html`, after `STATUS`. Pressing it opens a centered in-page modal implemented with plain HTML/CSS/JS (matching the existing RAG modal pattern). The modal contains four tabs. Default tab on open: `Chat`. The modal has one `CLOSE` button. Esc closes it.

This feature targets the currently served terminal-style static UI (`app/chat/webapp/index.html`). Do not implement this v1 as a UI5 `Help.fragment.xml`; the UI5 `Chat.view.xml` shell is not the active chat entrypoint for the deployed static route.

## Tab content (final, copy-ready English)

### 💬 Chat
> Type a question, press Enter or **Send**.
- **Send** or **Enter** — submit your message.
- **CLR** — wipe the current session.
- **LOG** — export this session.
- **SAP** — override destination credentials.
- **STATUS** — ready, streaming, or error.
- **LLM** — the model currently selected.

### 📚 RAG
> The agent searches your collections.
- **RAG OP card** — the agent read or wrote a record.
- **rag_add** — new record stored.
- **rag_correct** — existing record updated.
- **DL** — download a record to a file.
- **MANAGE** — full collection editor.
- **Backup before a break** — see **Tutorials → Book Catalog**.

### 🔌 MCP
> The agent uses SAP tools.
- **Tool Calls card** — MCP tools used by the agent.
- **DEST** — selected SAP destination.
- **SAP override** — runs as that SAP user.
- Tool failed? Check **DEST** and credentials.

### 📘 Tutorials
> Step-by-step guides. Open in a new tab.
- **RAP BO Book Catalog** — AI-assisted, 4 phases.
- **RAP BO Creation** — manual, 14 steps.
- **Skill files** — upload to RAG before starting.

Tutorial links point to static HTML files generated at build time from `docs/tutorials/*.md`. A new npm script `build:tutorials` runs `marked` (devDependency added to the root `package.json`) over each tutorial Markdown file and writes the result to `app/chat/webapp/tutorials/<name>.html`. The Help dialog links to `tutorials/<name>.html` (relative to `/chat/webapp/`).

The script is wired into the existing `build` script chain so `cds build` (and CI) regenerates the HTML automatically. Generated HTML is added to `.gitignore` under `app/chat/webapp/tutorials/`. Each link opens in a new tab (`target="_blank" rel="noopener noreferrer"`).

Why generate HTML at build time rather than render Markdown at runtime: zero new runtime dependencies, static and cacheable, works fully inside BTP with no external network round-trip, and the chat server keeps no Markdown rendering responsibility.

## Components

```
package.json                          — add `marked` devDep + `build:tutorials` script + chain into `build`
tools/build-tutorials.mjs             — new: marked-based MD → HTML converter (small, ~30 lines)
app/chat/webapp/
├── index.html                       — add HELP button, modal markup, CSS, JS handlers
└── tutorials/                       — build artifact (gitignored), populated by build:tutorials
.gitignore                            — add `app/chat/webapp/tutorials/`
```

The modal is static markup near the existing RAG modal. Tabs are plain buttons with `data-help-tab`. Content panels are plain `<section>` elements. No backend calls are needed.

The MD → HTML script:
- enumerates `docs/tutorials/*.md` (skips `skills/` subdirectory and `TUTORIAL_DESIGN_PRINCIPLES.md`)
- wraps each rendered body in a minimal HTML shell with a `<title>` and a small reset stylesheet
- writes `app/chat/webapp/tutorials/<name>.html`
- exits non-zero on any error so `cds build` fails loud

## State

- `help-modal` DOM node — hidden/shown by `openHelp()` / `closeHelp()`.
- `activeHelpTab` — local JS variable or DOM state (`aria-selected`) for selected tab.
- No server state; no model state.

## Accessibility

- The `HELP` button has `title="Help"` and `aria-haspopup="dialog"`.
- The modal has `role="dialog"`, `aria-modal="true"`, and an accessible title.
- Tab buttons use `role="tab"` and `aria-selected`.
- Panels use `role="tabpanel"`.
- Focus moves into the modal on open; Esc returns it to the trigger.

## Testing

- **Manual smoke** — click `HELP`, switch each tab, click tutorial links, press Esc.
- **No automated UI tests** for this v1; the rest of the chat app is also manual-tested.
- **Static check** via repo-root `npm run lint:check` if it covers `index.html`; otherwise validate in browser.

## Out of scope (possible later)

- Inline screenshots or short GIFs.
- "Tip of the day" rotating banner.
- Per-tab anchor URLs (`#help/rag`) for bookmarking.
- I18n / Ukrainian translation.

## Open items (none — resolved during brainstorming)

- 4 tabs (Chat / RAG / MCP / Tutorials) — Hotkeys dropped because the terminal input has only Enter submit.
- Plain HTML tabs over expandable panels — one chunk visible at a time matches the ADHD-friendly rule.
- In-app dialog over external help page — preserves chat context.
- Tutorial linking — build-time `marked` MD→HTML into `app/chat/webapp/tutorials/`. No runtime Markdown rendering, no GitHub round-trip, no approuter route changes.
