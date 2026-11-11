import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { CLOUD_LOCAL_TOOL_EXPOSITIONS } from '../srv/lib/cloud-local-tools';
import { buildToolExpositionMap } from '../srv/lib/tool-exposition-map';

/** Derive object ownership from installed JavaScript, including called helpers. */
export function deriveToolObjects(): { tools: Record<string, string | null> } {
  const libRoot = dirname(require.resolve('@mcp-abap-adt/lib'));
  const clientPath = join(
    dirname(require.resolve('@mcp-abap-adt/adt-clients')),
    'clients',
    'AdtClient.js',
  );
  const sources = new Map<string, ts.SourceFile>();
  const source = (path: string): ts.SourceFile => {
    let file = sources.get(path);
    if (!file) {
      file = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      sources.set(path, file);
    }
    return file;
  };
  const visit = (node: ts.Node, fn: (node: ts.Node) => void): void => {
    fn(node);
    node.forEachChild((child) => visit(child, fn));
  };
  const imports = (file: ts.SourceFile): Map<string, string> => {
    const out = new Map<string, string>();
    visit(file, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(file) === 'require'
      ) {
        const arg = node.initializer.arguments[0];
        if (arg && ts.isStringLiteral(arg)) out.set(node.name.text, arg.text);
      }
    });
    return out;
  };
  const client = source(clientPath);
  const clientImports = imports(client);
  const getters = new Map<string, string>();
  visit(client, (node) => {
    if (
      !ts.isMethodDeclaration(node) ||
      !node.name.getText(client).startsWith('get') ||
      !node.body
    )
      return;
    const folders = new Set<string>();
    visit(node.body, (child) => {
      if (
        !ts.isNewExpression(child) ||
        !ts.isPropertyAccessExpression(child.expression)
      )
        return;
      const module = clientImports.get(
        child.expression.expression.getText(client),
      );
      const folder = module?.match(/^\.\.\/core\/([^/]+)$/)?.[1];
      if (folder) folders.add(folder);
    });
    if (folders.size === 1)
      for (const folder of folders)
        getters.set(node.name.getText(client), folder);
  });
  const functions = (file: ts.SourceFile): Map<string, ts.Node> => {
    const out = new Map<string, ts.Node>();
    visit(file, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body)
        out.set(node.name.text, node.body);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      )
        out.set(node.name.text, node.initializer.body);
    });
    return out;
  };
  const objectsIn = (
    file: ts.SourceFile,
    body: ts.Node,
    seen: Set<string>,
  ): Set<string> => {
    const found = new Set<string>();
    const local = functions(file);
    const required = imports(file);
    visit(body, (node) => {
      if (!ts.isCallExpression(node)) return;
      let expr: ts.Expression = node.expression;
      if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.CommaToken
      )
        expr = expr.right;
      if (ts.isPropertyAccessExpression(expr)) {
        const folder = getters.get(expr.name.text);
        if (folder) found.add(folder);
      }
      let target = file;
      let name: string | undefined;
      if (ts.isIdentifier(expr)) name = expr.text;
      else if (ts.isPropertyAccessExpression(expr)) {
        const module = required.get(expr.expression.getText(file));
        if (module?.startsWith('.')) {
          let path = resolve(dirname(file.fileName), module);
          if (!path.endsWith('.js')) path += '.js';
          if (existsSync(path)) {
            target = source(path);
            name = expr.name.text;
          }
        }
      }
      if (!name) return;
      const key = `${target.fileName}#${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const helper =
        target === file ? local.get(name) : functions(target).get(name);
      if (helper)
        for (const folder of objectsIn(target, helper, seen)) found.add(folder);
    });
    return found;
  };
  const handlers = new Map<string, Set<string>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^handle.*\.js$/.test(entry.name)) {
        const name = entry.name.slice(6, -3);
        const found = handlers.get(name) ?? new Set<string>();
        for (const folder of objectsIn(source(path), source(path), new Set()))
          found.add(folder);
        handlers.set(name, found);
      }
    }
  };
  walk(join(libRoot, 'handlers'));
  const tools: Record<string, string | null> = {};
  for (const name of [
    ...buildToolExpositionMap(CLOUD_LOCAL_TOOL_EXPOSITIONS).keys(),
  ].sort()) {
    const folders = [...(handlers.get(name) ?? [])];
    tools[name] = /UnitTest|AbapUnit/.test(name)
      ? 'unitTest'
      : folders.length === 1
        ? folders[0]
        : null;
  }
  return { tools };
}

if (require.main === module) {
  const output = join(__dirname, '..', 'srv', 'tool-objects.json');
  const snapshot = deriveToolObjects();
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(snapshot.tools).length} tools to ${output}`);
}
