# CLAUDE.md

Guidance for Claude Code working in this repository.

## Where the knowledge lives

This repo is an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle rooted at [`index.md`](index.md) — read that first. The spine is lowercase and
unfrontmattered ([`index.md`](index.md), [`plan.md`](plan.md), [`log.md`](log.md),
newest first); everything else is a typed concept.

Never add a doc without adding its line to the level's `index.md` in the same change.

## What scribe is

A structured operational log for Bun and Node. One line per record, six fields, one
identifier, buffered and flushed off the request path.

**scribe owns the mechanism, not the vocabulary.** Event codes belong to the product
that emits them: `ORDER_FAIL` means nothing in an identity service and `AUTH_FAIL` means
nothing in a checkout. scribe defines exactly two codes — `LOG_DROP` and
`PAYLOAD`, the log writing about itself — and `Emitter<E>` so a product narrows the
type back at its own boundary.

**Adding a product's event code here is the one change that is always wrong.**

## The stack

Bun, TypeScript, `bun test`, Biome. No dependencies at all — not a design goal that was
reached, a constraint: this is loaded by every service, so anything it depends on, they
all depend on.

```bash
bun install
bun test
bun run lint         # strict: every Biome group at recommended, nothing switched off
bun run typecheck
```

## The rules that are not up for re-litigation

Each is a decision with a note in [`design/decisions/`](design/decisions/index.md). Read
the note before changing the thing.

- **Nothing on the request path allocates.** The level gate is the first statement in
  `emit`, before the clock, the context lookup or the object.
- **A field is a scalar, by type.** `Fields` is `string | number | boolean | null |
  undefined` and not `unknown`. The day a field can nest, the recursive sanitiser, the
  depth cap, the cycle guard and the unbounded record all come back.
- **Nothing is serialised at call time.** Formatting happens in the flush timer, on a
  batch, in one `writeSync`.
- **The newest record is dropped, not the oldest.** The start of a burst is what
  explains it.
- **An unrecognised setting falls back.** A typo in `LOG_LEVEL` must never stop a
  service from starting.
- **A secret-shaped field name is redacted**, in both formats. Consumers include the
  service that holds the credentials.

## Consumers

Anything that loads scribe, in any repository. A change here reaches every one of them at
its next install, which is the reason for the strict lint and the test count — and the
reason a breaking change needs a new version, never a move of an existing one.
