---
name: Composition vs Association
description: RAP modeling rule — composition for owned children, association for references to another BO, and the master/dependent consequence
tags: [sap, rap, modeling, composition, association]
---

# Composition vs Association

Two ways to relate RAP entities. Choosing wrong flips the object graph and the
authorization model.

## The rule

- **Composition** = ownership. The child has no life of its own; it is created, read,
  and deleted as part of its parent. The parent **composes** the child. Example: a Book
  owns its Editions and Ratings.
- **Association** = reference. The target is an independent BO with its own lifecycle;
  you only point at it. Example: a Book references its Author — the Author is a separate
  BO, not owned by the Book.

## Consequence: master / dependent

- The composition **root** carries `lock master`; composed children carry
  `lock dependent by <parent association>`. This lock model is mandatory — a child's
  lock derives from the root.
- Instance authorization (`authorization master` / `authorization dependent by <assoc>`)
  is a **separate, optional** declaration with the same shape — add it only when you need
  instance-level authorization; it is not the same thing as the lock model.
- An associated BO is its own root (its own `lock master`), reached by association, never
  `dependent` on the referencing BO.

## Decide by asking

"If I delete the parent, should this disappear too?" Yes → composition (child).
No, it lives on independently → association (separate BO).

## Common mistakes

| Symptom | Means | Fix |
|---------|-------|-----|
| Author composed from Book | Independent BO modeled as a child | Make Author a separate BO; Book → Author is an association |
| Both root and child declared `lock master` | Lock model mis-modeled | Root `lock master`, children `lock dependent by <assoc>` |
| Child rows orphaned after parent delete | Reference modeled as composition | Use association if the target is independent |
