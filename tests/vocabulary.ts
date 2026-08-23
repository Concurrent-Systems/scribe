/**
 * A stand-in vocabulary, so the tests exercise the mechanism without borrowing
 * a product's event codes.
 *
 * scribe owns no vocabulary — see `src/events.ts`. These are the codes a
 * consumer would define for itself, written here in the same shape the
 * documentation recommends, which also makes this file a worked example of it.
 */

import { log as base, type Emitter, SCRIBE_EVENTS } from "../src/index.ts";

export const EVENTS = {
  ...SCRIBE_EVENTS,
  THING_OK: "THING_OK",
  THING_FAIL: "THING_FAIL",
  THING_NONE: "THING_NONE",
  THING_SLOW: "THING_SLOW",
  THING_DEGR: "THING_DEGR",
} as const;

export type Event = (typeof EVENTS)[keyof typeof EVENTS];

/** The typed façade a consumer builds once, and the thing under test here. */
export const log = base as Emitter<Event>;
