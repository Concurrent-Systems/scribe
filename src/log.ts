/**
 * The operational log: one line per record, six fields, written off the
 * request path.
 *
 * ```
 * 2026-08-21T14:03:11.482Z|INFO |checkout |01a02443eaf5c9580d12|ORDER_OK   |org=7 items=6 total=249.90 ms=7
 * ```
 *
 * ## What makes it cheap enough to sit on a request path
 *
 * Four properties, in the order they matter:
 *
 * 1. **The gate is the first statement.** A record below the threshold costs one
 *    integer comparison and a return — no object, no clock, no context lookup.
 * 2. **Nothing is serialised on the request path.** The call captures values
 *    that already exist and hands them on. Formatting a timestamp, padding a
 *    column, building `key=value`, and the write itself all happen later, in a
 *    timer, on a batch. Moving only the *write* off the path and leaving the
 *    formatting on it would move almost nothing, because the formatting is the
 *    expensive half.
 * 3. **Fields are scalars.** Not objects, by type. That removes the recursive
 *    sanitiser, the depth cap, the array cap, the circular-reference guard and
 *    the unbounded line — none of which need to exist if a value cannot nest.
 *    Payloads have their own path; see `payload.ts`.
 * 4. **One write per batch.** A flush concatenates its records and issues a
 *    single `writeSync`, rather than one system call per record.
 *
 * ## Why `writeSync`, on a hot-path-adjacent module
 *
 * Because it never runs on the hot path. Node writes to a pipe asynchronously
 * but to a **regular file synchronously**, so `process.stdout.write` is a
 * blocking system call whenever a service unit redirects output to a file — a
 * hazard that appears in the deployment, not in the code. Doing the write
 * synchronously *from the flush timer* makes the behaviour identical for every
 * destination, keeps records in order, and removes any question of data sitting
 * in a stream buffer at exit.
 *
 * ## The one rule a caller has to know
 *
 * The `fields` object is read at flush time, not at call time. Pass a literal.
 * Passing a long-lived object that is mutated afterwards logs the later value.
 */

import { writeSync } from "node:fs";
import { currentTxn } from "./context.ts";
import { EVENT_WIDTH, type Event, SCRIBE_EVENTS } from "./events.ts";

/** Severity. One threshold, set by the operator; see `requirements/observability.md`. */
export type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const RANK: Record<Level, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/** Rendered level, pre-padded so the column is fixed without work at flush. */
const LABEL: Record<Level, string> = {
  fatal: "FATAL",
  error: "ERROR",
  warn: "WARN ",
  info: "INFO ",
  debug: "DEBUG",
  trace: "TRACE",
};

/**
 * What a field may hold. Deliberately not `unknown`.
 *
 * An object here would reintroduce every problem this module exists to avoid:
 * serialisation cost on the request path, unbounded record size, and a walk
 * that has to defend against getters, cycles and BigInt.
 */
export type Fields = Record<string, string | number | boolean | null | undefined>;

interface Entry {
  ms: number;
  level: Level;
  event: string;
  txn: string;
  fields?: Fields;
}

// ── Limits ─────────────────────────────────────────────────────────────────
// Each one turns a requirement into something the code cannot violate rather
// than something a reviewer has to notice.
const MAX_VALUE = 200; // one value
const MAX_DETAIL = 512; // the whole sixth field
const MAX_FIELDS = 16;
const REDACTED = "[REDACTED]";
const SECRET_KEY = /pass|secret|token|key|auth|credential/i;
/**
 * The separator, and anything that would break "one record, one line".
 *
 * `\p{Cc}` is every control character rather than a hand-written range, so a
 * newline, a tab and a stray C1 byte are all covered by one rule (R42, R43).
 */
const UNSAFE = /[|\p{Cc}]/gu;

/** A value carrying either of these would break `key=value` splitting. */
const NEEDS_QUOTE = /[ ']/;
/** Stripped inside a quoted value, so the quote cannot be closed early. */
const QUOTE = /'/g;

// ── Configuration, resolved once ───────────────────────────────────────────
let threshold = RANK.info;
let format: "text" | "json" = "text";
let component = "-";
let componentPad = "-        ";
let fd = 1;

// ── The buffer ─────────────────────────────────────────────────────────────
let cap = 4096;
let buf: (Entry | undefined)[] = new Array(cap);
let head = 0;
let count = 0;
let dropped = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function parseLevel(raw: string | undefined, fallback: number): number {
  const v = (raw ?? "").trim().toLowerCase();
  // An unrecognised value falls back rather than throwing: a typo in an
  // environment variable must never stop a service from starting.
  return v in RANK ? RANK[v as Level] : fallback;
}

export interface LogOptions {
  /** Name in the third column. Keep it short; it is padded to 9. */
  component: string;
  /** Overrides `LOG_LEVEL`. */
  level?: Level;
  /** Overrides `LOG_FORMAT`. */
  format?: "text" | "json";
  /** File descriptor to write to. 1 (stdout) unless a test redirects it. */
  fd?: number;
}

/**
 * Configure the log for this process. Call once, before serving.
 *
 * Idempotent, and safe to call again in a test to change the destination.
 */
export function initLog(options: LogOptions): void {
  component = options.component;
  componentPad = component.padEnd(9).slice(0, 9);
  threshold = options.level !== undefined ? RANK[options.level] : parseLevel(process.env.LOG_LEVEL, RANK.info);
  format = options.format ?? (process.env.LOG_FORMAT === "json" ? "json" : "text");
  fd = options.fd ?? 1;

  const rawCap = Number(process.env.LOG_BUFFER ?? 4096);
  const nextCap = Number.isFinite(rawCap) && rawCap >= 64 ? Math.floor(rawCap) : 4096;
  if (nextCap !== cap) {
    flushLog();
    cap = nextCap;
    buf = new Array(cap);
    head = 0;
    count = 0;
  }

  const rawMs = Number(process.env.LOG_FLUSH_MS ?? 50);
  const flushMs = Number.isFinite(rawMs) && rawMs >= 1 ? Math.floor(rawMs) : 50;

  if (timer !== undefined) clearInterval(timer);
  timer = setInterval(flushLog, flushMs);
  // Unreferenced so a drained process can exit; `exit` still flushes below.
  timer.unref?.();
}

/**
 * Change the threshold on a running process.
 *
 * The one setting an operator needs to change **without a restart**. A restart
 * is the thing that destroys the state being investigated: the process that was
 * misbehaving is gone, and the next one behaves. Turning `debug` on for ninety
 * seconds on the node that is actually wrong is how the interesting record gets
 * written at all.
 *
 * scribe deliberately does not decide how this is reached. An HTTP route behind
 * an internal secret, a signal handler, an admin socket — each service knows
 * what surface it can safely expose, and a log library guessing that for it
 * would be the library making a security decision on the service's behalf.
 *
 * An unrecognised name leaves the threshold alone and returns the current one,
 * for the same reason a bad `LOG_LEVEL` falls back: a typo in an operator's
 * hands during an incident must not make anything worse.
 *
 * @returns The level in force after the call.
 */
export function setLevel(level: string): Level {
  const next = (level ?? "").trim().toLowerCase();
  if (next in RANK) threshold = RANK[next as Level];
  return currentLevelName();
}

/** The level in force. */
export function currentLevelName(): Level {
  return (Object.keys(RANK) as Level[]).find((name) => RANK[name] === threshold) ?? "info";
}

/**
 * True when a record at this level would be written.
 *
 * Exported because it is the honest way to attach an expensive field:
 *
 * ```ts
 * if (isEnabled("debug")) log.debug(EVENTS.REG_DETAIL, { plan: describe(thing) });
 * ```
 *
 * The work inside the guard costs nothing when the level is off, and the
 * alternative — building the value and letting the emitter discard it — is the
 * most common way a logging change becomes a performance regression.
 */
export function isEnabled(level: Level): boolean {
  return RANK[level] <= threshold;
}

function push(entry: Entry): void {
  if (count === cap) {
    // Discard the newest rather than the oldest: the start of a burst is what
    // explains it, and the records already held are closer to the cause.
    dropped++;
    return;
  }
  buf[(head + count) % cap] = entry;
  count++;
}

function safeValue(key: string, raw: string | number | boolean | null): string {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (raw === null) return "-";
  if (typeof raw !== "string") return String(raw);
  let s = raw.length > MAX_VALUE ? `${raw.slice(0, MAX_VALUE)}…` : raw;
  s = s.replace(UNSAFE, " ");
  // Quote only when the value would otherwise break `key=value` splitting.
  return NEEDS_QUOTE.test(s) ? `'${s.replace(QUOTE, "")}'` : s;
}

function detail(fields: Fields | undefined): string {
  if (fields === undefined) return "";
  let out = "";
  let n = 0;
  for (const key in fields) {
    if (n >= MAX_FIELDS || out.length >= MAX_DETAIL) break;
    const raw = fields[key];
    if (raw === undefined) continue;
    if (n > 0) out += " ";
    out += `${key}=${safeValue(key, raw)}`;
    n++;
  }
  return out.length > MAX_DETAIL ? out.slice(0, MAX_DETAIL) : out;
}

function formatText(e: Entry): string {
  return `${new Date(e.ms).toISOString()}|${LABEL[e.level]}|${componentPad}|${e.txn}|${e.event.padEnd(EVENT_WIDTH)}|${detail(e.fields)}`;
}

function formatJson(e: Entry): string {
  const out: Record<string, unknown> = {
    ts: new Date(e.ms).toISOString(),
    level: e.level,
    component,
    txn: e.txn,
    event: e.event,
  };
  if (e.fields !== undefined) {
    let n = 0;
    for (const key in e.fields) {
      if (n >= MAX_FIELDS) break;
      const raw = e.fields[key];
      if (raw === undefined) continue;
      out[key] = SECRET_KEY.test(key)
        ? REDACTED
        : typeof raw === "string" && raw.length > MAX_VALUE
          ? `${raw.slice(0, MAX_VALUE)}…`
          : raw;
      n++;
    }
  }
  try {
    return JSON.stringify(out);
  } catch {
    // Unreachable while `Fields` holds scalars, and kept because a throw here
    // would propagate out of a flush timer and take the process down.
    return JSON.stringify({ ts: out.ts, level: "error", component, event: SCRIBE_EVENTS.LOG_DROP });
  }
}

function render(e: Entry): string {
  return format === "json" ? formatJson(e) : formatText(e);
}

/**
 * Write everything buffered, as one call.
 *
 * Never throws: a full disk must not fail a request, and this runs from a
 * timer where an exception has nowhere to go.
 */
export function flushLog(): void {
  if (count === 0 && dropped === 0) return;
  let out = "";
  while (count > 0) {
    const e = buf[head] as Entry;
    buf[head] = undefined;
    head = (head + 1) % cap;
    count--;
    out += `${render(e)}\n`;
  }
  if (dropped > 0) {
    const lost = dropped;
    dropped = 0;
    out += `${render({ ms: Date.now(), level: "warn", event: SCRIBE_EVENTS.LOG_DROP, txn: "", fields: { records: lost, cap } })}\n`;
  }
  try {
    writeSync(fd, out);
  } catch {
    // Nowhere left to report it — the destination is the thing that failed.
  }
}

function emit(level: Level, event: Event, fields?: Fields): void {
  // The gate. First statement, one comparison, nothing allocated above it.
  if (RANK[level] > threshold) return;
  const ctx = currentTxn();
  const entry: Entry = { ms: Date.now(), level, event, txn: ctx?.txn ?? "", fields };
  if (RANK[level] <= RANK.error) {
    // A failure record is written before the process can lose it, and after the
    // records that lead up to it, so the order on disk is the order of events.
    push(entry);
    flushLog();
    return;
  }
  push(entry);
}

/**
 * The emitter's shape, generic over the product's set of event codes.
 *
 * scribe cannot know that set — see `events.ts` — so `log` below accepts any
 * string. A product narrows it back at its own boundary and gets a compile
 * error on a mistyped code, which is the safety worth keeping:
 *
 * ```ts
 * import { log as base, type Emitter } from "@concurrent-systems/scribe";
 * import type { Event } from "./events.ts";
 *
 * export const log = base as Emitter<Event>;
 * ```
 *
 * Three lines, once, in the module a product already has for its vocabulary.
 */
export interface Emitter<E extends string = Event> {
  fatal(event: E, fields?: Fields): void;
  error(event: E, fields?: Fields): void;
  warn(event: E, fields?: Fields): void;
  info(event: E, fields?: Fields): void;
  debug(event: E, fields?: Fields): void;
  trace(event: E, fields?: Fields): void;
}

/**
 * The emitter. One function per level, `(event, fields)`.
 *
 * `trace` records the data crossing a boundary, `debug` records a decision and
 * what made it, `info` records the outcome. See the levels table in
 * [observability](../requirements/observability.md).
 */
export const log: Emitter = {
  fatal: (event: Event, fields?: Fields): void => emit("fatal", event, fields),
  error: (event: Event, fields?: Fields): void => emit("error", event, fields),
  warn: (event: Event, fields?: Fields): void => emit("warn", event, fields),
  info: (event: Event, fields?: Fields): void => emit("info", event, fields),
  debug: (event: Event, fields?: Fields): void => emit("debug", event, fields),
  trace: (event: Event, fields?: Fields): void => emit("trace", event, fields),
};

/** Records lost to a full buffer since the last flush, and records waiting. */
export function logStats(): { dropped: number; buffered: number; cap: number } {
  return { dropped, buffered: count, cap };
}

/** Stop the timer and write what is left. Wire into each service's shutdown. */
export function closeLog(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  flushLog();
}

// Last line of defence. `writeSync` is legal in an exit handler, so a clean
// exit never leaves records in the buffer.
process.on("exit", flushLog);
