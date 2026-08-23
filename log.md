# Log

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
