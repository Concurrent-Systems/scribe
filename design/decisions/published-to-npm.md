---
type: decision
title: "The registry is the package"
description: "scribe is published to npm under a version number, built for Node and read as source under Bun."
status: accepted
timestamp: 2026-08-23
---

# The registry is the package

```bash
bun add @concurrent-systems/scribe
```

A consumer names a semver range.
A version is a fact a release manifest can name,
and a published version cannot be moved after the fact.

## What is in the package

Both forms, and the `exports` map decides which one a consumer gets:

| Consumer           | Resolves to                                |
|--------------------|--------------------------------------------|
| Bun                | `src/index.ts` — the TypeScript, as source |
| Node, or a bundler | `dist/index.js` and `dist/index.d.ts`      |

Source is written with `.ts` on its relative imports, which Bun reads directly and Node cannot.
A Bun consumer resolves the source for types as well as at runtime,
so what TypeScript checks against is what Bun actually runs.
That also means a git ref installs and works without a build step,
which a `dist/` in `types` would not: build output is not committed.
Bun gets the source because it can read it,
and because a stack trace that points at the line you can read is worth more than a build artifact.

## How it is published

From a GitHub release, never from a laptop.
The publish workflow runs the same lint, typecheck and test gate that every push runs,
and npm records which commit and which workflow produced the tarball.

**The tag and `package.json` must agree.**
The workflow refuses a release whose tag does not match the version in the repository.
Publishing a mismatch burns a version number that can never be reused.

**A breaking change gets a new version, never a move of an existing one.**
A moved tag means two builds of the same commit behave differently,
and nothing in the lockfile says so.
