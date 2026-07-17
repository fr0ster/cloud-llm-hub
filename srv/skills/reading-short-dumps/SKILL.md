---
name: reading-short-dumps
description: Read ABAP runtime short dumps (ST22) — the dump list comes from the runtime feed, and a dump id from the feed is a URL whose last path segment is the id used to retrieve one dump
---

# Reading a short dump

An ABAP runtime error dump (ST22) is retrieved in two moves: find it in the runtime feed,
then fetch it by id. The catch is the id format.

## How dumps are addressed

- **The dump list comes from the runtime feed.** To find dumps — the latest, or the ones
  for a given user / date / program — read the feed; it enumerates the available dumps and
  can be narrowed (e.g. by user). Start there, then pick the dump you want.
- **A dump id from the feed is a URL, not a bare timestamp.** Each feed entry carries the
  dump's id as a URI / path. The id you pass to fetch one dump is the **last path segment**
  of that URL — the part after the final `/`. Passing the raw timestamp (e.g.
  `20260717100828`) or the whole URL fails; normalize to the last segment first.
- **Fetch one dump by that normalized id** to get its content: error analysis, short text,
  call stack, source extract, and system fields.

## Large payloads

A full dump can be very large. Do NOT ask for the whole raw payload verbatim when you need
only part of it — pull the specific sections you want (error analysis, the top call-stack
frames, the failing entity / service). Passing a large dump through unchanged is slow and
usually unnecessary; a very large dump reproduced verbatim can also exceed the model's
limits.

## Common mistake

| Symptom | Fix |
|---|---|
| "Dump id not found" when passing a timestamp | The id is the last path segment of the feed entry's URL, not the timestamp — normalize it first |
| Fetching a dump before finding its id | The bare timestamp / date is not the id; read the feed entry and take the last URL segment |
