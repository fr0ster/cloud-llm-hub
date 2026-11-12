import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('deploy-hdi-tables dry run lists all six artifacts', () => {
  const output = execFileSync(
    'bash',
    ['tools/deploy-hdi-tables.sh', '--dry-run'],
    { encoding: 'utf8' },
  );
  for (const name of [
    'RAG_DOCUMENTS',
    'RAG_COLLECTIONS',
    'rag_roles',
    'rag_role_assignments',
    'rag_collection_roles',
    'rag_session_bindings',
  ])
    expect(output).toContain(`${name}.hdbtable`);
  expect(output).toContain('merge');
  expect(output).toContain('hana-vector-rag/ddl/.hdiconfig');
  expect(output).toContain('up to 300 s');
});

test('HDI config merge retains shipped table and usage index plugins', () => {
  const script = readFileSync('tools/deploy-hdi-tables.sh', 'utf8');
  const start = script.indexOf("<<'NODE'\n") + "<<'NODE'\n".length;
  const code = script.slice(start, script.indexOf('\nNODE', start));
  const work = mkdtempSync(path.join(tmpdir(), 'hdi-config-'));
  const target = path.join(work, '.hdiconfig');
  try {
    execFileSync(
      process.execPath,
      [
        '-',
        path.resolve(
          'node_modules/@mcp-abap-adt/hana-vector-rag/ddl/.hdiconfig',
        ),
        path.resolve('tools/hdi-deployer/src/.hdiconfig'),
        target,
      ],
      { encoding: 'utf8', input: code },
    );
    const output = readFileSync(target, 'utf8');
    expect(output).toContain('com.sap.hana.di.table');
    expect(output).toContain('com.sap.hana.di.index');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
