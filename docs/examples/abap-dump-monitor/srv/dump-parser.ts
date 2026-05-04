import type { ParsedDump, DumpHeader, CallFrame, ReferencedObject, VariableSnapshot, SourceExtract } from './interfaces';

// cloud-llm-hub RuntimeGetDumpById(view='formatted') returns the long-form ST22
// dump as pipe-delimited text. Sections of interest:
//   • Top fixed-width header (Category / Runtime Errors / Except. / ABAP: Program / Date and Time)
//   • |Short Text| block
//   • |Active Calls/Events| — call stack (paired rows: details + readable name)
//   • |Source Code Extract| — line + code, with crash line marked '>>>>>'
//   • |Selected Variables| — per-frame variable name/value groups
const TOP_HEADER_KEYS: Record<string, keyof DumpHeader> = {
  'Runtime Errors':         'runtimeError',
  'Except.':                'exceptionClass',
  'ABAP: Program':          'program',
  'Application Component':  'category',
  'User and Client':        'abapUser'
};

export function parseDump(system: string, dumpId: string, payload: string): ParsedDump {
  const header: DumpHeader = { system, dumpId };

  // Top fixed-width key/value block lives between the first two dashed separators.
  // Lines look like:  "Runtime Errors         COMPUTE_INT_PLUS_OVERFLOW   ..."
  const chunks = payload.split(/^[-]{50,}.*$/m);
  const topBlock = chunks.find(c => /^\s*Category\s+/m.test(c)) ?? chunks[1] ?? chunks[0] ?? '';
  for (const line of topBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const [key, prop] of Object.entries(TOP_HEADER_KEYS)) {
      if (line.startsWith(key)) {
        const value = line.slice(key.length).trim();
        if (value) {
          // 'User and Client' is rendered as "<USER> <CLIENT>" — split it.
          if (key === 'User and Client') {
            const parts = value.split(/\s+/);
            (header as any).abapUser = parts[0];
            if (parts[1]) (header as any).client = parts[1];
          } else {
            (header as any)[prop] = value;
          }
        }
        break;
      }
    }
    if (line.startsWith('Date and Time')) {
      const m = /Date and Time\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
      if (m) header.occurredAt = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`;
    }
  }

  header.shortText = extractShortText(payload) ?? header.shortText;

  // User and Transaction — dotted-key/value lines like "User.................. DDIC".
  const ut = extractSection(payload, 'User and Transaction');
  if (ut) {
    for (const raw of ut.split(/\r?\n/)) {
      if (!raw.startsWith('|') || /^\|-+/.test(raw)) continue;
      const c = pipeContent(raw);
      const m = /^\s*([A-Za-z][A-Za-z .]+?)\.{2,}\s*(.*?)\s*$/.exec(c);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim();
      if (!val) continue;
      if (/^User$/i.test(key)) header.abapUser ??= val;
      else if (/^Client$/i.test(key)) header.client ??= val;
      else if (/^Transaction$/i.test(key) && val) header.transactionId ??= val;
      else if (/^Transaction ID$/i.test(key)) header.transactionId ??= val;
    }
  }

  // Information on where terminated — parse program/include/mainProgram/sourceLine.
  const wt = extractSection(payload, 'Information on where terminated');
  if (wt) {
    const wtFlat = wt.replace(/\r?\n/g, ' ');
    const m1 = /termination point is in line (\d+) of include\s+"([^"]+)"/.exec(wtFlat);
    if (m1) { header.sourceLine ??= Number.parseInt(m1[1], 10); header.include ??= m1[2]; }
    const m2 = /termination occurred in ABAP program or include\s+"([^"]+)"/.exec(wtFlat);
    if (m2) header.program ??= m2[1];
    const m3 = /main program was\s+"([^"]+)"/.exec(wtFlat);
    if (m3) header.mainProgram ??= m3[1];
  }

  const callStack = parseCallStack(extractSection(payload, 'Active Calls/Events'));
  const sourceExtract = parseSourceExtract(extractSection(payload, 'Source Code Extract'));
  const variables = parseVariables(extractSection(payload, 'Selected Variables'));

  // Pipe-delimited ST22 'Source Code Extract' has no PROGRAM/INCLUDE prefix —
  // those values live in the top header. Mirror them onto sourceExtract so the
  // Object Page custom Source section can render program/include in its title.
  if (sourceExtract) {
    sourceExtract.program ??= header.program;
    sourceExtract.include ??= header.include;
    if (!header.sourceLine && sourceExtract.lineFrom !== undefined) {
      // crash line is the one prefixed '>>>>>'; sourceExtract preserves it as lineFrom..lineTo span
    }
  }

  const referencedObjects = dedupReferences(callStack, sourceExtract);

  return { header, rawPayload: payload, callStack, referencedObjects, variables, sourceExtract };
}

// Known top-level chapter titles in formatted ST22 dumps. Any pipe-line whose entire
// content matches one of these is a section boundary; all other pipe-lines (including
// inner frame markers like "|No. 3 Ty. METHOD|") are content of the current section.
const MAJOR_TITLES = new Set([
  'Short Text', 'What happened?', 'What can you do?', 'Error analysis', 'How to correct the error',
  'Chain of Exception Objects', 'Information on where terminated', 'Source Code Extract',
  'Contents of system fields', 'Active Calls/Events', 'Selected Variables',
  'Information About Memory Usage in the Internal Session', 'Application Calls',
  'List of ABAP programs affected', 'Internal notes', 'Active Calls in SAP Kernel',
  'Directory of Application Tables', 'ABAP Control Blocks (CONT)', 'System environment',
  'User and Transaction'
]);

function extractSection(payload: string, title: string): string {
  const lines = payload.split(/\r?\n/);
  let inside = false;
  const out: string[] = [];
  for (const l of lines) {
    const titleMatch = /^\|\s*([^|]+?)\s*\|\s*$/.exec(l);
    const candidate = titleMatch?.[1].trim();
    if (!inside) {
      if (candidate === title) inside = true;
      continue;
    }
    // Inside: stop only when we hit ANOTHER known major section title.
    if (candidate && candidate !== title && MAJOR_TITLES.has(candidate)) break;
    out.push(l);
  }
  return out.join('\n');
}

function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function pipeContent(line: string): string {
  // Strip leading '|' and trailing '...|', return middle content.
  const m = /^\|(.*?)\|?\s*$/.exec(line);
  return m ? m[1] : line;
}

function parseCallStack(section: string): CallFrame[] {
  const frames: CallFrame[] = [];
  const lines = section.split(/\r?\n/).filter(l => l.startsWith('|') && !/^\|-+/.test(l));
  for (let i = 0; i < lines.length; i++) {
    const c = pipeContent(lines[i]);
    // Detail row:  "    3 METHOD       /IWFND/CL_METERING_DB=========CP    /IWFND/CL_METERING_DB=========CM00C    21"
    const m = /^\s*(\d+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(c);
    if (!m) continue;
    let eventName: string | undefined;
    if (i + 1 < lines.length) {
      const next = pipeContent(lines[i + 1]).trim();
      if (next && !/^\d+\s+\w+\s+/.test(next)) eventName = next;
    }
    frames.push({
      position: Number.parseInt(m[1], 10),
      eventType: m[2],
      eventName,
      program: m[3],
      include: m[4],
      line: Number.parseInt(m[5], 10)
    });
  }
  return frames;
}

function parseSourceExtract(section: string): SourceExtract | undefined {
  if (!section) return undefined;
  const codeLines: string[] = [];
  let lineFrom: number | undefined;
  let lineTo: number | undefined;
  for (const raw of section.split(/\r?\n/)) {
    if (!raw.startsWith('|') || /^\|-+/.test(raw) || /^\|Line\s*\|/.test(raw)) continue;
    // "|>>>>>|    <ls_gw_used_db>-obj_count..." crash marker has 5 chars before pipe
    // "|    1|METHOD determine_gw_used."  normal line: number + pipe + code
    const m = /^\|(\s*(?:>{2,}|\d+))\|(.*)\|\s*$/.exec(raw);
    if (!m) continue;
    const left = m[1].trim();
    const code = (m[2] ?? '').replace(/\s+$/, '');
    const ln = /^\d+$/.test(left) ? Number.parseInt(left, 10) : undefined;
    if (ln !== undefined) {
      if (lineFrom === undefined) lineFrom = ln;
      lineTo = ln;
      codeLines.push(code);
    } else {
      // crash line marker — keep it visible inline
      codeLines.push(`>>> ${code}`);
    }
  }
  if (codeLines.length === 0) return undefined;
  return { code: codeLines.join('\n'), lineFrom, lineTo };
}

function parseVariables(section: string): VariableSnapshot[] {
  if (!section) return [];
  const result: VariableSnapshot[] = [];
  const lines = section.split(/\r?\n/);
  let pendingName: string | undefined;
  let valueAccum: string[] = [];
  let scope: VariableSnapshot['scope'] = 'local';
  const flush = () => {
    if (pendingName) {
      result.push({
        scope,
        name: pendingName,
        type: '',
        value: valueAccum.join('\n').trim()
      });
    }
    pendingName = undefined;
    valueAccum = [];
  };
  for (const raw of lines) {
    if (!raw.startsWith('|') || /^\|-+/.test(raw)) continue;
    const c = pipeContent(raw);
    const trimmed = c.trim();
    if (!trimmed) continue;
    if (/^No\.\s+\d+\s+Ty\./.test(trimmed)) {
      // frame separator; classify upcoming variables as local/global by frame.
      flush();
      continue;
    }
    if (trimmed.startsWith('Name')) { flush(); continue; }
    // Variable name: starts at column 0, ALL CAPS or with - or < pattern, no leading spaces beyond pipe
    if (!c.startsWith('    ') && !c.startsWith('\t') && trimmed.length > 0) {
      flush();
      pendingName = trimmed;
      continue;
    }
    valueAccum.push(c.replace(/^\s{0,8}/, ''));
  }
  flush();
  return result;
}

function extractShortText(payload: string): string | undefined {
  const m = /\|Short Text\s*\|[\r\n-]+\|\s*([^|]+?)\s*\|/m.exec(payload);
  return m ? m[1].trim() : undefined;
}

function dedupReferences(callStack: CallFrame[], src: SourceExtract | undefined): ReferencedObject[] {
  const seen = new Set<string>();
  const out: ReferencedObject[] = [];
  const add = (name: string | undefined, source: ReferencedObject['source']) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ objectName: name, objectType: 'PROG', source });
  };
  for (const f of callStack) { add(f.program, 'stack'); add(f.include, 'stack'); }
  if (src) { add(src.program, 'source-extract'); add(src.include, 'source-extract'); }
  return out;
}
