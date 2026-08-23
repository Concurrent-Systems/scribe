---
type: requirements
title: "What the log must do, and what it must never do"
description: "The record, the levels, the settings and the prohibitions — stated so each can be shown to be met, and so a consumer knows what it is relying on."
status: draft
timestamp: 2026-08-21
---

# What the log must do

scribe is loaded by every service.
That is the whole argument for stating its requirements rather than leaving them in the code:
a consumer relies on properties it cannot see, and a change here reaches all of them at once.

A consuming service states what *it* must record, in its own requirements.
This page states what the log itself must do, for anyone.

## The record

```
2026-08-21T14:03:11.482Z|INFO |checkout |01a02443eaf5c9580d12|ORDER_OK   |org=7 items=6 ms=7
```

| Field | Width | What it is |
|---|---|---|
| Timestamp | 24 | ISO-8601, milliseconds, UTC |
| Level | 5 | Padded, so the column is fixed |
| Component | 9 | The service, padded or truncated |
| Transaction | 20 or 0 | The identifier of the request, empty outside one |
| Event | 11 | A code, padded — an identity, not a message |
| Detail | ≤512 | `key=value` pairs, scalars only |

## Levels

| Level | What belongs at it |
|---|---|
| `fatal` | The service cannot continue and is exiting. |
| `error` | A request failed for a reason that is the service's fault. |
| `warn` | Something is wrong but was survived. |
| `info` | The outcome of a request. The default, and what an operator reads. |
| `debug` | Which check produced the outcome. |
| `trace` | The data crossing a boundary. |

## Settings

All read once, at `initLog`, from the environment.

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Threshold. |
| `LOG_FORMAT` | `text` | `text` or `json`. |
| `LOG_BUFFER` | `4096` | Records held before dropping begins. |
| `LOG_FLUSH_MS` | `50` | How often the buffer is written. |
| `LOG_PAYLOAD` | `error` | `off`, `error`, or `all`. |

## Requirements

| # | Requirement | State |
|---|---|---|
| L1 | One record is one line. No field value can break a record apart, whatever it contains. | Met |
| L2 | Columns are fixed width, so a file reads as a table and a collector can cut a field without a parser. | Met |
| L3 | A record carries the identifier of the request that caused it, so records from different services can be laid side by side. | Met |
| L4 | The identifier is minted at the boundary and never adopted from a caller's header. A caller's own reference may be recorded, never trusted. | Met |
| L5 | A record has a bounded size. No caller-supplied string can run away with the log. | Met |
| L6 | **A field whose name looks like a secret is redacted**, in every format. | Met |
| L7 | Nothing is allocated below the level threshold. The gate is the first statement, before the clock and before the context lookup. | Met |
| L8 | Nothing is serialised at call time. Formatting happens at flush, on a batch. | Met |
| L9 | A batch is written in one system call. | Met |
| L10 | A full buffer drops the **newest** record, not the oldest, and says how many it lost. | Met |
| L11 | An unrecognised setting falls back to the default rather than throwing. | Met |
| L12 | A `fatal` or `error` record is written immediately, after the records that lead up to it, so the order on disk is the order of events. | Met |
| L13 | Records still buffered at a clean exit are written. | Met |
| L14 | scribe has no dependencies. | Met |
| L15 | scribe defines no event code that names something happening in a product. | Met — two codes, both about the log itself. |
| L16 | A consumer gets a compile error on an event code it has not defined. | Met — `Emitter<E>`. |
| L17 | The cost of a suppressed record is under 50 ns, and of a written one under 100 ns. | Met — measured at 11 ns and 24 ns by `tests/logBench.test.ts`. |
| L18 | The level can be changed on a running process, without a restart. | Met — `setLevel()`. |
| L19 | Changing the level to a name scribe does not know leaves the threshold where it was. | Met |
| L20 | scribe does not decide how a service exposes level control. | Met — no route, no signal handler, no socket. |

## The prohibitions

Three things scribe must never do.
Each is stated as a prohibition because being wrong about it is not an inconvenience.

**A field must never be an object.**
`Fields` is typed as scalars, not `unknown`.
An object would bring back the recursive sanitiser, the depth cap, the array cap, the
cycle guard and the unbounded record — none of which need to exist if a value cannot nest.
This is enforced by the type, not by review.

**A secret must never reach a file.**
Consumers include the service that holds the credentials.
A log file is copied, shipped to a collector, read by support, and kept longer than
anyone intended; a password that reaches one has been published, and no later fix
un-publishes it.
Redaction is by field name, in both formats, and is tested in both.

**A log setting must never stop a service from starting.**
`LOG_LEVEL=inof` is a typo somebody makes during a deploy.
Falling back and logging at the default is a worse outcome than nothing only if the
alternative is not "the service does not come up".
