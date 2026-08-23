import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_WIDTH,
  flushLog,
  initLog,
  isEnabled,
  isTxnId,
  type Level,
  logStats,
  newTxnId,
  runWithTxn,
  TXN_ID_LENGTH,
  txnIdTime,
} from "../src/index.ts";
import { EVENTS, log } from "./vocabulary.ts";

const dir = mkdtempSync(join(tmpdir(), "rf-log-"));
let seq = 0;

/** Run `fn` with the log pointed at a fresh file, and return the lines it wrote. */
function capture(fn: () => void, level: Level = "info", format: "text" | "json" = "text"): string[] {
  // Drain first, while the log still points where those records belong. The
  // buffer is module state shared by every test file in the process, so a
  // record another file left unflushed would otherwise land in this file and
  // be read back as the record under test. Under `node:test` each file was its
  // own process and this could not happen; under `bun:test` it is one process,
  // and it failed exactly once, on CI, in a different file order (#703).
  flushLog();
  const path = join(dir, `out-${seq++}.log`);
  const fd = openSync(path, "a");
  initLog({ component: "scribe", level, format, fd });
  try {
    fn();
    flushLog();
  } finally {
    closeSync(fd);
  }
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function fields(line: string): string[] {
  return line.split("|");
}

afterAll(() => {
  // Leave the process's log pointed somewhere harmless for other suites.
  initLog({ component: "scribe", level: "info", fd: openSync(join(dir, "discard.log"), "a") });
});

describe("transaction identifier", () => {
  it("is 20 lowercase hexadecimal characters", () => {
    const id = newTxnId();
    assert.equal(id.length, TXN_ID_LENGTH);
    assert.match(id, /^[0-9a-f]{20}$/);
    assert.ok(isTxnId(id));
  });

  it("sorts in the order it was minted, which is the whole reason it is not a v4 UUID", () => {
    const early = newTxnId(1_700_000_000_000);
    const late = newTxnId(1_700_000_000_001);
    assert.ok(early < late, `${early} should sort before ${late}`);
  });

  it("carries the mint time in its leading characters", () => {
    const now = 1_755_000_000_000;
    assert.equal(txnIdTime(newTxnId(now)), now);
  });

  it("cannot repeat inside one millisecond, however large the burst", () => {
    // Uniqueness here is by construction, not by luck. Fresh randomness per
    // mint would collide about once in twenty runs at this size — 32 bits over
    // 20,000 draws is a 4.5% chance — and a log that names two transactions
    // the same is simply wrong.
    const now = Date.now();
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(newTxnId(now));
    assert.equal(seen.size, 20_000);
  });

  it("sorts within one millisecond in the order the identifiers were minted", () => {
    const now = Date.now();
    const ids = Array.from({ length: 500 }, () => newTxnId(now));
    assert.deepEqual(ids, [...ids].sort(), "the tail counts, so ordering holds inside a millisecond too");
  });

  it("starts each millisecond from a fresh random tail, so ids stay unguessable", () => {
    const a = newTxnId(1_700_000_000_000).slice(12);
    const b = newTxnId(1_700_000_000_001).slice(12);
    assert.notEqual(a, b, "a new millisecond re-seeds rather than continuing the count");
  });

  it("rejects anything it did not mint, so a caller cannot choose the identity", () => {
    assert.equal(isTxnId("not-an-id"), false);
    assert.equal(isTxnId("01A02443EAF5C9580D12"), false, "upper case is not the shape");
    assert.equal(isTxnId(""), false);
    assert.equal(isTxnId(undefined), false);
    assert.equal(isTxnId("01a02443eaf5c9580d1"), false, "19 characters");
  });
});

describe("the record", () => {
  it("has six fields in a fixed order", () => {
    const [line] = capture(() => log.info(EVENTS.THING_OK, { org: 7, ms: 3 }));
    const f = fields(line as string);
    assert.equal(f.length, 6);
    assert.match(f[0] as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(f[1], "INFO ");
    assert.equal(f[2], "scribe   ");
    assert.equal(f[3], "");
    // Computed rather than written out: a hand-counted run of spaces is a
    // test that fails when a code changes length, for no reason a reader can see.
    assert.equal(f[4], EVENTS.THING_OK.padEnd(EVENT_WIDTH));
    assert.equal(f[5], "org=7 ms=3");
  });

  it("keeps the columns aligned across levels, so a terminal reads as a table", () => {
    const lines = capture(() => {
      log.info(EVENTS.THING_OK, {});
      log.warn(EVENTS.THING_DEGR, {});
      log.error(EVENTS.THING_FAIL, {});
    });
    const widths = lines.map((l) =>
      fields(l)
        .slice(0, 5)
        .map((f) => f.length)
        .join(","),
    );
    assert.equal(new Set(widths).size, 1, `columns drifted: ${widths.join(" / ")}`);
  });

  it("carries the ambient transaction identifier", () => {
    const txn = newTxnId();
    const [line] = capture(() => {
      runWithTxn({ txn, startedAt: performance.now() }, () => log.info(EVENTS.THING_OK, {}));
    });
    assert.equal(fields(line as string)[3], txn);
  });

  it("is one line even when a value contains newlines", () => {
    const lines = capture(() => log.info(EVENTS.THING_FAIL, { reason: "line one\nline two\r\nthree" }));
    assert.equal(lines.length, 1);
  });

  it("never lets the separator into a field, so a positional read cannot drift", () => {
    const [line] = capture(() => log.info(EVENTS.THING_FAIL, { reason: "a|b|c" }));
    assert.equal(fields(line as string).length, 6);
    assert.equal(fields(line as string)[5], "reason='a b c'");
  });

  it("quotes a value containing a space so `key=value` still splits", () => {
    const [line] = capture(() => log.info(EVENTS.THING_OK, { item: "GIFT CARD" }));
    assert.equal(fields(line as string)[5], "item='GIFT CARD'");
  });

  it("masks a secret-shaped key rather than trusting the caller to omit it", () => {
    const [line] = capture(() =>
      log.info(EVENTS.THING_OK, {
        apiKey: "sk-live-1",
        password: "hunter2",
        authorization: "Bearer x",
        item: "ORDER",
      }),
    );
    const detail = fields(line as string)[5] as string;
    assert.ok(!detail.includes("sk-live-1"));
    assert.ok(!detail.includes("hunter2"));
    assert.ok(!detail.includes("Bearer"));
    assert.ok(detail.includes("item=ORDER"), "an ordinary field still comes through");
  });

  it("bounds the detail field, so one long value cannot blow the size budget", () => {
    const [line] = capture(() => log.info(EVENTS.THING_FAIL, { reason: "x".repeat(5000) }));
    assert.ok((fields(line as string)[5] as string).length <= 512);
  });

  it("skips an undefined field instead of writing the word undefined", () => {
    const [line] = capture(() => log.info(EVENTS.THING_OK, { org: 7, item: undefined, ms: 1 }));
    assert.equal(fields(line as string)[5], "org=7 ms=1");
  });

  it("writes null as a dash, which is a value rather than a gap", () => {
    const [line] = capture(() => log.info(EVENTS.THING_OK, { channel: null }));
    assert.equal(fields(line as string)[5], "channel=-");
  });
});

describe("levels", () => {
  it("drops a record below the threshold", () => {
    const lines = capture(() => {
      log.debug(EVENTS.THING_SLOW, {});
      log.info(EVENTS.THING_OK, {});
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /THING_OK/);
  });

  it("reports the threshold so a caller can skip building an expensive field", () => {
    capture(() => {
      assert.equal(isEnabled("info"), true);
      assert.equal(isEnabled("debug"), false);
    });
    capture(() => {
      assert.equal(isEnabled("debug"), true);
      assert.equal(isEnabled("trace"), false);
    }, "debug");
  });

  it("writes an error immediately, after the records that lead up to it", () => {
    const path = join(dir, "order.log");
    const fd = openSync(path, "a");
    initLog({ component: "scribe", level: "info", fd });
    log.info(EVENTS.THING_NONE, {});
    log.error(EVENTS.THING_FAIL, {});
    // No flush: the error must have forced one, taking the buffered record with it.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    closeSync(fd);
    assert.equal(lines.length, 2);
    assert.match(lines[0] as string, /THING_NONE/);
    assert.match(lines[1] as string, /THING_FAIL/);
  });
});

describe("the buffer", () => {
  it("discards rather than blocking, and says how many it lost", () => {
    process.env.LOG_BUFFER = "64";
    const lines = capture(() => {
      for (let i = 0; i < 200; i++) log.info(EVENTS.THING_OK, { i });
    });
    delete process.env.LOG_BUFFER;
    const drop = lines.find((l) => l.includes("LOG_DROP"));
    assert.ok(drop, "a full buffer must report the loss, not hide it");
    assert.match(drop as string, /records=136/);
    assert.equal(lines.length, 65, "64 records plus the one reporting the loss");
  });

  it("reports what is waiting", () => {
    initLog({
      component: "scribe",
      level: "info",
      fd: openSync(join(dir, "stats.log"), "a"),
    });
    log.info(EVENTS.THING_OK, {});
    assert.equal(logStats().buffered, 1);
    flushLog();
    assert.equal(logStats().buffered, 0);
  });
});

describe("the json encoding", () => {
  it("carries the same fields under a different shape", () => {
    const [line] = capture(
      () => {
        runWithTxn({ txn: "01a02443eaf5c9580d12", startedAt: performance.now() }, () =>
          log.info(EVENTS.THING_OK, {
            org: 7,
            item: "ORDER",
            apiKey: "sk-live-1",
          }),
        );
      },
      "info",
      "json",
    );
    const parsed = JSON.parse(line as string);
    assert.equal(parsed.level, "info");
    assert.equal(parsed.component, "scribe");
    assert.equal(parsed.event, "THING_OK");
    assert.equal(parsed.txn, "01a02443eaf5c9580d12");
    assert.equal(parsed.org, 7);
    assert.equal(parsed.item, "ORDER");
    assert.equal(parsed.apiKey, "[REDACTED]", "redaction is not a property of one encoder");
  });
});
