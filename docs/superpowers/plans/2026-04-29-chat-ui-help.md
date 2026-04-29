# Chat UI Help Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `HELP` button to the chat UI top toolbar that opens an in-page modal with four tabbed sections (Chat / RAG / MCP / Tutorials), explaining the UI in ADHD-friendly chunks. Tutorials are pre-rendered to HTML at build time from `docs/tutorials/*.md` and linked from the modal.

**Architecture:** Single-file UI change in `app/chat/webapp/index.html` — modal markup + inline styles + vanilla JS handlers, modeled after the existing RAG modal. Build-time `marked`-based MD→HTML conversion via a new `tools/build-tutorials.mjs` script wired into `npm run build` through a `prebuild` hook. Generated HTML lives under `app/chat/webapp/tutorials/` and is gitignored.

**Tech Stack:** Vanilla HTML/CSS/JS in `index.html`; Node.js ESM script using `marked` (devDependency).

**Reference spec:** `docs/superpowers/specs/2026-04-29-chat-ui-help-design.md`

---

## File Structure

```
package.json                          — add `marked` devDep + `build:tutorials` + `prebuild`
tools/build-tutorials.mjs             — new: enumerate docs/tutorials/*.md → HTML
.gitignore                            — add `app/chat/webapp/tutorials/`
app/chat/webapp/
├── index.html                       — add HELP button, modal markup, CSS, JS handlers
└── tutorials/                       — generated artifact (gitignored)
```

Each unit has one job:
- `tools/build-tutorials.mjs` — read MD, render via marked, write HTML. No flags, no config.
- `index.html` modal — display content, switch tabs, close on Esc. No fetches, no state beyond active tab.

---

## Task 1: Add `marked` dependency + tutorial build script wiring

**Files:**
- Modify: `package.json`

- [ ] **Step 1.1: Install `marked` as devDependency**

```bash
npm install --save-dev marked@^14
```

Expected: `package.json` and `package-lock.json` updated; `marked` appears in `devDependencies`.

- [ ] **Step 1.2: Add `build:tutorials` and `prebuild` scripts**

Edit `package.json` `scripts` section. Locate the `"build": "npx cds b"` line and add two new scripts directly above it:

```json
    "build:tutorials": "node tools/build-tutorials.mjs",
    "prebuild": "npm run build:tutorials",
```

Final shape of the relevant lines:

```json
    "build:tutorials": "node tools/build-tutorials.mjs",
    "prebuild": "npm run build:tutorials",
    "build": "npx cds b",
```

`prebuild` is a built-in npm lifecycle hook that runs before `build`. Both `npm run build` and `cds build`-via-MTA pick this up.

- [ ] **Step 1.3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add marked devDep and tutorial build:tutorials script"
```

---

## Task 2: Implement `tools/build-tutorials.mjs`

**Files:**
- Create: `tools/build-tutorials.mjs`

- [ ] **Step 2.1: Create the script**

```javascript
#!/usr/bin/env node
// Build-time tutorial converter: docs/tutorials/*.md -> app/chat/webapp/tutorials/*.html.
// Skips docs/tutorials/skills/ and docs/tutorials/TUTORIAL_DESIGN_PRINCIPLES.md.
// Exits non-zero on any error so cds build fails loudly.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'docs', 'tutorials');
const OUT_DIR = join(ROOT, 'app', 'chat', 'webapp', 'tutorials');
const SKIP = new Set(['TUTORIAL_DESIGN_PRINCIPLES.md']);

const SHELL = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.55; }
  h1, h2, h3, h4 { line-height: 1.2; margin-top: 1.4em; }
  code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.92em; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding: 4px 12px; color: #555; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; }
  a { color: #0a66c2; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  let count = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (extname(e.name) !== '.md') continue;
    if (SKIP.has(e.name)) continue;
    const srcPath = join(SRC_DIR, e.name);
    const md = await readFile(srcPath, 'utf-8');
    const titleMatch = /^#\s+(.+)$/m.exec(md);
    const title = titleMatch ? titleMatch[1].trim() : basename(e.name, '.md');
    const body = marked.parse(md);
    const outName = basename(e.name, '.md') + '.html';
    await writeFile(join(OUT_DIR, outName), SHELL(title, body), 'utf-8');
    count++;
  }
  console.log(`build-tutorials: wrote ${count} HTML file(s) to ${OUT_DIR}`);
}

main().catch(err => {
  console.error('build-tutorials failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2.2: Run the script**

```bash
node tools/build-tutorials.mjs
```

Expected output: `build-tutorials: wrote 2 HTML file(s) to .../app/chat/webapp/tutorials`
(Two files because `rap-bo-creation.md` and `rap-bo-book-catalog.md` are converted; `TUTORIAL_DESIGN_PRINCIPLES.md` is skipped; the `skills/` subdirectory is skipped because `readdir` returns it as a directory entry, not a `.md` file.)

- [ ] **Step 2.3: Verify output**

```bash
ls app/chat/webapp/tutorials/
```

Expected: `rap-bo-book-catalog.html`, `rap-bo-creation.html`. Open one in a browser and confirm headings, lists, and code blocks render.

- [ ] **Step 2.4: Verify build chain runs the prebuild hook**

```bash
rm -rf app/chat/webapp/tutorials/ && npm run build 2>&1 | grep -E "build-tutorials|cds"
```

Expected: line containing `build-tutorials: wrote 2 HTML file(s)` appears before any `cds`-related line; `app/chat/webapp/tutorials/` is repopulated.

- [ ] **Step 2.5: Commit**

```bash
git add tools/build-tutorials.mjs
git commit -m "feat(tools): build-tutorials.mjs — MD→HTML for chat UI Help"
```

---

## Task 3: Gitignore the generated tutorials directory

**Files:**
- Modify: `.gitignore`

- [ ] **Step 3.1: Append the rule**

Add this line to the end of `.gitignore`:

```
app/chat/webapp/tutorials/
```

- [ ] **Step 3.2: Verify the path is ignored**

```bash
git check-ignore -v app/chat/webapp/tutorials/rap-bo-creation.html
```

Expected: line of the form `.gitignore:N:app/chat/webapp/tutorials/   app/chat/webapp/tutorials/rap-bo-creation.html`.

- [ ] **Step 3.3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore generated app/chat/webapp/tutorials/"
```

---

## Task 4: Add `HELP` button to the top system-bar

**Files:**
- Modify: `app/chat/webapp/index.html` (around line 81, the first `.system-bar`)

- [ ] **Step 4.1: Add the button after the STATUS span**

Locate this block in `index.html`:

```html
        <div class="system-bar">
            <span>LLM: <select id="llm-model-select" disabled><option value="">...</option></select></span>
            <span>MODE: <span id="agent-mode">...</span></span>
            <span>DEST: <select id="dest-select" disabled><option value="">...</option></select><button id="dest-refresh" title="Refresh destinations" style="margin-left:4px;padding:1px 6px;font-size:12px;cursor:pointer" disabled>&#x21bb;</button></span>
            <span>STATUS: <span id="status-text" class="status-connecting">CONNECTING...</span></span>
        </div>
```

Replace it with (one line added — the `HELP` `<span>` immediately after the STATUS span):

```html
        <div class="system-bar">
            <span>LLM: <select id="llm-model-select" disabled><option value="">...</option></select></span>
            <span>MODE: <span id="agent-mode">...</span></span>
            <span>DEST: <select id="dest-select" disabled><option value="">...</option></select><button id="dest-refresh" title="Refresh destinations" style="margin-left:4px;padding:1px 6px;font-size:12px;cursor:pointer" disabled>&#x21bb;</button></span>
            <span>STATUS: <span id="status-text" class="status-connecting">CONNECTING...</span></span>
            <span><button id="help-btn" type="button" onclick="openHelp()" title="Help" aria-haspopup="dialog" style="padding:1px 8px;font-size:11px;cursor:pointer;background:#1a1a1a;color:#00ff00;border:1px solid #333;border-radius:3px;font-family:'Courier New',monospace">HELP</button></span>
        </div>
```

- [ ] **Step 4.2: Reload UI and verify the button appears**

Run the app locally if available; otherwise open `index.html` directly in a browser to verify visual placement (HELP button visible after STATUS, same styling as the MANAGE button on the second row).

- [ ] **Step 4.3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): HELP button in top system-bar"
```

---

## Task 5: Add the Help modal markup

**Files:**
- Modify: `app/chat/webapp/index.html` (insert directly after the closing `</div>` of `#rag-modal`, before the `<form id="sap-creds-dialog">` block)

- [ ] **Step 5.1: Insert the modal block**

Locate the closing `</div>` that ends the RAG modal (around line 166, just before `<form id="sap-creds-dialog"...>`). Immediately after that `</div>`, insert:

```html
        <!-- Help Modal -->
        <div id="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-modal-title" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:1000;overflow:auto">
          <div style="max-width:760px;margin:30px auto;background:#111;border:1px solid #333;border-radius:6px;padding:20px;color:#e0e0e0;font-size:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
              <span id="help-modal-title" style="color:#00ff00;font-size:18px;font-weight:bold">Help</span>
              <button onclick="closeHelp()" style="background:none;border:1px solid #555;color:#ff5555;cursor:pointer;padding:4px 12px;font-family:'Courier New',monospace;border-radius:3px">CLOSE</button>
            </div>

            <!-- Tab strip -->
            <div role="tablist" aria-label="Help sections" style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
              <button class="help-tab" data-help-tab="chat"      role="tab" aria-selected="true"  onclick="switchHelpTab('chat')"      style="background:#1a1a1a;color:#00ff00;border:1px solid #00ff00;padding:6px 14px;cursor:pointer;font-family:'Courier New',monospace;font-size:13px;border-radius:3px">💬 Chat</button>
              <button class="help-tab" data-help-tab="rag"       role="tab" aria-selected="false" onclick="switchHelpTab('rag')"       style="background:#1a1a1a;color:#888;   border:1px solid #333;   padding:6px 14px;cursor:pointer;font-family:'Courier New',monospace;font-size:13px;border-radius:3px">📚 RAG</button>
              <button class="help-tab" data-help-tab="mcp"       role="tab" aria-selected="false" onclick="switchHelpTab('mcp')"       style="background:#1a1a1a;color:#888;   border:1px solid #333;   padding:6px 14px;cursor:pointer;font-family:'Courier New',monospace;font-size:13px;border-radius:3px">🔌 MCP</button>
              <button class="help-tab" data-help-tab="tutorials" role="tab" aria-selected="false" onclick="switchHelpTab('tutorials')" style="background:#1a1a1a;color:#888;   border:1px solid #333;   padding:6px 14px;cursor:pointer;font-family:'Courier New',monospace;font-size:13px;border-radius:3px">📘 Tutorials</button>
            </div>

            <!-- Tab panels -->
            <section data-help-panel="chat" role="tabpanel">
              <p style="color:#ffcc00;font-style:italic;margin:0 0 10px 0">Type a question, press Enter or Send.</p>
              <ul style="margin:0;padding-left:20px;line-height:1.7">
                <li><b>Send</b> or <b>Enter</b> &mdash; submit your message.</li>
                <li><b>CLR</b> &mdash; wipe the current session.</li>
                <li><b>LOG</b> &mdash; export this session.</li>
                <li><b>SAP</b> &mdash; override destination credentials.</li>
                <li><b>STATUS</b> &mdash; ready, streaming, or error.</li>
                <li><b>LLM</b> &mdash; the model currently selected.</li>
              </ul>
            </section>

            <section data-help-panel="rag" role="tabpanel" style="display:none">
              <p style="color:#ffcc00;font-style:italic;margin:0 0 10px 0">The agent searches your collections.</p>
              <ul style="margin:0;padding-left:20px;line-height:1.7">
                <li><b>RAG OP card</b> &mdash; the agent read or wrote a record.</li>
                <li><b>rag_add</b> &mdash; new record stored.</li>
                <li><b>rag_correct</b> &mdash; existing record updated.</li>
                <li><b>DL</b> &mdash; download a record to a file.</li>
                <li><b>MANAGE</b> &mdash; full collection editor.</li>
                <li><b>Backup before a break</b> &mdash; see <b>Tutorials &rarr; Book Catalog</b>.</li>
              </ul>
            </section>

            <section data-help-panel="mcp" role="tabpanel" style="display:none">
              <p style="color:#ffcc00;font-style:italic;margin:0 0 10px 0">The agent uses SAP tools.</p>
              <ul style="margin:0;padding-left:20px;line-height:1.7">
                <li><b>Tool Calls card</b> &mdash; MCP tools used by the agent.</li>
                <li><b>DEST</b> &mdash; selected SAP destination.</li>
                <li><b>SAP override</b> &mdash; runs as that SAP user.</li>
                <li>Tool failed? Check <b>DEST</b> and credentials.</li>
              </ul>
            </section>

            <section data-help-panel="tutorials" role="tabpanel" style="display:none">
              <p style="color:#ffcc00;font-style:italic;margin:0 0 10px 0">Step-by-step guides. Open in a new tab.</p>
              <ul style="margin:0;padding-left:20px;line-height:1.7">
                <li><a href="tutorials/rap-bo-book-catalog.html" target="_blank" rel="noopener noreferrer" style="color:#00bfff"><b>RAP BO Book Catalog</b></a> &mdash; AI-assisted, 4 phases.</li>
                <li><a href="tutorials/rap-bo-creation.html"     target="_blank" rel="noopener noreferrer" style="color:#00bfff"><b>RAP BO Creation</b></a> &mdash; manual, 14 steps.</li>
                <li><b>Skill files</b> &mdash; upload to RAG before starting.</li>
              </ul>
            </section>

          </div>
        </div>
```

- [ ] **Step 5.2: Reload UI and verify markup parses**

Open the page in a browser. Confirm no console errors related to the new markup. The modal should remain hidden (default `display:none`).

- [ ] **Step 5.3: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): Help modal markup with 4 tabs"
```

---

## Task 6: Add Help modal JS handlers

**Files:**
- Modify: `app/chat/webapp/index.html` (inside the existing `<script>` block; place near the RAG `openRagPanel`/`closeRagPanel` definitions)

- [ ] **Step 6.1: Locate the existing RAG handlers**

Find the line containing `document.getElementById('rag-modal').style.display = 'block';` (around line 1270). Immediately after the function that contains it (`closeRagPanel` ends a few lines later), add the three Help handlers below.

- [ ] **Step 6.2: Insert the handlers**

Insert this block:

```javascript
        // Help modal — open/close + tab switching + Esc-to-close.
        let _previouslyFocused = null;

        function openHelp() {
            _previouslyFocused = document.activeElement;
            document.getElementById('help-modal').style.display = 'block';
            switchHelpTab('chat');
            // Move focus inside the dialog for accessibility.
            const firstTab = document.querySelector('.help-tab[data-help-tab="chat"]');
            if (firstTab) firstTab.focus();
        }

        function closeHelp() {
            document.getElementById('help-modal').style.display = 'none';
            if (_previouslyFocused && typeof _previouslyFocused.focus === 'function') {
                _previouslyFocused.focus();
                _previouslyFocused = null;
            }
        }

        function switchHelpTab(name) {
            document.querySelectorAll('.help-tab').forEach(btn => {
                const active = btn.dataset.helpTab === name;
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
                btn.style.color = active ? '#00ff00' : '#888';
                btn.style.borderColor = active ? '#00ff00' : '#333';
            });
            document.querySelectorAll('[data-help-panel]').forEach(panel => {
                panel.style.display = panel.dataset.helpPanel === name ? '' : 'none';
            });
        }

        // Esc closes the Help modal when it's open. Registered once at script load.
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const modal = document.getElementById('help-modal');
            if (modal && modal.style.display === 'block') {
                e.preventDefault();
                closeHelp();
            }
        });
```

- [ ] **Step 6.3: Verify lint and types pass**

```bash
npm run lint:check && npm run test:check
```

Expected: both succeed (Biome scope is `srv tools test`, so `app/chat/webapp/index.html` is not lint-checked, but no syntax breakage from changes elsewhere).

- [ ] **Step 6.4: Manual smoke test**

In a browser tab pointed at the running app (or `index.html` opened directly):

1. Click `HELP` in the top system-bar → modal opens, `Chat` tab visible.
2. Click each of the four tabs → only that tab's content shows; tab button highlights green.
3. Press `Esc` → modal closes; focus returns to the `HELP` button.
4. Click `CLOSE` → modal closes.
5. Click `RAP BO Book Catalog` link → opens `tutorials/rap-bo-book-catalog.html` in a new tab and renders.
6. Click `RAP BO Creation` link → opens the other tutorial HTML in a new tab.

- [ ] **Step 6.5: Commit**

```bash
git add app/chat/webapp/index.html
git commit -m "feat(chat-ui): Help modal handlers (open/close, tab switch, Esc)"
```

---

## Task 7: Final verification + cleanup

- [ ] **Step 7.1: Clean rebuild from scratch**

```bash
rm -rf app/chat/webapp/tutorials/ gen/
npm run build
```

Expected: `build-tutorials` runs first (output: `wrote 2 HTML file(s)`), then `cds b` succeeds, `gen/` populated, `app/chat/webapp/tutorials/` repopulated.

- [ ] **Step 7.2: Confirm the example tutorial section in `rap-bo-book-catalog.html` shows the new backup section**

```bash
grep -c "Backup RAG before you stop" app/chat/webapp/tutorials/rap-bo-book-catalog.html
```

Expected: `1` (or higher).

- [ ] **Step 7.3: Delete plan + spec after merge**

Per CLAUDE.md "Plans and Specs": once this branch is merged to `main`, delete:

```bash
git rm docs/superpowers/specs/2026-04-29-chat-ui-help-design.md docs/superpowers/plans/2026-04-29-chat-ui-help.md
git commit -m "chore: drop completed chat-ui-help plan and spec"
```

---

## Self-review notes

- **Spec coverage:** Help button placement, IconTabBar→plain HTML tabs, 4 tab contents (Chat/RAG/MCP/Tutorials with the user-edited final wording), accessibility attributes, Esc handling, build-time MD→HTML, .gitignore — all mapped to tasks.
- **Type consistency:** function names `openHelp`, `closeHelp`, `switchHelpTab` are used consistently across markup `onclick=` and the JS block.
- **Build order:** `prebuild` is the standard npm hook and runs before both `npm run build` and any `cds`-driven build that delegates back to npm.
- **No placeholders:** every code block is complete and ready to paste.
- **Caveat:** if `rap-bo-book-catalog.md` or `rap-bo-creation.md` is ever renamed, both the build script (it picks them up automatically) and the Help tab links (hard-coded names) must be updated. The link names mirror the source filenames intentionally — this is the simplest contract.
