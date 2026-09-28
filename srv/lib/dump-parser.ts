// Lifted from the abap-dump-monitor example application's srv/dump-parser.ts (verbatim parseDump +
// MAJOR_TITLES + private helpers), with the ParsedDump/DumpHeader/CallFrame/
// VariableSnapshot/SourceExtract types inlined from that project's interfaces.ts, plus
// dumpSectionIndex/dePad/getDumpSection added for the section-buffer API.

export interface DumpHeader {
  system: string;
  client?: string;
  dumpId: string;
  runtimeError?: string;
  exceptionClass?: string;
  category?: string;
  host?: string;
  instance?: string;
  program?: string;
  include?: string;
  mainProgram?: string;
  sourceLine?: number;
  event?: string;
  transactionId?: string;
  abapUser?: string;
  occurredAt?: string;
  shortText?: string;
}

export interface CallFrame {
  position: number;
  program?: string;
  include?: string;
  line?: number;
  eventType?: string;
  eventName?: string;
}

export interface VariableSnapshot {
  scope: string;
  frameNo?: number;
  name: string;
  type?: string;
  value?: string;
  truncated?: boolean;
}

export interface SourceExtract {
  program?: string;
  include?: string;
  lineFrom?: number;
  lineTo?: number;
  code?: string;
}

export interface ParsedDump {
  header: DumpHeader;
  rawPayload: string;
  callStack: CallFrame[];
  variables: VariableSnapshot[];
  sourceExtract?: SourceExtract;
}

// cloud-llm-hub RuntimeGetDumpById(view='formatted') returns the long-form ST22
// dump as pipe-delimited text. Sections of interest:
//   • Top fixed-width header (Category / Runtime Errors / Except. / ABAP: Program / Date and Time)
//   • |Short Text| block
//   • |Active Calls/Events| — call stack (paired rows: details + readable name)
//   • |Source Code Extract| — line + code, with crash line marked '>>>>>'
//   • |Selected Variables| — per-frame variable name/value groups
// header.category mirrors the cloud-llm-hub MCP feed field 'd.category',
// which is the SAP Application Component code (e.g. 'BC-ABA-LA'). The
// dump payload's 'Application Component' top-header line is the same
// value — used as a fallback when the MCP omits the field. The high-
// level 'Category' line ('ABAP Programming Error' etc.) is a different
// concept and intentionally NOT mapped here.
const TOP_HEADER_KEYS: Record<string, keyof DumpHeader> = {
  'Runtime Errors': 'runtimeError',
  'Except.': 'exceptionClass',
  'ABAP: Program': 'program',
  'Application Component': 'category',
  'User and Client': 'abapUser',
};

export function parseDump(
  system: string,
  dumpId: string,
  payload: string,
): ParsedDump {
  const header: DumpHeader = { system, dumpId };

  // Top fixed-width key/value block lives between the first two dashed separators.
  // Lines look like:  "Runtime Errors         COMPUTE_INT_PLUS_OVERFLOW   ..."
  const chunks = payload.split(/^[-]{50,}.*$/m);
  const topBlock =
    chunks.find((c) => /^\s*Category\s+/m.test(c)) ??
    chunks[1] ??
    chunks[0] ??
    '';
  for (const line of topBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const [key, prop] of Object.entries(TOP_HEADER_KEYS)) {
      if (line.startsWith(key)) {
        const value = line.slice(key.length).trim();
        if (value) {
          // 'User and Client' is rendered as "<USER> <CLIENT>" — split it.
          if (key === 'User and Client') {
            const parts = value.split(/\s+/);
            header.abapUser = parts[0];
            if (parts[1]) header.client = parts[1];
          } else {
            (header as unknown as Record<string, string>)[prop] = value;
          }
        }
        break;
      }
    }
    if (line.startsWith('Date and Time')) {
      const m =
        /Date and Time\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(
          line,
        );
      if (m)
        header.occurredAt = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`;
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
    const m1 = /termination point is in line (\d+) of include\s+"([^"]+)"/.exec(
      wtFlat,
    );
    if (m1) {
      header.sourceLine ??= Number.parseInt(m1[1], 10);
      header.include ??= m1[2];
    }
    const m2 =
      /termination occurred in ABAP program or include\s+"([^"]+)"/.exec(
        wtFlat,
      );
    if (m2) header.program ??= m2[1];
    const m3 = /main program was\s+"([^"]+)"/.exec(wtFlat);
    if (m3) header.mainProgram ??= m3[1];
  }

  const callStack = parseCallStack(
    extractSection(payload, 'Active Calls/Events'),
  );
  const sourceExtract = parseSourceExtract(
    extractSection(payload, 'Source Code Extract'),
  );
  const variables = parseVariables(
    extractSection(payload, 'Selected Variables'),
  );

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

  return { header, rawPayload: payload, callStack, variables, sourceExtract };
}

// Known top-level chapter titles in formatted ST22 dumps. Any pipe-line whose entire
// content matches one of these is a section boundary; all other pipe-lines (including
// inner frame markers like "|No. 3 Ty. METHOD|") are content of the current section.
export const MAJOR_TITLES = new Set([
  'Short Text',
  'What happened?',
  'What can you do?',
  'Error analysis',
  'How to correct the error',
  'Chain of Exception Objects',
  'Information on where terminated',
  'Source Code Extract',
  'Contents of system fields',
  'Active Calls/Events',
  'Selected Variables',
  'Information About Memory Usage in the Internal Session',
  'Application Calls',
  'List of ABAP programs affected',
  'Internal notes',
  'Active Calls in SAP Kernel',
  'Directory of Application Tables',
  'ABAP Control Blocks (CONT)',
  'System environment',
  'User and Transaction',
]);

function extractSection(payload: string, title: string): string {
  const lines = payload.split(/\r?\n/);
  let inside = false;
  const out: string[] = [];
  for (const l of lines) {
    const titleMatch = /^\|\s*([^|]+?)\s*\|\s*$/.exec(l);
    const candidate = titleMatch?.[1].trim();
    // ST22 sometimes appends "(Source code changed)" or other parenthesised
    // qualifiers to a section heading — strip them before comparing so we
    // still recognise the section under its canonical title.
    const canonical = candidate?.replace(/\s*\([^)]+\)\s*$/, '').trim();
    if (!inside) {
      if (canonical === title) inside = true;
      continue;
    }
    // Inside: stop only when we hit ANOTHER known major section title.
    if (canonical && canonical !== title && MAJOR_TITLES.has(canonical)) break;
    out.push(l);
  }
  return out.join('\n');
}

function pipeContent(line: string): string {
  // Strip leading '|' and trailing '...|', return middle content.
  const m = /^\|(.*?)\|?\s*$/.exec(line);
  return m ? m[1] : line;
}

function parseCallStack(section: string): CallFrame[] {
  const frames: CallFrame[] = [];
  const lines = section
    .split(/\r?\n/)
    .filter((l) => l.startsWith('|') && !/^\|-+/.test(l));
  // Detail row examples:
  //   "   13 METHOD       CL_X=========CP    CL_X=========CM00G    22"
  //   "    2 FUNCTION     SAPLHTTP_RUNTIME    LHTTP_RUNTIMEU02    1779"
  //   "    1 MODULE (PBO) SAPMHTTP            SAPMHTTP              12"   ← parens with space
  // eventType may include a parenthesised qualifier: anchor on KIND keyword,
  // optionally followed by " (...)".
  const ROW =
    /^\s*(\d+)\s+(METHOD|FUNCTION|FORM|EVENT|MODULE|PROGRAM)(\s*\([^)]+\))?\s+(\S+)\s+(\S+)\s+(\d+)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const c = pipeContent(lines[i]);
    const m = ROW.exec(c);
    if (!m) continue;
    const eventType = (m[2] + (m[3] ?? '')).replace(/\s+/g, ' ').trim();
    let eventName: string | undefined;
    if (i + 1 < lines.length) {
      const next = pipeContent(lines[i + 1]).trim();
      if (next && !ROW.test(next)) eventName = next;
    }
    frames.push({
      position: Number.parseInt(m[1], 10),
      eventType,
      eventName,
      program: m[4],
      include: m[5],
      line: Number.parseInt(m[6], 10),
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
    if (!raw.startsWith('|') || /^\|-+/.test(raw) || /^\|Line\s*\|/.test(raw))
      continue;
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
  const rawLines = section.split(/\r?\n/);
  // Pre-pass: stitch continuation lines. ST22 long values overflow the pipe
  // column; the formatter terminates an unfinished line with a literal '\'
  // before the closing pipe ('...XYZ\|'). The next line continues without a
  // leading-space indent marker — treat the join as character-level.
  const stitched: string[] = [];
  let buf = '';
  for (const raw of rawLines) {
    if (!raw.startsWith('|')) {
      if (buf) {
        stitched.push(buf);
        buf = '';
      }
      continue;
    }
    if (/^\|-+/.test(raw)) {
      if (buf) {
        stitched.push(buf);
        buf = '';
      }
      continue;
    }
    const c = pipeContent(raw);
    if (c.endsWith('\\')) buf += c.slice(0, -1);
    else {
      stitched.push(buf + c);
      buf = '';
    }
  }
  if (buf) stitched.push(buf);

  let pendingName: string | undefined;
  let valueAccum: string[] = [];
  let scope = 'local';
  let frameNo: number | undefined;
  let expectFrameNameLine = false;
  // ABAP runtime-internal helpers that pollute the variables list — '%_PRINT',
  // '%_SPACE', '%_DUMMY$$', '%_ARCHIVE', '%_##TVREG_*', '%_EXCP%_#E*' and the
  // anonymous '<%_L###>' field symbols. These describe ST22's own bookkeeping,
  // not user code state, and on recursive dumps they account for ~20% of rows.
  // SY-* / SYST-* are kept — they expose the SAP system field state (SUBRC,
  // MSGID, DBCNT, …) which is genuinely useful when reading a dump.
  const NOISE = /^(?:%_|<%_)/;
  const flush = () => {
    if (pendingName && !NOISE.test(pendingName)) {
      // Keep only the first (printable) representation row of the value;
      // ST22 lists 3-4 additional rows per non-printable type for hex
      // high/low bytes and char codes, which collapse into the cell as
      // "X\n5\n8\n0\n0\n5800" — useless in a Fiori table.
      const lines = valueAccum
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
      const first = lines[0] ?? '';
      result.push({
        scope,
        frameNo,
        name: pendingName,
        type: '',
        value: first,
        truncated: lines.length > 1,
      });
    }
    pendingName = undefined;
    valueAccum = [];
  };
  for (const c of stitched) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    // Frame separator: "No.   13 Ty.   METHOD ..."
    const fm = /^No\.\s+(\d+)\s+Ty\.\s+([A-Z()\s]+?)(?:\s{2,}|$)/.exec(trimmed);
    if (fm) {
      flush();
      frameNo = Number.parseInt(fm[1], 10);
      scope = fm[2].replace(/\s+/g, ' ').trim().toLowerCase();
      expectFrameNameLine = true;
      continue;
    }
    // Frame name line right after frame separator: "Name  CL_X=>METHOD" — skip.
    if (expectFrameNameLine && /^Name\s+\S/.test(trimmed)) {
      expectFrameNameLine = false;
      continue;
    }
    expectFrameNameLine = false;
    // Section column header: "Name", "Val.", "Name    Val." — skip.
    if (/^Name(\s+Val\.?)?$/.test(trimmed) || /^Val\.?$/.test(trimmed)) {
      flush();
      continue;
    }
    // Variable name lines start at column 0 of pipe content (no leading spaces).
    // Value lines are indented (≥4 spaces) — they may be hex/char rows for the
    // current variable, multiple per name (printable, hex high, hex low, etc).
    if (!/^\s/.test(c)) {
      flush();
      pendingName = trimmed;
      continue;
    }
    valueAccum.push(c.replace(/^ {0,8}/, ''));
  }
  flush();
  return result;
}

function extractShortText(payload: string): string | undefined {
  const m = /\|Short Text\s*\|[\r\n-]+\|\s*([^|]+?)\s*\|/m.exec(payload);
  return m ? m[1].trim() : undefined;
}

/** List the major chapter titles actually present in the payload, in document order. */
export function dumpSectionIndex(payload: string): string[] {
  const titles: string[] = [];
  for (const l of payload.split(/\r?\n/)) {
    const titleMatch = /^\|\s*([^|]+?)\s*\|\s*$/.exec(l);
    const candidate = titleMatch?.[1].trim();
    const canonical = candidate?.replace(/\s*\([^)]+\)\s*$/, '').trim();
    if (canonical && MAJOR_TITLES.has(canonical)) titles.push(canonical);
  }
  return titles;
}

/** Strip pipe framing and trailing padding, collapsing a raw pipe-delimited chapter to plain text. */
export function dePad(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => {
      if (/^\|-+\|?\s*$/.test(l)) return null;
      if (l.startsWith('|')) return pipeContent(l).replace(/\s+$/, '');
      return l.replace(/\s+$/, '');
    })
    .filter((l): l is string => l !== null)
    .join('\n')
    .trim();
}

/** Return one de-padded chapter by canonical title, or null if unknown/absent. */
export function getDumpSection(payload: string, title: string): string | null {
  if (!MAJOR_TITLES.has(title)) return null;
  const section = extractSection(payload, title);
  if (!section.trim()) return null;
  return dePad(section);
}
