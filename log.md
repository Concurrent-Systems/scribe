# Log

## 2026-09-13 — pins exact at the fleet's versions

- **Every development dependency is exact.**
  Bun and `@types/bun` are 1.4.2, `@biomejs/biome` is 2.5.13, and `typescript` is 7.0.2.
  A caret range lets a fresh install choose a different linter or type checker from an old one.
- **Every action is on a commit**, with its tag in a trailing comment.
- **`scripts/check-pins.sh` runs in CI**, copied from billet-component.
  It permits `setup-node` in `publish.yml` only,
  because trusted publishing and provenance need the npm client.
- No version change: the package stays at 1.0.0.

## 2026-08-23 — v1.0.0

- **First release.** A structured operational log for Bun and Node: one line per
  record, six fields, one identifier, buffered and flushed off the request path.
- **Published to npm** as `@concurrent-systems/scribe`, from a GitHub release,
  with provenance — [the registry is the package](design/decisions/published-to-npm.md).
- **The package ships both forms.** Bun resolves `src/`, Node and bundlers
  resolve `dist/`.
- **scribe owns the mechanism, not the vocabulary.** It exports two event codes
  of its own and `Emitter<E>`, so a consumer narrows the type to its own —
  [why](design/decisions/mechanism-not-vocabulary.md).
- **87 tests, strict lint, zero dependencies**, all three run on every push.
