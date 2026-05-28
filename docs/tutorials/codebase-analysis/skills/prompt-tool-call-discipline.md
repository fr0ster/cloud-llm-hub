---
name: prompt-tool-call-discipline
description: 'Two rules for any prompt that drives more than one tool call. (1) Number the steps and append "do each step exactly ONCE" plus "do not call any tool more than once with the same arguments" — without this guard the model can loop on a single tool (observed: 30+ identical GetIncludesList calls with no GetInclude ever firing). (2) If the model claims a tool is unavailable, add a POSITIVE assertion to the prompt: "You have the tool X. It is available. Call X(…)." Never use negative phrasings ("Do not use Y", "Y is not available") — they leak the wrong tool name into context and can trigger the same failure.'
---
