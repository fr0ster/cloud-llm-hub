import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `cds watch` runs srv/ under tsx's CommonJS hook only (tsx/cjs, because
 * package.json has no "type": "module"). That hook compiles static imports to
 * require(), but leaves a runtime `import('./x')` to Node's ESM resolver, which
 * does not probe extensions: `./x` is not found, and `./x.ts` is loaded by
 * Node's own type stripping, whose extension-less imports then fail. The
 * production build (tsc, module commonjs) turns the same call into require(),
 * so it only breaks in local dev. Local modules are imported statically.
 */
const RUNTIME_RELATIVE_IMPORT =
  /\bimport\(\s*['"`]\.{1,2}\/[^'"`]*['"`]\s*\)(?!\s*\.[A-Z])/g;

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

it('srv/ has no runtime dynamic import of a relative path', () => {
  const root = path.resolve(__dirname, '../../srv');
  const offenders = tsFiles(root).flatMap((file) => {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(RUNTIME_RELATIVE_IMPORT)]
      .filter((m) => !/typeof\s+$/.test(src.slice(0, m.index)))
      .map((m) => `${path.relative(root, file)}: ${m[0]}`);
  });
  expect(tsFiles(root).length).toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});
