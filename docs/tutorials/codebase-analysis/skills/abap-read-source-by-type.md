---
name: abap-read-source-by-type
description: Load full ABAP source for a seed by object type. PROG → ReadProgram, then GetIncludesList (already recursive — one call), then GetInclude for every name returned. CLAS → ReadClass (self-contained, no includes step). INTF → ReadInterface (self-contained). FUGR → ReadFunctionGroup (already lists member includes — no separate GetIncludesList needed unless the response explicitly says extra reads are required).
---
