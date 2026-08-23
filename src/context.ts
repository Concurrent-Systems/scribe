/**
 * The ambient facts about the transaction currently being handled.
 *
 * Held in an `AsyncLocalStorage` rather than threaded through every function
 * signature. Two reasons, and the second is the load-bearing one:
 *
 *   - A logger parameter threaded through every function that might one day
 *     log — and everything below them — is a change to a great deal of code
 *     that has nothing to do with logging.
 *   - The store is only ever read *after* the level gate has passed, so a
 *     disabled record never touches it. The cost lands on records that are
 *     actually written, not on every step of every request.
 *
 * Available under both Bun and Node. Node 24 resolves `getStore()` through
 * `AsyncContextFrame`, which is why this is affordable on a hot path at all.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TxnContext {
  /** The identifier, minted at the boundary. Never taken from a caller. */
  txn: string;
  /** The caller's own reference, recorded but never trusted as an identity. */
  ref?: string;
  /**
   * The tenant this transaction belongs to.
   *
   * An opaque string, never a number. It arrives in a token and is carried to
   * whatever the product writes; nothing on that path may parse, convert or
   * default it. `Number("acme-retail")` is `NaN`, and a `NaN` tenant is a
   * record that cannot be traced back to a customer — silently, because the
   * conversion does not fail.
   */
  organizationId?: string;
  /**
   * Correlation keys this consumer wants on every payload record.
   *
   * scribe has no opinion about what identifies a transaction beyond `txn`
   * and the tenant. Whatever else an operator would search by — a subject, a
   * channel, a product — goes here, and is written verbatim. A key that
   * collides with one scribe writes itself is ignored, so a consumer cannot
   * overwrite `txn`, `org` or `outcome`.
   */
  tags?: Record<string, string>;
  /**
   * Start mark, from `performance.now()`.
   *
   * Not `Date.now()`: the wall clock can be stepped by NTP mid-transaction,
   * which is how a duration comes out negative in exactly the incident being
   * read. Only differences are taken, so the arbitrary origin does not matter.
   */
  startedAt: number;
  /**
   * The request body exactly as it arrived, held by reference.
   *
   * Costs nothing to keep — the string already exists — and is written only if
   * the transaction fails. See `payload.ts` for why that is the whole design.
   */
  body?: string;
}

const store = new AsyncLocalStorage<TxnContext>();

/** Run `fn` with `ctx` as the ambient transaction. */
export function runWithTxn<T>(ctx: TxnContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The ambient transaction, or undefined outside one (startup, shutdown, timers). */
export function currentTxn(): TxnContext | undefined {
  return store.getStore();
}

/** Milliseconds since the ambient transaction began, rounded, or undefined. */
export function elapsedMs(): number | undefined {
  const ctx = store.getStore();
  return ctx === undefined ? undefined : Math.round(performance.now() - ctx.startedAt);
}
