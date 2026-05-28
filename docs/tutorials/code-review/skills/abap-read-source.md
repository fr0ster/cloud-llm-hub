---
name: abap-read-source
description: Read full ABAP source — main program plus every include — via ReadProgram / GetIncludesList / GetInclude before any code-review analysis. Call each tool exactly once per artifact. Never substitute or invent missing includes; if a read fails, stop and report the error.
---
