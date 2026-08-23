/**
 * The transaction identifier: 20 lowercase hexadecimal characters, time-ordered.
 *
 * Layout: 12 hex of millisecond timestamp, then 8 hex of randomness.
 *
 *     019898f4a3c1 7f3c9a2e
 *     └─ ms since epoch ─┘ └ random ┘
 *
 * **Why time-ordered.** Sorting a set of these sorts them by arrival, so `sort`
 * over a log file is chronological with no extra key, and an index on the value
 * is written in ascending order rather than splitting B-tree pages at random.
 * That is the whole case against a version 4 UUID here; generation cost is
 * ~100 ns either way and never appears in a request budget.
 *
 * **Why not UUIDv7, which has the same property.** It is 128 bits rendered as
 * 36 characters, and `Bun.randomUUIDv7()` exists while Node has no equivalent —
 * so a shared module would need a dependency or a second code path anyway. This
 * is twelve lines that behave identically under Bun and Node, and it is 20
 * characters rather than 36 on every log record.
 *
 * **Collision.** Two identifiers can only collide inside the same millisecond,
 * where 32 random bits give an even chance at roughly 77,000 requests in that
 * millisecond. A service would have to be four orders of magnitude beyond any
 * ordinary throughput before that became a consideration.
 *
 * The 12-hex timestamp holds 48 bits, so the width is stable past the year 10000.
 */

/**
 * Randomness is drawn in blocks rather than per call.
 *
 * `crypto.getRandomValues` has a fixed per-call overhead that dwarfs the four
 * bytes wanted, and minting sits on the request path. One call per 256
 * identifiers amortises it to an array read.
 */
const POOL_SIZE = 256;
const pool = new Uint32Array(POOL_SIZE);
let poolNext = POOL_SIZE;

function nextRandom(): number {
  if (poolNext >= POOL_SIZE) {
    crypto.getRandomValues(pool);
    poolNext = 0;
  }
  // Non-null: index is bounds-checked by the refill above.
  return pool[poolNext++] as number;
}

/** Characters in a transaction identifier. Fixed, so the log column is fixed. */
export const TXN_ID_LENGTH = 20;

/**
 * State for the within-millisecond counter. See `newTxnId`.
 *
 * `lastMs` starts at -1 so the first call of the process always takes the
 * fresh-randomness branch rather than matching a real timestamp by accident.
 */
let lastMs = -1;
let lastTail = 0;

/**
 * Mint one identifier. `now` is injectable so tests can pin the time half.
 *
 * **Within one millisecond the tail counts rather than re-rolls.** Drawing
 * fresh randomness each time makes uniqueness probable, not certain: 32 bits
 * over 20,000 identifiers in the same millisecond is a 4.5% chance of a
 * collision, which is the birthday problem and not a small number. Two
 * transactions sharing an identifier means the log is wrong about which is
 * which, and no amount of "it is unlikely" fixes a wrong log.
 *
 * Seeding the tail randomly and incrementing it makes the identifier unique by
 * construction for up to 2^32 mints inside one millisecond — four million
 * times the rated throughput — while keeping the value unguessable, since the
 * starting point is still random.
 *
 * It also makes identifiers minted in the same millisecond sort in the order
 * they were minted, which plain randomness could not do.
 */
export function newTxnId(now: number = Date.now()): string {
  if (now === lastMs) {
    // `>>> 0` keeps the counter an unsigned 32-bit value, so a wrap lands back
    // at 0 rather than going negative and changing the rendered width.
    lastTail = (lastTail + 1) >>> 0;
  } else {
    lastMs = now;
    lastTail = nextRandom();
  }
  return now.toString(16).padStart(12, "0") + lastTail.toString(16).padStart(8, "0");
}

const TXN_ID_RE = /^[0-9a-f]{20}$/;

/**
 * True for a value this module could have minted.
 *
 * Used where an identifier arrives from outside: a caller's value is recorded
 * under its own field and never promoted to the transaction identifier,
 * but a malformed one should not reach a log column at all.
 */
export function isTxnId(value: unknown): value is string {
  return typeof value === "string" && TXN_ID_RE.test(value);
}

/** The millisecond the identifier was minted, or NaN if it is not one of ours. */
export function txnIdTime(id: string): number {
  return isTxnId(id) ? Number.parseInt(id.slice(0, 12), 16) : Number.NaN;
}

/**
 * Header carrying the identifier from one service to the next.
 *
 * Trusted **only** on a hop that is already authenticated, so that one service
 * can continue another's transaction rather than starting a new one. On a public
 * edge the value is recorded as the caller's own reference and never becomes the
 * identifier — otherwise a caller chooses an identity, and an identity a caller
 * chooses is one they can collide with, deliberately or by accident.
 */
export const TXN_HEADER = "X-Txn-Id";
