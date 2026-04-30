import type { ParsedDump, DumpHeader, CallFrame, ReferencedObject, VariableSnapshot, SourceExtract } from './interfaces';

const HEADER_KEYS: Record<string, keyof DumpHeader> = {
  RUNTIME_ERROR: 'runtimeError',
  EXCEPTION: 'exceptionClass',
  PROGRAM: 'program',
  INCLUDE: 'include',
  USER: 'abapUser',
  CLIENT: 'client',
  HOST: 'host',
  INSTANCE: 'instance',
  EVENT: 'event',
  TRANSACTION_ID: 'transactionId',
  SHORT_TEXT: 'shortText'
};

export function parseDump(system: string, dumpId: string, payload: string): ParsedDump {
  const header: DumpHeader = { system, dumpId };
  const callStack: CallFrame[] = [];
  const variables: VariableSnapshot[] = [];
  let sourceExtract: SourceExtract | undefined;

  const sections = splitSections(payload);

  for (const line of sections.headerLines) {
    const m = /^(\w+)\s{2,}(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'DATE') header.occurredAt = parseDate(value);
    else if (key === 'LINE') header.sourceLine = Number.parseInt(value, 10);
    else if (HEADER_KEYS[key]) (header as any)[HEADER_KEYS[key]] = value.trim();
  }

  for (const line of sections.callStack) {
    const m = /^(\d+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    callStack.push({
      position: Number.parseInt(m[1], 10),
      eventType: m[2],
      eventName: m[3],
      program: m[4],
      include: m[5],
      line: Number.parseInt(m[6], 10)
    });
  }

  if (sections.sourceExtract.length) {
    let program: string | undefined;
    let include: string | undefined;
    const codeLines: string[] = [];
    let lineFrom: number | undefined;
    let lineTo: number | undefined;
    for (const line of sections.sourceExtract) {
      const pm = /^PROGRAM\s+(.+)$/.exec(line);
      const im = /^INCLUDE\s+(.+)$/.exec(line);
      const cm = /^(?:>>>\s*)?(\d+)\s+(.*)$/.exec(line);
      if (pm) program = pm[1].trim();
      else if (im) include = im[1].trim();
      else if (cm) {
        const ln = Number.parseInt(cm[1], 10);
        if (lineFrom === undefined) lineFrom = ln;
        lineTo = ln;
        codeLines.push(line.replace(/^>>>\s*/, ''));
      }
    }
    sourceExtract = { program, include, lineFrom, lineTo, code: codeLines.join('\n') };
  }

  for (const line of sections.variables) {
    const m = /^(LOCAL|GLOBAL|SY)\s+(\S+)\s+(.+?)\s{2,}(.*)$/.exec(line.trim());
    if (!m) continue;
    variables.push({
      scope: m[1].toLowerCase() as VariableSnapshot['scope'],
      name: m[2],
      type: m[3].trim(),
      value: m[4].trim()
    });
  }

  const referencedObjects = dedupReferences(callStack, sourceExtract);

  return { header, rawPayload: payload, callStack, referencedObjects, variables, sourceExtract };
}

function splitSections(payload: string): {
  headerLines: string[];
  callStack: string[];
  sourceExtract: string[];
  variables: string[];
} {
  const headerLines: string[] = [];
  const callStack: string[] = [];
  const sourceExtract: string[] = [];
  const variables: string[] = [];
  let current: 'header' | 'stack' | 'source' | 'vars' = 'header';
  for (const raw of payload.split(/\r?\n/)) {
    if (/^---+\s*CALL STACK/i.test(raw))     { current = 'stack'; continue; }
    if (/^---+\s*SOURCE EXTRACT/i.test(raw)) { current = 'source'; continue; }
    if (/^---+\s*VARIABLES/i.test(raw))      { current = 'vars'; continue; }
    if (current === 'header') headerLines.push(raw);
    else if (current === 'stack') callStack.push(raw);
    else if (current === 'source') sourceExtract.push(raw);
    else variables.push(raw);
  }
  return { headerLines, callStack, sourceExtract, variables };
}

function parseDate(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(v.trim());
  return m ? `${m[1]}T${m[2]}Z` : v.trim();
}

function dedupReferences(stack: CallFrame[], src?: SourceExtract): ReferencedObject[] {
  const seen = new Map<string, ReferencedObject>();
  const add = (objectName: string | undefined, source: ReferencedObject['source']) => {
    if (!objectName) return;
    const key = `${objectName}:${source}`;
    if (seen.has(key)) return;
    seen.set(key, { objectName, objectType: classify(objectName), source });
  };
  for (const f of stack) { add(f.program, 'stack'); add(f.include, 'stack'); }
  if (src) { add(src.program, 'source-extract'); add(src.include, 'source-extract'); }
  return [...seen.values()];
}

function classify(name: string): string {
  if (/^ZCL_|^CL_/.test(name)) return 'CLAS/OC';
  if (/^ZIF_|^IF_/.test(name)) return 'INTF/OI';
  if (/^L?SAP|^Z?REPORT|^Z[A-Z]+_/.test(name)) return 'PROG/P';
  return 'UNKNOWN';
}
