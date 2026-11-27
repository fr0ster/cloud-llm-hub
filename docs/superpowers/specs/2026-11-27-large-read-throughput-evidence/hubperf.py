"""Per-call hub performance from Claude Code transcripts.
Usage: hubperf.py <transcript dir> <_index.tsv or -> <out.csv>"""
import csv, json, sys, pathlib, datetime as dt, re, os, statistics as st, collections

root, index, out = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
flags = {}
if index != "-" and os.path.exists(index):
    for l in open(index, encoding="utf-8"):
        c = l.rstrip("\n").split("\t")
        if len(c) >= 6: flags[c[1]] = c[5]
SAVED = re.compile(r"(?:Output has been saved to|Full output saved to:)\s*(\S+?\.(?:txt|json))\.?(?:\s|$)")
def text_of(c):
    if isinstance(c, str): return c
    if isinstance(c, list): return "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""
def full(t):
    m = SAVED.search(t or "")
    if m and os.path.isfile(m.group(1)):
        s = open(m.group(1), encoding="utf-8", errors="replace").read()
        try: return text_of(json.loads(s)) or s
        except ValueError: return s
    return t
STEP = re.compile(r"(?:^|[.!:]\s*)(I'll|I will|Let me|Now I|Now let me|Good!|Perfect!|Great!|I need to|I can see|I found)", re.M)
def kind_of(task):
    t = task.lower()
    if "dump" in t: return "short dump"
    if re.search(r"\bsource\b|verbatim|```abap|implementation part|method", t): return "source read"
    if re.search(r"table e07[01t]|e071k", t): return "transport table read"
    if "dmee_tree_node" in t: return "format tree nodes"
    if "dmee_tree_head" in t: return "format tree head"
    if "tadir" in t and "devclass" in t: return "package listing"
    if re.search(r"dd03l|dd02l|fields of|structure", t): return "data dictionary"
    if "t100" in t: return "message texts"
    if re.search(r"read table|table \w+ in", t): return "table read"
    if re.search(r"where-used|search|find", t): return "search"
    if "exist" in t: return "existence check"
    return "other"

rows = []
for p in sorted(root.glob("*/subagents/*.jsonl")):
    uses = {}
    for line in open(p, encoding="utf-8"):
        try: e = json.loads(line)
        except Exception: continue
        t = e.get("timestamp"); c = (e.get("message") or {}).get("content")
        if not t or not isinstance(c, list): continue
        t = ts(t)
        for x in c:
            if x.get("type") == "tool_use" and x.get("name", "").endswith("execute_step"):
                uses[x["id"]] = (t, (x.get("input") or {}).get("task", ""))
            elif x.get("type") == "tool_result" and x.get("tool_use_id") in uses:
                t0, task = uses.pop(x["tool_use_id"])
                ans = full(text_of(x.get("content")))
                key = task.split("\n")[0].replace("Ref:", "").strip()
                code = re.search(r"```abap(.*?)(```|\Z)", ans, re.S)
                rows.append(dict(start=t0, end=t, key=key, kind=kind_of(task), seconds=round(t - t0, 1),
                                 task_chars=len(task), answer_chars=len(ans),
                                 code_lines=len(code.group(1).splitlines()) if code else 0,
                                 hub_steps=len(STEP.findall(ans)), flags=flags.get(key, ""),
                                 timeout="timed out" in ans.lower() and len(ans) < 200,
                                 empty=len(ans.strip()) == 0 or "completed with no output" in ans,
                                 task_first_line=task.split("\n")[2][:160] if task.count("\n") >= 2 else task[:160]))
rows.sort(key=lambda r: r["start"])
for r in rows:
    r["parallel"] = sum(1 for o in rows if o is not r and o["start"] < r["end"] and o["end"] > r["start"])
    r["when_utc"] = dt.datetime.fromtimestamp(r["start"], dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
cols = ["when_utc", "key", "kind", "seconds", "parallel", "answer_chars", "code_lines", "hub_steps", "flags",
        "timeout", "empty", "task_chars", "task_first_line"]
with open(out, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=cols, delimiter=";", extrasaction="ignore"); w.writeheader(); w.writerows(rows)

ok = [r for r in rows if not r["timeout"] and not r["empty"]]
print(f"{len(rows)} calls, {sum(r['seconds'] for r in rows)/3600:.1f} h summed; timeouts {sum(r['timeout'] for r in rows)}, empty {sum(r['empty'] for r in rows)}")
print("\nBY KIND: n | median s | p90 s | max s | sum h | median answer chars | median hub steps")
g = collections.defaultdict(list)
for r in rows: g[r["kind"]].append(r)
for k, v in sorted(g.items(), key=lambda kv: -sum(r["seconds"] for r in kv[1])):
    s = sorted(r["seconds"] for r in v)
    print(f"  {k:22} {len(v):4} | {st.median(s):5.0f} | {s[int(.9*(len(s)-1))]:5.0f} | {s[-1]:5.0f} | {sum(s)/3600:5.2f} |"
          f" {st.median(r['answer_chars'] for r in v):7.0f} | {st.median(r['hub_steps'] for r in v):3.0f}")
print("\nDURATION vs ANSWER SIZE (successful calls)")
for lo, hi in [(0, 2e3), (2e3, 5e3), (5e3, 10e3), (10e3, 20e3), (20e3, 40e3), (40e3, 1e9)]:
    v = [r["seconds"] for r in ok if lo <= r["answer_chars"] < hi]
    if v: print(f"  answer {lo/1e3:3.0f}-{min(hi,99e3)/1e3:3.0f}k chars: {len(v):4} calls, median {st.median(v):5.0f} s")
print("\nDURATION vs HUB INTERNAL STEPS (narrated)")
for lo, hi in [(0, 1), (1, 2), (2, 3), (3, 5), (5, 99)]:
    v = [r["seconds"] for r in ok if lo <= r["hub_steps"] < hi]
    if v: print(f"  steps {lo}-{hi-1}: {len(v):4} calls, median {st.median(v):5.0f} s")
print("\nPARALLEL: median s when alone vs with others (simple table reads)")
for n in (0, 1, 2):
    v = [r["seconds"] for r in ok if r["parallel"] == n and r["kind"] in ("table read", "transport table read", "data dictionary")]
    if v: print(f"  {n} others running: {len(v):4} calls, median {st.median(v):5.0f} s")
print("\nSLOWEST 15 successful calls")
for r in sorted(ok, key=lambda r: -r["seconds"])[:15]:
    print(f"  {r['seconds']:6.0f} s  {r['kind']:20} ans {r['answer_chars']:6} ch, code {r['code_lines']:5} l, steps {r['hub_steps']}, par {r['parallel']}  {r['key'][:45]}")
print("written", out)
