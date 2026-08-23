/**
 * Transaction payloads: captured for every transaction, written only for the
 * ones that fail.
 *
 * ## Why payloads are not log records
 *
 * A payload is the highest-value artefact there is — with it, the whole
 * transaction can be reconstructed — and it is also the worst thing to put in a log
 * stream. It is where the user's data is, it is unbounded, and it dominates
 * volume — measured on real traffic, records carrying payloads outweighed every
 * other record by more than an order of magnitude, in both lines and bytes.
 * Those two facts stop being in tension once payloads stop being log records
 * and become their own artefact, with their own file, their own retention and
 * their own permissions.
 *
 * ## Why capture is free
 *
 * The naive options are all bad. Logging every payload costs the volume above.
 * Sampling gives the shape of traffic and never the transaction anybody asks
 * about. Turning a debug flag on after the fact cannot capture a failure that
 * has already happened, which is the only kind there is.
 *
 * What works is to **hold the body and write it only on failure**. The request
 * text already exists as a string at the boundary — keeping a reference to it
 * costs one pointer for the life of the transaction and nothing else. No
 * serialisation, no copy, no formatting, nothing on the request path.
 * Serialising happens in the failure path, which by definition is not hot.
 *
 * The result is 100% payload capture for exactly the transactions anyone will
 * ever investigate, and zero cost for the rest.
 *
 * ## Why the body as it arrived, not the object
 *
 * A service that mutates the parsed request — many do, by design — leaves an
 * object that serialises later as the state *after* the work ran, wearing the
 * name of the input. The raw text is immutable and is what the caller actually
 * sent, so it is what makes a failure reproducible.
 *
 * ## Modes
 *
 * | `LOG_PAYLOAD` | Behaviour                                                    |
 * | ------------- | ------------------------------------------------------------ |
 * | `off`         | Nothing captured or written.                                 |
 * | `error`       | **Default.** Written only for a transaction that failed.     |
 * | `all`         | Written for every transaction. Deliberate and time-boxed.    |
 *
 * `all` exists for "reproduce this now, for this customer, for ten minutes".
 * It is not a steady-state setting and the volume table above is why.
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentTxn } from "./context.ts";
import { SCRIBE_EVENTS } from "./events.ts";
import { log } from "./log.ts";

export type PayloadMode = "off" | "error" | "all";

const REDACT_KEY = /pass|secret|token|key|auth|credential/i;
const REDACTED = "[REDACTED]";

let mode: PayloadMode = "error";
let dir = "";
let maxBytes = 16_384;
/** Set once a write has failed, so a broken destination reports once, not per transaction. */
let disabled = false;

export interface PayloadOptions {
  /** Overrides `LOG_PAYLOAD`. */
  mode?: PayloadMode;
  /** Overrides `LOG_PAYLOAD_DIR`. */
  dir?: string;
  /** Overrides `LOG_PAYLOAD_MAX_BYTES`. */
  maxBytes?: number;
}

function parseMode(raw: string | undefined): PayloadMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "all" ? v : "error";
}

export function initPayloads(options: PayloadOptions = {}): void {
  mode = options.mode ?? parseMode(process.env.LOG_PAYLOAD);
  dir = options.dir ?? process.env.LOG_PAYLOAD_DIR ?? join(process.cwd(), "logs", "payloads");
  const raw = options.maxBytes ?? Number(process.env.LOG_PAYLOAD_MAX_BYTES ?? 16_384);
  maxBytes = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 16_384;
  disabled = false;
}

/** True when a body is worth holding a reference to. */
export function capturing(): boolean {
  return mode !== "off" && !disabled;
}

/**
 * Mask secret-shaped values in a JSON body.
 *
 * Runs only on the failure path, so the parse is affordable. A body that will
 * not parse — most often because it is what caused the failure — falls back to
 * a raw sweep for the same key set, which over-redacts in odd cases. That is
 * the correct direction to be wrong in.
 */
export function redactBody(body: string): string {
  try {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = REDACT_KEY.test(k) ? REDACTED : walk(val);
        }
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(JSON.parse(body)));
  } catch {
    return body.replace(
      /("(?:[^"]*(?:pass|secret|token|key|auth|credential)[^"]*)"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
      `$1${REDACTED}$2`,
    );
  }
}

/** `payloads-YYYY-MM-DDTHH.jsonl` — one file per hour, from the record's own time. */
function fileFor(ts: string): string {
  return join(dir, `payloads-${ts.slice(0, 13).replace(":", "")}.jsonl`);
}

/**
 * Write the ambient transaction's body, if there is one and the mode calls for it.
 *
 * `outcome` is `"error"` for a transaction that failed and `"ok"` otherwise;
 * in the default mode only the first is written.
 *
 * Never throws. A payload is a diagnostic, and a diagnostic that can fail a
 * transaction is worse than no diagnostic.
 */
export function writePayload(outcome: "ok" | "error", fields?: Record<string, string | number>): void {
  if (disabled || mode === "off") return;
  if (mode === "error" && outcome !== "error") return;
  const ctx = currentTxn();
  if (ctx?.body === undefined) return;

  try {
    const ts = new Date().toISOString();
    const body = redactBody(ctx.body);
    const truncated = body.length > maxBytes;
    const record = JSON.stringify({
      // The consumer's keys first, so nothing here can overwrite what
      // scribe writes about the transaction itself.
      ...ctx.tags,
      ts,
      txn: ctx.txn,
      ref: ctx.ref,
      org: ctx.organizationId,
      outcome,
      ...fields,
      bytes: ctx.body.length,
      truncated: truncated || undefined,
      body: truncated ? body.slice(0, maxBytes) : body,
    });

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = fileFor(ts);
    appendFileSync(path, `${record}\n`, { mode: 0o600 });
    // Re-applied each time: `appendFileSync`'s mode only takes effect when it
    // creates the file, and a pre-existing file from an earlier release may be
    // world-readable.
    chmodSync(path, 0o600);

    // The operational log records that a payload exists, never what is in it.
    // One field, so `grep PAYLOAD` lists every transaction that can be replayed.
    log.info(SCRIBE_EVENTS.PAYLOAD, { bytes: ctx.body.length, truncated: truncated || undefined });
  } catch (err) {
    disabled = true;
    log.warn(SCRIBE_EVENTS.PAYLOAD, { disabled: true, reason: (err as Error).message });
  }
}
