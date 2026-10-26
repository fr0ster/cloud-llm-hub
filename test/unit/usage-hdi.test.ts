import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const artifacts = join(root, 'tools/hdi-deployer/src');
const read = (file: string): string => readFileSync(file, 'utf8');

function table(sql: string) {
  const match = /^(?:CREATE|COLUMN) TABLE\s+"?(\w+)"?\s*\(([\s\S]*)\)$/.exec(
    sql.trim(),
  );
  if (!match) throw new Error(`Unsupported table: ${sql}`);
  const columns: Array<{ name: string; type: string; nullable: boolean }> = [];
  const primaryKey: string[] = [];
  for (const line of match[2].split(/,\s*\n/)) {
    const column =
      /^\s*"(\w+)"\s+(NVARCHAR\(\d+\)|INTEGER|BIGINT|NCLOB)( NOT NULL| PRIMARY KEY)?\s*$/.exec(
        line,
      );
    if (!column) throw new Error(`Unsupported column: ${line}`);
    columns.push({ name: column[1], type: column[2], nullable: !column[3] });
    if (column[3] === ' PRIMARY KEY') primaryKey.push(column[1]);
  }
  return { name: match[1], columns, primaryKey };
}

function index(sql: string) {
  const match = /^(?:CREATE )?INDEX (\w+) ON (\w+) \(([^)]+)\)$/.exec(
    sql.trim(),
  );
  if (!match) throw new Error(`Unsupported index: ${sql}`);
  return {
    name: match[1],
    table: match[2],
    columns: match[3].split(',').map((column: string): string => column.trim()),
  };
}

test('usage HDI columns, nullability, primary key and every index match package DDL', (): void => {
  const statements = read(
    join(root, 'node_modules/@mcp-abap-adt/llm-usage-hana/ddl/usage.sql'),
  )
    .split(';')
    .map((sql: string): string => sql.trim())
    .filter((sql: string): boolean => sql.length > 0);
  expect(table(read(join(artifacts, 'USAGE_RECORDS.hdbtable')))).toEqual(
    table(statements[0]),
  );
  const indexes = readdirSync(artifacts)
    .filter((name: string): boolean => name.endsWith('.hdbindex'))
    .sort();
  const expected = statements
    .slice(1)
    .map((sql: string): { name: string; table: string; columns: string[] } =>
      index(sql),
    )
    .sort((a: ReturnType<typeof index>, b: ReturnType<typeof index>): number =>
      a.name.localeCompare(b.name),
    );
  expect(indexes).toEqual(
    expected.map(
      (entry: ReturnType<typeof index>): string => `${entry.name}.hdbindex`,
    ),
  );
  expect(
    indexes.map(
      (name: string): { name: string; table: string; columns: string[] } =>
        index(read(join(artifacts, name))),
    ),
  ).toEqual(expected);
  const config = read(join(artifacts, '.hdiconfig'));
  expect(JSON.parse(config)).toEqual({
    file_suffixes: {
      hdbtable: { plugin_name: 'com.sap.hana.di.table' },
      hdbindex: { plugin_name: 'com.sap.hana.di.index' },
    },
  });
});

test.each(['hdi-llm', 'test-usage-hdi'])(
  'HDI dry-run includes vector and usage artifacts for %s without deployment',
  (service: string): void => {
    const output = execFileSync(
      'bash',
      ['tools/deploy-hdi-tables.sh', '--dry-run', service],
      { cwd: root, encoding: 'utf8', timeout: 10000 },
    );
    for (const name of [
      'RAG_DOCUMENTS.hdbtable',
      'RAG_COLLECTIONS.hdbtable',
      ...readdirSync(artifacts),
    ]) {
      expect(output).toContain(`-> src/${name}`);
    }
    expect(output).toContain(`--var hdi_service=${service}`);
    expect(output).toContain('[dry-run] cf push');
    expect(output).toContain('[dry-run] cf delete');
  },
);
