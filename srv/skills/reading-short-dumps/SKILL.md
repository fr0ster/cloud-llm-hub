---
name: reading-short-dumps
description: Read ABAP runtime short dumps (ST22) via feed lookup + GetDumpSection index-first — never fetch the whole formatted dump
---

# Reading a short dump

An ABAP runtime error dump (ST22) is retrieved in three moves: find it in the runtime feed,
get its section index, then pull only the chapters you need. The catch is the id format —
and the temptation to fetch the whole thing.

## How dumps are addressed

- **The dump list comes from the runtime feed.** To find dumps — the latest, or the ones
  for a given user / date / program — read the feed; it enumerates the available dumps and
  can be narrowed (e.g. by user). Start there, then pick the dump you want.
- **A dump id from the feed is a URL, not a bare timestamp.** Each feed entry carries the
  dump's id as a URI / path. The id you pass to fetch it is the **last path segment** of
  that URL — the part after the final `/`. Passing the raw timestamp (e.g.
  `20260717100828`) or the whole URL fails; normalize to the last segment first.

## Reading one dump: index first, then chapters

A full dump is enormous (order of 185K tokens formatted) — do not fetch it whole. Instead,
call `GetDumpSection` twice:

1. **`GetDumpSection` with the dump id and no `section`** returns the **section index**:
   the list of canonical ST22 chapter titles present in that dump (e.g. `Error analysis`,
   `Chain of Exception Objects`, `Source Code Extract`, `Active Calls/Events`, and others).
   This is small — just titles, no content.
2. **`GetDumpSection` with the dump id and a `section` set to one of those titles** returns
   that single chapter's content, de-padded. Call it once per chapter you actually need.

Do **not** call `RuntimeGetDumpById` for the full formatted view — it returns the entire
dump verbatim and is both slow and usually unnecessary once `GetDumpSection` can serve the
same content one chapter at a time.

## For root-cause analysis, read these four chapters

When diagnosing *why* a dump happened (not just cataloguing it), pull exactly these
chapters via `GetDumpSection`, in this order:

1. `Error analysis` — what failed and why, in ST22's own words
2. `Chain of Exception Objects` — the exception chain, if the error is an uncaught exception
3. `Source Code Extract` — the failing statement in context
4. `Active Calls/Events` — the call stack at the point of failure

Other chapters (e.g. system fields, container info) are rarely needed for root cause —
fetch them only if these four leave a specific open question.

## Common mistake

| Symptom | Fix |
|---|---|
| "Dump id not found" when passing a timestamp | The id is the last path segment of the feed entry's URL, not the timestamp — normalize it first |
| Fetching a dump before finding its id | The bare timestamp / date is not the id; read the feed entry and take the last URL segment |
| Calling `RuntimeGetDumpById` for the full dump | Use `GetDumpSection` instead — no `section` for the index, then a chapter title for content |
| Guessing a chapter title | Always get the section index first (`GetDumpSection` with no `section`) — titles vary per dump; don't assume all four root-cause chapters exist |
