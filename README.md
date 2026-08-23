<div align="center">

# scribe

**The one who writes down what happened.**

A structured log with a fixed shape, a transaction identifier, and a cost you can measure in nanoseconds.

`11 ns` suppressed · `24 ns` written · zero dependencies · Bun & Node

</div>

```
2026-08-21T14:03:11.482Z|INFO |checkout |01a02443eaf5c9580d12|ORDER_OK   |org=7 items=6 total=249.90 ms=7
└──────── when ────────┘ └lvl┘ └─ who ─┘ └─ which request ──┘ └─ what ──┘ └───────── detail ───────────┘
```

Six fields. One line. Every service.

---

## Why it looks like that

Nobody reads one service.
They read a failure that crossed four of them at 03:00, and the only thing that makes that possible
is every service writing the same shape with the same identifier in the same column.

So the format is not a preference. It is the whole point.

- **Fixed columns** — `cut -d'|' -f5` works. So does reading it down the page.
- **One record, one line** — no value can break a record apart, whatever a caller puts in it.
- **A transaction identifier in every record**, minted at the edge, propagated inwards. `grep 01a02443eaf5c9580d12 *.log` is the whole investigation.
- **Time-ordered identifiers** — `sort` is chronological. No extra key, no random B-tree writes.

## Install

```bash
bun add @concurrent-systems/scribe
```

## Use

```ts
// lib/log.ts — your vocabulary, once
import { SCRIBE_EVENTS, type Emitter, log as base } from "@concurrent-systems/scribe";

export const EVENTS = {
  ...SCRIBE_EVENTS,
  ORDER_OK:   "ORDER_OK",
  ORDER_FAIL: "ORDER_FAIL",
  PAY_DECLINE:"PAY_DECLINE",
} as const;

export type Event = (typeof EVENTS)[keyof typeof EVENTS];
export const log = base as Emitter<Event>;
```

```ts
// app.ts
import { initLog, initPayloads, newTxnId, runWithTxn } from "@concurrent-systems/scribe";
import { EVENTS, log } from "./lib/log.ts";

initLog({ component: "checkout" });
initPayloads();

app.use((c, next) =>
  runWithTxn({ txn: newTxnId(), startedAt: performance.now(), body: await c.req.text() }, next),
);

log.info(EVENTS.ORDER_OK, { org, items, total, ms });
```

Every record inside that request now carries the same identifier, with no argument threaded anywhere.

## Naming your events

An event code is an **identity, not a message**.
It is what a runbook cites, what a saved search matches, and what an alert fires on —
so it has to survive any rewording of the human explanation beside it.
You can change the sentence. You cannot change the code.

Five rules, and the fifth is the one people skip:

1. **`SUBJECT_VERB`** — the thing, then what happened to it.
2. **Ten characters at most**, so the column stays fixed.
3. **Group by subject, not by service.** If a payment is observed in two services, both write `PAY_TAKEN`.
   Which service it was is already in the component column.
4. **One code per *outcome*, not per branch.** A wrong password and an unknown address are one
   `AUTH_FAIL` with the reason in a field — the response does not distinguish them, so neither should
   the record a support engineer pastes into a ticket.
5. **The key and the value are the same string.** `ORDER_OK: "ORDER_OK"`.
   Then grepping the source for a code you found in a log file lands you on the line that wrote it.

```ts
export const EVENTS = {
  ...SCRIBE_EVENTS,

  // ── Service lifecycle ──────────────────────────────────────────────
  /** Listener is up and accepting traffic. Carries port and version. */
  SRV_START:   "SRV_START",
  /** Shutdown signal received; draining has begun. */
  SRV_STOP:    "SRV_STOP",

  // ── The order, wherever it is observed ─────────────────────────────
  /** An order arrived and was given its identifier. */
  ORDER_RECV:  "ORDER_RECV",
  /** The canonical record for one order: items, total, elapsed. */
  ORDER_OK:    "ORDER_OK",
  /** The order failed. The caller received an error. */
  ORDER_FAIL:  "ORDER_FAIL",
  /**
   * Nothing was in the basket, so nothing happened.
   *
   * Worth its own code: an empty basket is otherwise a 200 with nothing
   * written anywhere, and it is the most common "checkout does nothing" report.
   */
  ORDER_EMPTY: "ORDER_EMPTY",

  // ── Payment ────────────────────────────────────────────────────────
  /** Funds captured. */
  PAY_TAKEN:   "PAY_TAKEN",
  /** The issuer declined. Reason in a field, never in the code. */
  PAY_DECLINE: "PAY_DECLINE",
  /** The gateway could not be reached; the order is unresolved. */
  PAY_NOGW:    "PAY_NOGW",
} as const;
```

Two of those deserve the attention:

**`ORDER_EMPTY` earns a code because "nothing happened" is a result.**
The single most common support report on any system is *it did nothing* — and the one path that
writes no record at all is the one nobody can investigate. Give the quiet outcome a name.

**`PAY_NOGW` is not `PAY_DECLINE`.**
One means the answer was no; the other means there is no answer. Collapsing them looks tidy and
loses the distinction between a customer who was refused and money that may or may not have moved.

## The parts you will care about at 03:00

### Change the level without a restart

```ts
setLevel("debug");   // → "debug"
```

A restart destroys the thing you were investigating: the process that was misbehaving is gone,
and the next one behaves. Turning `debug` on for ninety seconds on the node that is *actually wrong*
is how the interesting record gets written at all.

scribe does not decide how you reach this — a route behind an internal secret, a signal, an admin socket.
Your service knows what surface it can safely expose; a log library guessing that for you would be
the library making a security decision on your behalf.

### Payloads, captured for everything, written for failures

The request body is the highest-value artefact there is — with it the whole transaction can be reconstructed —
and the worst possible thing to put in a log stream. It is unbounded, it is where the user's data is,
and it dwarfs everything else by more than an order of magnitude.

So scribe **holds** the body (one pointer, no copy, no serialisation) and **writes** it only if the
transaction fails, to its own file, with its own retention and its own permissions.

100% capture for exactly the transactions anyone will ever investigate. Nothing on the request path for the rest.

A payload record carries the transaction identifier, the tenant and the outcome. Anything else an
operator would search by goes in `tags`, and is written verbatim:

```ts
runWithTxn({ txn: newTxnId(), startedAt: performance.now(), body, tags: { sku, channel } }, next);
```

A tag that collides with a key scribe writes itself is ignored, so no caller can choose its own identity.

### Secrets do not reach the file

A field whose *name* looks like a credential is redacted, in both formats, before anything is written.

```ts
log.info(EVENTS.ORDER_OK, { password: "hunter2" });
// …|ORDER_OK   |password=[REDACTED]
```

A log file is copied, shipped to a collector, read by support and kept far longer than anyone intended.
A password that reaches one has been published, and no later fix un-publishes it.

## Settings

Read once at `initLog`, from the environment, so an operator can change them without a deploy.
**An unrecognised value falls back rather than throwing** — a typo in a log setting must never stop a
service from starting, least of all mid-deploy.

| Variable | Default | |
|---|---|---|
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` |
| `LOG_FORMAT` | `text` | `text` or `json` |
| `LOG_BUFFER` | `4096` | Records held before the newest are dropped |
| `LOG_FLUSH_MS` | `50` | How often the buffer is written |
| `LOG_PAYLOAD` | `error` | `off` · `error` · `all` |

`initLog({ level, format, fd })` overrides all of it — which is how a test pins it.

## Rotation

Don't. scribe writes to a descriptor and never opens a log file itself, so rotation belongs to
whatever is already supervising the process: **journald** (`SystemMaxUse=`) under systemd, or the
container runtime's log driver (`max-size`, `max-file`) under Docker.

`logrotate` against a file a process holds open is the classic footgun — renaming the file does not
move the process's file descriptor, so it keeps writing to the renamed inode forever.

## What it costs

```
log emission: disabled 11 ns · enabled 24 ns · in context 25 ns
```

Four properties, in the order they matter:

1. **The gate is the first statement.** A suppressed record costs one integer comparison and a return — no object, no clock, no context lookup.
2. **Nothing is serialised at call time.** Formatting a timestamp, padding a column, building `key=value` — all of it happens later, in a timer, on a batch.
3. **Fields are scalars, by type.** Not `unknown`. That deletes the recursive sanitiser, the depth cap, the cycle guard and the unbounded record — none of which need to exist if a value cannot nest.
4. **One write per batch.** A flush concatenates and issues a single `writeSync`.

> **One rule for callers:** the `fields` object is read at flush time, not at call time. Pass a literal.
> A long-lived object mutated afterwards logs the later value.

## Design notes

This repository is an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle — markdown with frontmatter, an index per level, navigable by relative links.

| | |
|---|---|
| [`requirements/`](requirements/index.md) | What the log must do, and the three things it must never do |
| [`design/decisions/`](design/decisions/index.md) | Why it is built this way |
| [`plan.md`](plan.md) · [`log.md`](log.md) | What is next, and what happened |

Two worth reading:
[scribe owns the mechanism, not the vocabulary](design/decisions/mechanism-not-vocabulary.md) —
why your event codes are yours, and
[the registry is the package](design/decisions/published-to-npm.md).

## Contributing

`bun install && bun test`. 87 tests, strict lint, no dependencies — and the last of those is a
constraint, not an achievement: every service loads this, so anything scribe depends on, they all do.

MIT.
