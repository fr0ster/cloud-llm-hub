# Evidence: large read throughput

Measurements behind [the goal](../2026-11-27-large-read-throughput-goal.md). They come from one long read-only
run of a client agent on an older hub release (customer deployment, on-prem SAP system, agent MCP channel,
tool `execute_step`). The agent analysed one large ABAP development (8 RICEFW objects, about 470 SAP objects) and
wrote its documentation. The data is anonymised: no system, object, user or customer names, and no task text.

## Files

- `hub_calls.csv` — one row per hub call (1,129 calls), times in UTC:

  | Column | Meaning |
  |---|---|
  | `when_utc` | start of the call |
  | `request` | the client's request class, see the table below |
  | `kind` | the request classified from the task text |
  | `seconds` | client view, from tool_use to tool_result |
  | `parallel` | other hub calls of the client running at the same time |
  | `answer_chars` | size of the answer |
  | `code_lines` | lines of the ABAP code block in the answer |
  | `hub_steps` | internal steps the hub narrated ("I'll… / Now I… / Let me…") |
  | `flags` | the client's verdict: `EMPTY`, `CONDENSED?`, `NO_CODE`, `TIMEOUT`, `ERROR` |
  | `timeout`, `empty` | detected in the answer text |
  | `task_chars` | size of the task |

  The request classes:

  | `request` | Meaning |
  |---|---|
  | `src` | verbatim source with metadata |
  | `tr` | transport tables E070/E071/E07T/E071K |
  | `tab` | filtered table read |
  | `node` / `thead` | format tree nodes and head (DMEE tables) |
  | `dd` | data dictionary |
  | `msg` | T100 |
  | `pkg` / `tadir` | object directory |
  | `pre` | existence check |
  | `srch` | search |
  | others | small support reads |

- `hubperf.py` — rebuilds such a table and the summary below from any Claude Code run:
  `python -I hubperf.py <transcript dir of the run> <client store index or -> <out.csv>`.

## The run as the client saw it

| | Hours |
|---|---|
| Wall time of the run (27 sub-agent sessions, one after the other) | 10.4 |
| Waiting for the hub (union of call intervals) | 7.7 |
| Client model (3,059 turns, median 2–3 s each, no slow-down with context size) | 2.4 |
| Client scripts and files | 0.3 |

The hub is the critical path: three quarters of the wall time.

The summed call time was 10.1 h: about 1.3 calls ran at once on average. It splits as follows:

| Calls | Count | Hours | Share | Note |
|---|---|---|---|---|
| Useful reads | 701 | 6.4 | 63 % | |
| Transport table reads | 334 | 1.9 | 19 % | a client-side choice, since removed in the client |
| Bad answers the client had to ask again | 82 | 1.1 | 11 % | see "Misread requests" |
| Timeouts (client limit 300 s) | 8 | 0.7 | 7 % | mostly the outage |

## Call time

Successful calls: **seconds ≈ 16.8 + 3.3 per 1,000 answer characters** (linear fit, about 300 characters per
second). Of 9.0 h, 5.1 h (56 %) are the fixed part and 4.0 h (44 %) the size-dependent part.

| Kind | Calls | Median s | p90 s | Max s | Sum h | Median answer chars |
|---|---|---|---|---|---|---|
| source read | 297 | 28 | 142 | 356 | 4.66 | 3,662 |
| transport table read | 364 | 19 | 36 | 598 | 2.52 | 1,145 |
| data dictionary | 136 | 19 | 33 | 313 | 0.87 | 1,063 |
| format tree nodes | 112 | 27 | 36 | 53 | 0.78 | 4,264 |
| table read | 116 | 18 | 36 | 59 | 0.65 | 950 |
| format tree head | 11 | 21 | 300 | 300 | 0.27 | 1,012 |
| message texts | 46 | 15 | 23 | 31 | 0.20 | 894 |
| package listing | 34 | 16 | 25 | 38 | 0.16 | 838 |
| existence check | 8 | 9 | 11 | 11 | 0.02 | 442 |

| Answer size | Calls | Median s |
|---|---|---|
| < 2k chars | 665 | 17 |
| 2–5k | 283 | 27 |
| 5–10k | 61 | 31 |
| 10–20k | 28 | 59 |
| 20–40k | 28 | 112 |
| > 40k | 19 | 194 |

Source reads alone cost 4.3 h of successful call time. Of that, 1.4 h is the fixed part and 3.0 h the size-dependent
part.

**Slowest successful calls.** All but one are verbatim source reads of large classes:

| Seconds | Answer chars | Code lines |
|---|---|---|
| 356 | 47,204 | 1,267 |
| 296 | 82,977 | 2,685 |
| 295 | 24,049 | 772 |
| 290 | 25,822 | 837 |
| 262 | 85,086 | 2,359 |
| 251 | 79,899 | 2,596 |
| 204 | 64,442 | 2,121 |
| 202 | 71,451 | 2,082 |

The one exception is a one-row data dictionary read that took 313 s during the degraded window. Several reads of
the same size hit the client's 300 s limit and were repeated in parts.

**Internal steps.** The time barely depends on the number of steps the hub narrates:

| Narrated steps | Calls | Median s |
|---|---|---|
| 1 | 765 | 19 |
| 2 | 105 | 25 |
| 3–4 | 137 | 24 |
| 5+ | 73 | 33 |

**Parallel calls during the run.** For simple table reads the median was 15 s with no other call running, 19 s with
one other and 17 s with two others.

## Concurrency test (27.11, idle hub, identical one-row T100 read, one MCP session)

| Calls sent at once | Wall | Per call min / median / max |
|---|---|---|
| 1 | 7.5 s | 7.5 / 7.5 / 7.5 s |
| 3 | 22.0 s | 9.0 / 14.0 / 20.0 s |
| 6 | 50.7 s | 13.0 / 34.4 / 45.3 s |
| 10 | 74.8 s | 17.0 / 43.9 / 65.0 s |

The wall time grows linearly at about 7.5 s per call, so the requests of one user are processed one at a time.

Four separate client processes (four MCP connections, one call each) ended after 14.0, 17.4, 20.9 and 23.9 s,
against 14.2 s for a single process; both figures include the client start. That is a small gain only.

In the run, groups of 3–4 heavy calls (dump details) sent together came back empty, while the same requests one
by one succeeded.

## Misread requests (each cost at least one repeated call)

- A destination name written in the task text was taken as a user filter (runtime-dump feed: 0 rows).
- A multi-value "one of" list in a table filter returned empty; a single equality returned the rows.
- A whole format tree read returned a sample; paging with a WHERE-clause filter on the node ID returned all rows.
- Enhancement implementations (ENHO) returned no source.
- Domain values were labelled wrongly (transport request type, version status).
- `UNVERIFIED_WRITE` disclaimers were appended to read-only answers.
- 35 answers were flagged `CONDENSED?` (shortened source, summary instead of rows) and 21 `NO_CODE` (source
  requested, no code block).

## Outage

- 2026-11-26 20:51–21:03 UTC: degraded; heavy reads (search, long filter lists, tree head) timed out, simple reads
  passed.
- 21:03–21:44 UTC: no answers at all; 7 consecutive timeouts of 300 s.
- From 21:44 UTC: normal again; no timeout in the remaining 6.9 hours of the run.

## Second run (27.11.2026, newer client package; snapshot while the run continued)

The same kind of task on the same hub, with a newer client package: no transport-table reads, one table per call,
one hub read per object. `hub_calls_run2.csv` has the same columns. It holds 440 calls, 14:30–19:10 UTC, taken while
the run was still going (5 of 9 objects done). Summed call time 4.3 h.

**Call time.** The fit is the same as in the first run: **seconds ≈ 17.9 + 3.2 per 1,000 answer characters**.
Of 3.9 h of successful calls, 2.1 h (54 %) are the fixed part.

| Kind | Calls | Median s | p90 s | Max s | Sum h | Median answer chars |
|---|---|---|---|---|---|---|
| source read | 205 | 22 | 89 | 316 | 2.39 | 2,356 |
| format tree nodes | 89 | 36 | 49 | 71 | 0.88 | 4,461 |
| table read | 38 | 28 | 56 | 100 | 0.34 | 1,211 |
| package listing | 38 | 18 | 34 | 59 | 0.22 | 1,558 |
| other | 31 | 19 | 36 | 75 | 0.19 | 1,746 |
| data dictionary | 17 | 21 | 29 | 34 | 0.10 | 2,109 |
| message texts | 10 | 15 | 40 | 42 | 0.06 | 1,141 |

| Answer size | Calls | Median s |
|---|---|---|
| < 2k chars | 175 | 15 |
| 2–5k | 156 | 27 |
| 5–10k | 66 | 41 |
| 10–20k | 8 | 58 |
| 20–40k | 10 | 91 |
| > 40k | 8 | 213 |

The slowest successful calls are again verbatim reads of large classes: 45,000–85,000 characters took 209–277 s.

**Empty answers and timeouts (14 empty, 3 timeouts).** Only 4 of the 17 had another call of the client running, so
they are not caused by parallel calls. They are caused by the wording of the request:

| Count | Request | What worked afterwards |
|---|---|---|
| 5 empty | one task that joins tables: object directory of a package, then the transaction table, then the texts | one table per call |
| 7 empty | next page of format tree nodes with `NODE_ID greater than '<last ID>'` | `NODE_ID >= '<last ID + 1>'` and "return exactly the first 50 rows" |
| 2 empty | one message text (T100, one key) asked as a table read — the same form worked in the concurrency test | the same read written as `SELECT … FROM T100 WHERE …` |
| 3 timeouts (300 s) | whole read of a mid-size class (twice), one enhancement read | the class read method by method |

**Answers the client rejected and asked again** (not visible in the flags; from the client's log):

- Format tree node pages: 21 of 69 in one session returned a summary, a statement of a tool limit, or rows that were
  filtered locally and partly not in the table.
- "First 100 rows scanned" instead of a database filter (3 reads).
- A long "one of" list replaced by LIKE; 10 of 23 rows returned.
- Counts that do not match the listed rows (90 claimed / 75 listed; 55 / 40).

What the second run adds to the goal: the per-character cost and the fixed cost per call do not change with a more
careful client; the remaining waste comes from the hub's interpretation of the request (joins, `>` filters, phrasing),
not from parallel calls.
