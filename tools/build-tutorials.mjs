#!/usr/bin/env node
// Build-time tutorial converter: docs/tutorials/*.md -> app/chat/webapp/tutorials/*.html.
// Skips docs/tutorials/skills/ and docs/tutorials/TUTORIAL_DESIGN_PRINCIPLES.md.
// Exits non-zero on any error so cds build fails loudly.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
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
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
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
    const outName = `${basename(e.name, '.md')}.html`;
    await writeFile(join(OUT_DIR, outName), SHELL(title, body), 'utf-8');
    count++;
  }
  console.log(`build-tutorials: wrote ${count} HTML file(s) to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('build-tutorials failed:', err);
  process.exit(1);
});
