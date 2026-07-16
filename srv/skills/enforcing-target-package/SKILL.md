---
name: enforcing-target-package
description: Create this ABAP object in the package the caller specified for the step, not a default or guessed package, and verify it landed there afterward
---

# Enforcing the target package

Every object-creation step names a target package. That package is a hard constraint on the
step, not a suggestion.

## The rule

- Use the exact package the caller specified for **this** object. Don't fall back to a personal
  `$TMP`/local package, don't reuse a package seen in an earlier unrelated step, and don't invent
  one because none was given — if no package was specified, that's missing information, not a
  license to default.
- This is a per-step rule: each object-creation call carries its own target package, even when a
  batch of steps targets the same package overall. Confirm it on every create, don't assume it
  carries over silently.
- After creating the object, verify it actually landed in the requested package (not just that
  creation succeeded) — a wrong-package create can still return success.

## Common mistake

| Symptom | Fix |
|---|---|
| Object created in `$TMP` or a default package | Package wasn't passed through to the create call — pass it explicitly |
| Object created in the wrong package from a previous step | Package isn't implicitly inherited across steps — pass this step's own target package |
