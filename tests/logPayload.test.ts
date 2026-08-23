import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturing,
  flushLog,
  initLog,
  initPayloads,
  newTxnId,
  type PayloadMode,
  redactBody,
  runWithTxn,
  writePayload,
} from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "scribe-payload-"));
let seq = 0;

const BODY = JSON.stringify({
  orderRef: "REF-73982363",
  channel: "WEB",
  apiKey: "sk-live-should-not-appear",
  order: { reference: "RF-8f21c0", amount: 49.99 },
});

interface Run {
  records: Array<Record<string, unknown>>;
  lines: string[];
  dir: string;
}

function run(mode: PayloadMode, fn: () => void): Run {
  const dir = join(root, `p${seq++}`);
  const logPath = join(dir, "..", `log-${seq}.log`);
  const fd = openSync(logPath, "a");
  initLog({ component: "scribe", level: "info", fd });
  initPayloads({ mode, dir });
  try {
    fn();
    flushLog();
  } finally {
    closeSync(fd);
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  const records = files.flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
  return {
    records,
    lines: readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    dir,
  };
}

function inTxn(fn: () => void): void {
  runWithTxn(
    {
      txn: newTxnId(),
      ref: "REF-73982363",
      organizationId: "acme-retail",
      tags: { item: "ORDER", channel: "WEB" },
      startedAt: performance.now(),
      body: BODY,
    },
    fn,
  );
}

describe("payload capture", () => {
  it("writes nothing for a transaction that succeeded", () => {
    const { records } = run("error", () => inTxn(() => writePayload("ok", { phase: "handler" })));
    assert.equal(records.length, 0, "the happy path must cost no disk at all");
  });

  it("writes the body for a transaction that failed", () => {
    const { records } = run("error", () => inTxn(() => writePayload("error", { phase: "handler", step: "S1" })));
    assert.equal(records.length, 1);
    const r = records[0] as Record<string, unknown>;
    assert.equal(r.outcome, "error");
    assert.equal(r.step, "S1");
    assert.equal(r.ref, "REF-73982363");
    // A tenant key is an opaque string. A number here would be a key that
    // something on the path had converted.
    assert.equal(r.org, "acme-retail");
    assert.match(String(r.txn), /^[0-9a-f]{20}$/);
  });

  it("writes the consumer's tags, so an operator can search by what they know", () => {
    const { records } = run("error", () => inTxn(() => writePayload("error")));
    const r = records[0] as Record<string, unknown>;
    assert.equal(r.item, "ORDER");
    assert.equal(r.channel, "WEB");
  });

  it("never lets a tag overwrite what scribe records about the transaction", () => {
    const { records } = run("error", () =>
      runWithTxn(
        {
          txn: newTxnId(),
          organizationId: "acme-retail",
          tags: { txn: "forged", org: "forged", outcome: "ok" },
          startedAt: performance.now(),
          body: BODY,
        },
        () => writePayload("error"),
      ),
    );
    const r = records[0] as Record<string, unknown>;
    assert.notEqual(r.txn, "forged", "a caller cannot choose the identity");
    assert.equal(r.org, "acme-retail");
    assert.equal(r.outcome, "error");
  });

  it("keeps the body exactly as the caller sent it, so the failure can be replayed", () => {
    const { records } = run("error", () => inTxn(() => writePayload("error")));
    const body = JSON.parse(String((records[0] as Record<string, unknown>).body));
    assert.equal(body.order.reference, "RF-8f21c0");
    assert.equal(body.order.amount, 49.99);
  });

  it("masks a secret before the body reaches disk", () => {
    const { records } = run("error", () => inTxn(() => writePayload("error")));
    const raw = String((records[0] as Record<string, unknown>).body);
    assert.ok(!raw.includes("sk-live-should-not-appear"));
    assert.ok(raw.includes("[REDACTED]"));
  });

  it("writes every transaction under `all`, which is why it is not the default", () => {
    const { records } = run("all", () => {
      inTxn(() => writePayload("ok"));
      inTxn(() => writePayload("ok"));
    });
    assert.equal(records.length, 2);
  });

  it("writes nothing at all under `off`", () => {
    const { records } = run("off", () => inTxn(() => writePayload("error")));
    assert.equal(records.length, 0);
    assert.equal(capturing(), false, "there is no reason to hold a body nobody will write");
  });

  it("bounds the body, so one oversized request cannot fill the volume", () => {
    const dir = join(root, "big");
    const fd = openSync(join(root, "big.log"), "a");
    initLog({ component: "scribe", level: "info", fd });
    initPayloads({ mode: "error", dir, maxBytes: 256 });
    runWithTxn(
      {
        txn: newTxnId(),
        startedAt: performance.now(),
        body: JSON.stringify({ blob: "x".repeat(50_000) }),
      },
      () => writePayload("error"),
    );
    flushLog();
    closeSync(fd);
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8").split("\n")[0] as string);
    assert.equal(record.truncated, true);
    assert.equal(String(record.body).length, 256);
    assert.equal(record.bytes, 50_011, "the original size is still reported");
  });

  it("keeps the sidecar unreadable to other users", () => {
    const { dir } = run("error", () => inTxn(() => writePayload("error")));
    const file = join(dir, readdirSync(dir)[0] as string);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("records in the log that a payload exists, and nothing about what is in it", () => {
    const { lines } = run("error", () => inTxn(() => writePayload("error")));
    const marker = lines.find((l) => l.includes("PAYLOAD"));
    assert.ok(marker, "`grep PAYLOAD` must list every transaction that can be replayed");
    assert.ok(!marker?.includes("RF-8f21c0"), "the operational log never carries the data");
  });

  it("does nothing outside a transaction, rather than guessing", () => {
    const { records } = run("all", () => writePayload("error"));
    assert.equal(records.length, 0);
  });

  it("never lets a broken destination fail a transaction", () => {
    // A path that cannot be created: an existing file used as a directory.
    const bad = join(root, "log-1.log", "nope");
    initPayloads({ mode: "error", dir: bad });
    const fd = openSync(join(root, "guard.log"), "a");
    initLog({ component: "scribe", level: "info", fd });
    assert.doesNotThrow(() => inTxn(() => writePayload("error")));
    flushLog();
    closeSync(fd);
    const lines = readFileSync(join(root, "guard.log"), "utf8");
    assert.match(lines, /PAYLOAD.*disabled=true/, "and it says so once, rather than silently");
  });
});

describe("redaction", () => {
  it("masks by key at any depth", () => {
    const out = redactBody(JSON.stringify({ a: { b: { token: "x", keep: 1 } } }));
    assert.equal(JSON.parse(out).a.b.token, "[REDACTED]");
    assert.equal(JSON.parse(out).a.b.keep, 1);
  });

  it("masks inside an array", () => {
    const out = redactBody(JSON.stringify({ items: [{ password: "x" }, { ok: 2 }] }));
    assert.equal(JSON.parse(out).items[0].password, "[REDACTED]");
    assert.equal(JSON.parse(out).items[1].ok, 2);
  });

  it("still masks a body that will not parse, which is often the one that failed", () => {
    const out = redactBody('{"apiKey":"sk-live-1","truncated":');
    assert.ok(!out.includes("sk-live-1"));
    assert.ok(out.includes("[REDACTED]"));
  });
});
