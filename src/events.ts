/**
 * The two event codes scribe writes about itself, and the width of the column.
 *
 * **scribe owns no vocabulary.** An event code names something that happens in
 * a particular service — `ORDER_FAIL` means nothing in an identity service and
 * `AUTH_FAIL` means nothing in a checkout — so the set of codes belongs to the
 * product, not to the log. A shared vocabulary would be the
 * union of every product's events, growing whenever any of them learned a new
 * one, and every service would carry the others' codes in its type.
 *
 * The exception is the log writing about itself. Those two codes are scribe's,
 * because scribe is what emits them, and a product that redefined them would
 * have two spellings for one event. Spread them into the product's own set:
 *
 * ```ts
 * export const EVENTS = {
 *   ...SCRIBE_EVENTS,
 *   AUTH_OK: "AUTH_OK",
 *   // …
 * } as const;
 * ```
 */

export const SCRIBE_EVENTS = {
  /**
   * Records were discarded because the buffer was full.
   *
   * A log that drops silently is worse than one that drops loudly: it is
   * trusted and incomplete.
   */
  LOG_DROP: "LOG_DROP",
  /** A payload was captured to the sidecar for this transaction. */
  PAYLOAD: "PAYLOAD",
} as const;

/**
 * Width of the event column, so the emitter can pad without scanning.
 *
 * This is a format decision, not a vocabulary one, which is why it lives here:
 * a fixed column is what lets a person read a log file down the page and a
 * collector cut a field without a parser. Every product's codes must fit —
 * ten characters plus the space.
 */
export const EVENT_WIDTH = 11;

/**
 * A product's event code.
 *
 * Widened to `string` because scribe cannot know the set. A product narrows it
 * back with `Emitter<Event>`; see `log.ts`.
 */
export type Event = string;
