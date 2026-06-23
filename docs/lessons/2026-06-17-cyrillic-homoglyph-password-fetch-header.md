---
date: 2026-06-17
branch: main
subaccount: nvcr
space: cloud-llm-hub
tags: [credentials, chat-ui, fetch, unicode]
---

# Chat login fails on ONE system with "non ISO-8859-1 code point" — Cyrillic homoglyph password

The chat UI showed `> SYSTEM: Connected to CR2 as ext_okyslyts`, then the first
request failed with:

```
Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property
from 'RequestInit': String contains non ISO-8859-1 code point.
```

The same login worked fine on **other** SAP systems. First instinct ("CR2 is a
non-Unicode system") was wrong — the error has nothing to do with the SAP
backend's code page.

## Why

The login gate sends SAP credentials as HTTP **headers**
(`X-SAP-Login` / `X-SAP-Password`, see `app/chat/webapp/index.html` →
`getSapCredHeaders()`). Browser `fetch()` enforces that header values be
**ISO-8859-1 (Latin1, codepoints 0–255)**. Any character ≥ U+0100 makes
`fetch` throw the error above — *before* the request ever leaves the browser.

The password was typed with the **Ukrainian keyboard layout**. Cyrillic
homoglyphs (`а`=U+0430, `е`=U+0435, `о`=U+043E, `с`=U+0441, `р`=U+0440,
`х`=U+0445, …) are visually identical to Latin `a e o c p x` but have codepoints
> 255. So the password *looked* like pure Latin, eyeball checks said "тіки
латиниця", yet `fetch` rejected it.

- **Why only CR2:** on other systems the password was typed with the Latin (EN)
  layout → all chars within Latin1 → `fetch` accepts them.
- **Why it slips past inspection:** homoglyphs are indistinguishable by sight.
  Only a programmatic check catches them:
  ```js
  [...password].filter(c => c.charCodeAt(0) > 255)
  ```
- **Red herring:** the Cyrillic *prompt text* ("Прочитай останні дампи…") is
  fine — it travels in the JSON **body**, where Unicode is allowed. Only the
  header-borne credentials are constrained.
- **"Connected to …" is cosmetic:** `submitLoginGate()` only stores the creds
  in JS and prints the line; it does **not** validate against SAP. So
  "Connected" never meant the request succeeded.

## Fix

Re-enter the password on CR2 with the **Latin (EN)** keyboard layout.

## Prevention rule

- A per-system "works everywhere except system X" credential error is a
  **client-side header-encoding** smell, not a backend code-page issue. Check
  the raw bytes of the credential (`charCodeAt > 255`) before blaming SAP.
- Do **not** add a hard Latin1 block to the login gate: some SAP systems accept
  genuine Unicode passwords, and a blanket block would break them. If we ever
  harden this, the correct path is base64(UTF-8) encoding of the credential
  headers on the client **and** decoding on the server
  (`srv/lib/request-connection.ts`, `srv/mcp-manager.ts`) — a coordinated
  client+server change, not a UI-only guard.
