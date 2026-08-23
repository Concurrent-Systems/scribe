import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushLog, initLog, newTxnId, runWithTxn } from "../src/index.ts";
import { EVENTS, log } from "./vocabulary.ts";

/**
 * L17 is a performance requirement, so it is **measured and the measurement
 * fails the build**. A performance requirement nothing checks is decoration:
 * it holds on the day it is written and quietly stops holding on some later
 * one, and nobody finds out until a profile says the logger is on the list.
 *
 * The ceilings below are per *record* and are set well above what the module
 * measures locally, because this has to hold on whatever hardware runs CI.
 * They are still far below the point where logging is visible in any request
 * budget worth having: a request writing two records at the default level
 * spends tens of nanoseconds on them, even at the ceiling.
 */
const CEILING_NS = {
  /** Below the threshold: the gate, and nothing else. */
  disabled: 200,
  /** Captured and buffered, with no transaction context to read. */
  enabled: 4_000,
  /** Captured and buffered, reading the ambient context — the real case. */
  inContext: 6_000,
};

const dir = mkdtempSync(join(tmpdir(), "rf-bench-"));

function nsPerCall(iterations: number, fn: (i: number) => void): number {
  // Warm up, so the measurement is of steady-state code rather than of the
  // optimiser deciding what this function is.
  for (let i = 0; i < 20_000; i++) fn(i);
  flushLog();
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const elapsed = Number(process.hrtime.bigint() - started);
  flushLog();
  return elapsed / iterations;
}

describe("cost on a request path (L17)", () => {
  const fd = openSync(join(dir, "bench.log"), "a");
  initLog({ component: "scribe", level: "info", fd });

  it("costs almost nothing when the level is off", () => {
    const ns = nsPerCall(200_000, (i) => log.debug(EVENTS.THING_SLOW, { phase: "check", n: i }));
    assert.ok(
      ns < CEILING_NS.disabled,
      `a disabled record cost ${ns.toFixed(0)} ns, ceiling ${CEILING_NS.disabled} ns — the gate is no longer the first thing that runs`,
    );
  });

  it("stays inside the budget when the record is written", () => {
    const ns = nsPerCall(200_000, (i) =>
      log.info(EVENTS.THING_OK, {
        phase: "handler",
        org: 7,
        item: "ORDER",
        channel: "WEB",
        items: 6,
        lines: 2,
        ms: i % 20,
      }),
    );
    assert.ok(
      ns < CEILING_NS.enabled,
      `an emitted record cost ${ns.toFixed(0)} ns, ceiling ${CEILING_NS.enabled} ns — something is serialising on the request path`,
    );
  });

  it("stays inside the budget while reading the ambient transaction", () => {
    const ctx = { txn: newTxnId(), startedAt: performance.now() };
    const ns = runWithTxn(ctx, () =>
      nsPerCall(200_000, (i) =>
        log.info(EVENTS.THING_OK, {
          phase: "handler",
          org: 7,
          lines: 2,
          ms: i % 20,
        }),
      ),
    );
    assert.ok(
      ns < CEILING_NS.inContext,
      `an in-context record cost ${ns.toFixed(0)} ns, ceiling ${CEILING_NS.inContext} ns`,
    );
  });

  it("reports the measurements, so a regression is visible before it breaks a ceiling", () => {
    const ctx = { txn: newTxnId(), startedAt: performance.now() };
    const disabled = nsPerCall(100_000, () => log.debug(EVENTS.THING_SLOW, { changes: 1 }));
    const enabled = nsPerCall(100_000, (i) => log.info(EVENTS.THING_OK, { org: 7, ms: i % 20 }));
    const inContext = runWithTxn(ctx, () =>
      nsPerCall(100_000, (i) => log.info(EVENTS.THING_OK, { org: 7, ms: i % 20 })),
    );
    console.log(
      `\n    log emission: disabled ${disabled.toFixed(0)} ns · enabled ${enabled.toFixed(0)} ns · in context ${inContext.toFixed(0)} ns` +
        `\n    two records per request ⇒ ${((inContext * 2) / 1000).toFixed(2)} µs\n`,
    );
    closeSync(fd);
    // L17: a written record under 100 ns, so two records cost a fraction of any
    // request budget a service is likely to have.
    assert.ok(inContext < 100, "a written record must cost under 100 ns");
  });
});
