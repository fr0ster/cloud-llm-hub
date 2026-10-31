import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { ragMcpSchemas, ragToolNames } from '../../srv/lib/rag-tool-catalogue';

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(file)
      : file.endsWith('.md')
        ? [file]
        : [];
  });
}

const ragLooking = /^(?:rag_|collection|record_)/;
function canonical(name: string) {
  const tool = ragToolNames.find((candidate) => candidate === name);
  if (!tool) throw new Error(`Unregistered RAG tool: ${name}`);
  return tool;
}

// Scan identifiers inside inline code and call-like names anywhere (including fences).
// Parse call arguments as TypeScript to balance nested objects and strings correctly.
// Only symbolic property values are exempt from schema validation.
// Fenced JSON also supports MCP { name, arguments } envelopes.
const symbolic = Symbol('symbolic');
function literalValue(node: ts.Expression): unknown {
  if (ts.isParenthesizedExpression(node)) return literalValue(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken)
  )
    return Number(node.getText());
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(literalValue);
    return values.includes(symbolic) ? symbolic : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return symbolic;
      const key = propertyKey(property.name);
      const child = literalValue(property.initializer);
      if (key === undefined || child === symbolic) return symbolic;
      value[key] = child;
    }
    return value;
  }
  return symbolic;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  if (ts.isComputedPropertyName(name)) {
    const key = literalValue(name.expression);
    if (typeof key === 'string' || typeof key === 'number') return String(key);
  }
  return undefined;
}

function validatePrompt(text: string): void {
  const references = new Set<string>();
  for (const code of text.matchAll(/`([^`\n]+)`/g)) {
    for (const identifier of code[1].matchAll(
      /\b[a-z][a-z0-9_]*_[a-z0-9_]+\b/g,
    )) {
      references.add(identifier[0]);
    }
  }
  for (const call of text.matchAll(/\b([a-z][a-z0-9_]*_[a-z0-9_]+)\s*\(/g)) {
    const name = call[1];
    references.add(name);
    if (!ragLooking.test(name)) continue;
    const tool = canonical(name);
    const source = ts.createSourceFile(
      'example.ts',
      text.slice(call.index),
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = source.statements[0];
    if (
      !statement ||
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      continue;
    const argument = statement.expression.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
    const schema = ragMcpSchemas[tool];
    const values: Record<string, unknown> = {};
    const symbolicKeys = new Set<string>();
    for (const property of argument.properties) {
      if (ts.isSpreadAssignment(property))
        throw new Error('Cannot verify keys in a spread argument');
      const key = propertyKey(property.name);
      if (key === undefined || !Object.hasOwn(schema.shape, key))
        throw new Error(
          `Unknown argument: ${key ?? property.name.getText(source)}`,
        );
      const value = ts.isPropertyAssignment(property)
        ? literalValue(property.initializer)
        : symbolic;
      if (value === symbolic) symbolicKeys.add(key);
      else values[key] = value;
    }
    const result = schema.safeParse(values);
    if (!result.success) {
      const issues = result.error.issues.filter(
        (issue) => !symbolicKeys.has(String(issue.path[0])),
      );
      if (issues.length) throw new z.ZodError(issues);
    }
  }
  for (const name of references) if (ragLooking.test(name)) canonical(name);
  function validateJson(value: z.infer<ReturnType<typeof z.json>>): void {
    if (Array.isArray(value)) {
      value.forEach(validateJson);
    } else if (value !== null && typeof value === 'object') {
      const name = value.name ?? value.tool;
      if (typeof name === 'string' && ragLooking.test(name)) {
        ragMcpSchemas[canonical(name)].parse(value.arguments ?? value.input);
      }
      Object.values(value).forEach(validateJson);
    }
  }
  for (const fence of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    validateJson(z.json().parse(JSON.parse(fence[1])));
  }
}

it.each(['srv/agent-profiles', 'srv/presets', 'docs/tutorials'])(
  '%s ships registered RAG references and valid executable JSON examples',
  (directory: string) => {
    for (const file of markdownFiles(directory)) {
      try {
        validatePrompt(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  },
);

it.each(['rag_invented', 'collection_restore', 'record_replace'])(
  'rejects unregistered references to %s',
  (name: string) => {
    expect(() => validatePrompt(`Use \`${name}\``)).toThrow(
      'Unregistered RAG tool',
    );
    expect(() => validatePrompt(`${name}({})`)).toThrow(
      'Unregistered RAG tool',
    );
  },
);
it('validates nested JSON and rejects noncanonical arguments', () => {
  validatePrompt(
    'record_add({ "collection": "result", "record": "phase-1", "text": "a } in text" })',
  );
  expect(() =>
    validatePrompt(
      'record_add({ "collection": "result", "id": "wrong", "text": "text" })',
    ),
  ).toThrow();
  expect(() =>
    validatePrompt(
      '```json\n{"name":"record_update","arguments":{"collection":"result","id":"wrong","text":"text"}}\n```',
    ),
  ).toThrow();
});

it('validates JavaScript literals and checks keys even with symbolic values', () => {
  validatePrompt(
    'record_add({ collection: "result", record: "tech-spec", text: "..." })',
  );
  validatePrompt(
    `record_update({ collection, record: <id>, text: \`body \${content}\` })`,
  );
  validatePrompt('rag_search({ query: "q", collections: ["result"], k: 2 })');
  for (const example of [
    'record_add({ collection: "result", id: "tech-spec", text: "..." })',
    'record_add({ collection, id, text })',
    'record_add({ collection, text: 42 })',
    'record_add({ collection })',
    'rag_search({ query, collections: [42] })',
    'rag_search({ query, k: -1 })',
    'rag_read({ collection, id, wrong: placeholder })',
  ])
    expect(() => validatePrompt(example)).toThrow();
});
