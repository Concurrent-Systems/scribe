/**
 * The seam between scribe and a product: the typed façade.
 *
 * scribe owns no vocabulary, so `log` accepts any string. A product narrows it
 * back with `Emitter<Event>` and gets a compile error on a mistyped code. That
 * cast is the one piece of ceremony this design asks of a consumer, so these
 * tests check it does what it claims — and that the two codes scribe *does*
 * own arrive intact when a product spreads them into its own set.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_WIDTH, flushLog, initLog, type Level, SCRIBE_EVENTS } from "../src/index.ts";
import { EVENTS, log } from "./vocabulary.ts";

const dir = mkdtempSync(join(tmpdir(), "scribe-vocab-"));
let seq = 0;

function capture(fn: () => void, level: Level = "trace"): string[] {
  flushLog();
  const path = join(dir, `v-${seq++}.log`);
  const fd = openSync(path, "a");
  initLog({ component: "scribe", level, fd });
  try {
    fn();
    flushLog();
  } finally {
    closeSync(fd);
  }
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

afterAll(() => {
  initLog({ component: "scribe", level: "info", fd: openSync(join(dir, "discard.log"), "a") });
});

describe("the typed façade forwards every level", () => {
  const LEVELS: Level[] = ["fatal", "error", "warn", "info", "debug", "trace"];

  it.each(LEVELS)("%s reaches the file", (level) => {
    const [line] = capture(() => log[level](EVENTS.THING_OK, { level }));
    expect(line).toContain("THING_OK");
    expect(line).toContain(level.toUpperCase());
  });

  it("is the same object scribe exports, not a copy that could drift", async () => {
    const { log: base } = await import("../src/index.ts");
    expect(log).toBe(base as typeof log);
  });
});

describe("the codes scribe owns", () => {
  it("survive being spread into a product's set", () => {
    expect(EVENTS.LOG_DROP).toBe(SCRIBE_EVENTS.LOG_DROP);
    expect(EVENTS.PAYLOAD).toBe(SCRIBE_EVENTS.PAYLOAD);
  });

  it("are the only two scribe defines, because the rest belong to the product", () => {
    // A shared vocabulary would be the union of every product's events, and
    // every service would carry the others' codes in its type.
    expect(Object.keys(SCRIBE_EVENTS).sort()).toEqual(["LOG_DROP", "PAYLOAD"]);
  });

  it("fit the column like any other code", () => {
    for (const code of Object.values(SCRIBE_EVENTS)) {
      expect(code.length).toBeLessThanOrEqual(EVENT_WIDTH - 1);
    }
  });
});

describe("a product's vocabulary", () => {
  it("names each code after itself, so a grep of the source finds the record", () => {
    for (const [name, code] of Object.entries(EVENTS)) expect(code as string).toBe(name);
  });

  it("has no two names sharing a code", () => {
    const codes = Object.values(EVENTS);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("fits every code in the column, so the detail always starts in one place", () => {
    const lines = capture(() => {
      for (const code of Object.values(EVENTS)) log.info(code);
    });
    for (const line of lines) expect(line.split("|")[4]).toHaveLength(EVENT_WIDTH);
  });
});
