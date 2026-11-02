import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type ISkill, SkillError } from '@mcp-abap-adt/llm-agent';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';

const metadata = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    kind: z
      .enum(['base', 'informational', 'correction'])
      .default('informational'),
  })
  .passthrough();

/** Load one directory without the library's display-name deduplication. */
export function loadSkillFromDir(dir: string): ISkill | undefined {
  try {
    const raw = readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(raw);
    const parsed = metadata.parse(
      front?.[1].trim() ? (load(front[1], { schema: JSON_SCHEMA }) ?? {}) : {},
    );
    const body = (front ? raw.slice(front[0].length) : raw).trim();
    const meta = {
      ...parsed,
      name: parsed.name ?? path.basename(dir),
      description: parsed.description ?? body.split('\n')[0].slice(0, 120),
    };
    return {
      name: meta.name,
      description: meta.description,
      meta,
      async getContent(args) {
        return {
          ok: true,
          value: body
            .replaceAll('$ARGUMENTS', args ?? '')
            .replaceAll('$CLAUDE_SKILL_DIR', dir),
        };
      },
      async listResources() {
        try {
          const entries = await readdir(dir, {
            recursive: true,
            withFileTypes: true,
          });
          return {
            ok: true,
            value: entries
              .filter((entry) => entry.isFile() && entry.name !== 'SKILL.md')
              .map((entry) => ({
                path: path.relative(
                  dir,
                  path.join(entry.parentPath, entry.name),
                ),
              })),
          };
        } catch (error) {
          return { ok: false, error: new SkillError(String(error)) };
        }
      },
      async readResource(file) {
        try {
          return {
            ok: true,
            value: await readFile(path.join(dir, file), 'utf8'),
          };
        } catch (error) {
          return { ok: false, error: new SkillError(String(error)) };
        }
      },
    };
  } catch {
    // Match the source manager's normal skip behavior for unreadable skills.
    return undefined;
  }
}
