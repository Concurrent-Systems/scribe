/**
 * scribe — a structured operational log for Bun and Node.
 *
 * ```
 * 2026-08-21T14:03:11.482Z|INFO |checkout |01a02443eaf5c9580d12|ORDER_OK   |org=7 items=6 ms=7
 * ```
 *
 * One line per record, six fields, one identifier. An operator does not read
 * one service — they read a failure that crosses several — and the only way to
 * lay those records side by side is for every service to write the same shape.
 *
 * ```ts
 * import { EVENTS } from "./events.ts";        // yours
 * import { initLog, initPayloads, log } from "@concurrent-systems/scribe";
 *
 * initLog({ component: "checkout" });
 * initPayloads();
 * log.info(EVENTS.ORDER_OK, { org, items, ms });
 * ```
 *
 * **scribe owns the mechanism, not the vocabulary.** Your event codes are
 * yours; see [`events.ts`](events.ts) for how to keep them type-safe, and
 * [the contract](../requirements/observability.md) for what each part of the
 * record is for and why.
 */

export { currentTxn, elapsedMs, runWithTxn, type TxnContext } from "./context.ts";
export { EVENT_WIDTH, type Event, SCRIBE_EVENTS } from "./events.ts";
export { isTxnId, newTxnId, TXN_HEADER, TXN_ID_LENGTH, txnIdTime } from "./id.ts";
export {
  closeLog,
  currentLevelName,
  type Emitter,
  type Fields,
  flushLog,
  initLog,
  isEnabled,
  type Level,
  type LogOptions,
  log,
  logStats,
  setLevel,
} from "./log.ts";
export { capturing, initPayloads, type PayloadMode, type PayloadOptions, redactBody, writePayload } from "./payload.ts";
