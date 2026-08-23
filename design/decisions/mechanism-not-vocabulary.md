---
type: decision
title: "scribe owns the mechanism, not the vocabulary"
description: "An event code names something that happens in a product. A shared vocabulary would be the union of every product's events, and every service would carry the others' codes in its type."
status: draft
timestamp: 2026-08-21
---

# scribe owns the mechanism, not the vocabulary

scribe defines **two** event codes: `LOG_DROP` and `PAYLOAD`.
Both are the log writing about itself.
Every other code belongs to the service that emits it.

## Why the line falls there

An event code is an identity.
It is what a runbook cites, what a saved search matches, and what an alert fires on.
It names something that happens **somewhere**.

`ORDER_FAIL` means nothing in an identity service.
`AUTH_FAIL` means nothing in a checkout.
A shared vocabulary would be the union of every product's events, growing whenever any
of them learned a new one — and every service would carry the others' codes in its type,
so a typo would compile and a reviewer would be the only thing standing between a
mistake and a log nobody can search.

The mechanism is the opposite.
The ring buffer, the level gate, the flush timer, the identifier and the redaction rule
encode decisions that are as true in one service as another, and that a service has no
business having an opinion about.

**Shared mechanism, local vocabulary.**

## What it costs a consumer

Three lines, once.

```ts
import { SCRIBE_EVENTS, type Emitter, log as base } from "@concurrent-systems/scribe";

export const EVENTS = { ...SCRIBE_EVENTS, AUTH_OK: "AUTH_OK" } as const;
export type Event = (typeof EVENTS)[keyof typeof EVENTS];
export const log = base as Emitter<Event>;
```

scribe cannot know the set, so `log` accepts any string.
The cast narrows it back, and a mistyped code is a compile error again.

That cast is the only ceremony in the design, and it was worth preserving:
the alternative — `log.info("AUTH_OKK")` compiling — turns a typo into a record nobody
finds, in the file somebody is reading during an incident.

## What was rejected

**A generic `initLog<E>()` returning an emitter.**
The log is a module-level singleton, deliberately: a service has one, and threading an
instance through every function that might log is the change to unrelated code this
design exists to avoid.

**Codes as plain strings, with no type at all.**
Simplest, and it gives up the one guarantee that matters. A vocabulary nothing checks
drifts into two spellings of the same event, which is discovered by the person who
searched for the wrong one.

**A registry a product calls at startup to declare its codes.**
Runtime validation of something a type can prove, plus a startup ordering problem.
