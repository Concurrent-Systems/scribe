/**
 * What an operator can change, and what happens when they get it wrong.
 *
 * Every setting here is read at `initLog`, from the environment, because that
 * is where an operator can reach it without a deploy. The tests that matter
 * most are the ones about a bad value: a typo in an environment variable must
 * never stop a service from starting, and a service that refuses to boot
 * because `LOG_LEVEL=inof` is a worse outcome than one that logs too much.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeLog,
  currentLevelName,
  flushLog,
  initLog,
  isEnabled,
  type Level,
  logStats,
  setLevel,
} from "../src/index.ts";
import { EVENTS, log } from "./vocabulary.ts";

const dir = mkdtempSync(join(tmpdir(), "scribe-config-"));

/** Somewhere to point the log when a test cares about state, not output. */
const devNull = openSync(join(dir, "discard.log"), "a");
let seq = 0;

const LOG_VARS = ["LOG_LEVEL", "LOG_FORMAT", "LOG_BUFFER", "LOG_FLUSH_MS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  flushLog();
  saved = {};
  for (const key of LOG_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of LOG_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(() => {
  // Point the log somewhere harmless for whatever runs next. Not stdout: a
  // stray record in the test output is noise a reader has to learn to ignore.
  initLog({ component: "scribe", level: "info", fd: devNull });
  closeSync(devNull);
});

/**
 * Set the environment, initialise the log against a fresh file, run `fn`, and
 * read back what it wrote.
 *
 * `setEnv` runs *before* `initLog`, because every setting here is read once at
 * initialisation — which is the behaviour under test as much as the values are.
 */
function withEnv(setEnv: () => void, fn: () => void = () => {}): string[] {
  flushLog();
  const path = join(dir, `cfg-${seq++}.log`);
  const fd = openSync(path, "a");
  setEnv();
  initLog({ component: "scribe", fd });
  try {
    fn();
    flushLog();
  } finally {
    closeSync(fd);
  }
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

describe("the level, from the environment", () => {
  const ALL: Level[] = ["fatal", "error", "warn", "info", "debug", "trace"];

  it.each(ALL)("accepts %s", (level) => {
    withEnv(() => {
      process.env.LOG_LEVEL = level;
    });
    expect(isEnabled(level)).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    withEnv(() => {
      process.env.LOG_LEVEL = "  DEBUG  ";
    });
    expect(isEnabled("debug")).toBe(true);
  });

  it("falls back to info on a value it does not recognise, rather than throwing", () => {
    // A typo here must not stop a service from starting. Refusing to boot
    // because of a misspelt log level is a worse outcome than logging at the
    // default, and it happens at the worst possible moment: a deploy.
    const lines = withEnv(
      () => {
        process.env.LOG_LEVEL = "inof";
      },
      () => {
        log.info(EVENTS.THING_OK);
        log.debug(EVENTS.THING_SLOW);
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("THING_OK");
  });

  it("falls back to info when the variable is empty", () => {
    withEnv(() => {
      process.env.LOG_LEVEL = "";
    });
    expect(isEnabled("info")).toBe(true);
    expect(isEnabled("debug")).toBe(false);
  });

  it("lets the caller override the environment, which is how a test pins it", () => {
    process.env.LOG_LEVEL = "error";
    withEnv(() => {
      process.env.LOG_LEVEL = "error";
    });
    expect(isEnabled("error")).toBe(true);
    expect(isEnabled("info")).toBe(false);
    // The explicit option wins over the variable.
    initLog({ component: "scribe", level: "trace", fd: devNull });
    expect(isEnabled("trace")).toBe(true);
  });

  it("admits every level at or above the threshold, and none below", () => {
    withEnv(() => {
      process.env.LOG_LEVEL = "warn";
    });
    expect([isEnabled("fatal"), isEnabled("error"), isEnabled("warn")]).toEqual([true, true, true]);
    expect([isEnabled("info"), isEnabled("debug"), isEnabled("trace")]).toEqual([false, false, false]);
  });
});

describe("the format, from the environment", () => {
  it("writes text unless asked otherwise", () => {
    const [line] = withEnv(
      () => {},
      () => log.info(EVENTS.THING_OK, { org: 1 }),
    );
    expect(line).toContain("|");
    expect(() => JSON.parse(line as string)).toThrow();
  });

  it("writes JSON when LOG_FORMAT says json", () => {
    const [line] = withEnv(
      () => {
        process.env.LOG_FORMAT = "json";
      },
      () => log.info(EVENTS.THING_OK, { org: 1 }),
    );
    expect(JSON.parse(line as string)).toMatchObject({ event: "THING_OK", org: 1 });
  });

  it("treats any other value as text, rather than guessing", () => {
    const [line] = withEnv(
      () => {
        process.env.LOG_FORMAT = "logfmt";
      },
      () => log.info(EVENTS.THING_OK),
    );
    expect(line).toContain("|");
  });
});

describe("the buffer size", () => {
  it("takes its capacity from LOG_BUFFER", () => {
    withEnv(() => {
      process.env.LOG_BUFFER = "128";
    });
    expect(logStats().cap).toBe(128);
  });

  it("refuses a capacity too small to be useful and keeps the default", () => {
    withEnv(() => {
      process.env.LOG_BUFFER = "4";
    });
    expect(logStats().cap).toBe(4096);
  });

  it("ignores a value that is not a number", () => {
    withEnv(() => {
      process.env.LOG_BUFFER = "plenty";
    });
    expect(logStats().cap).toBe(4096);
  });

  it("does not lose buffered records when the capacity changes", () => {
    // Resizing throws the array away. Anything already waiting has to be
    // written first, or a configuration change silently eats records.
    const path = join(dir, "resize.log");
    const fd = openSync(path, "a");
    initLog({ component: "scribe", fd });
    log.info(EVENTS.THING_OK, { marker: "before-resize" });
    process.env.LOG_BUFFER = "256";
    initLog({ component: "scribe", fd });
    flushLog();
    closeSync(fd);
    expect(readFileSync(path, "utf8")).toContain("before-resize");
  });
});

describe("the flush interval", () => {
  it("writes without anyone calling flush", async () => {
    const path = join(dir, "timer.log");
    const fd = openSync(path, "a");
    process.env.LOG_FLUSH_MS = "5";
    initLog({ component: "scribe", fd });
    log.info(EVENTS.THING_OK, { via: "timer" });
    // Nothing calls flushLog here: the timer is the whole point of the buffer.
    await new Promise((r) => setTimeout(r, 60));
    closeSync(fd);
    expect(readFileSync(path, "utf8")).toContain("via=timer");
  });

  it("ignores an interval that is not a positive number", () => {
    expect(() => {
      process.env.LOG_FLUSH_MS = "-1";
      initLog({ component: "scribe", fd: devNull });
    }).not.toThrow();
  });
});

describe("the component name", () => {
  it("pads a short name so the column is fixed", () => {
    const path = join(dir, "short.log");
    const fd = openSync(path, "a");
    initLog({ component: "api", fd });
    log.info(EVENTS.THING_OK);
    flushLog();
    closeSync(fd);
    expect(readFileSync(path, "utf8").split("|")[2]).toBe("api      ");
  });

  it("truncates a long one, because the column matters more than the name", () => {
    const path = join(dir, "long.log");
    const fd = openSync(path, "a");
    initLog({ component: "a-very-long-service-name", fd });
    log.info(EVENTS.THING_OK);
    flushLog();
    closeSync(fd);
    expect(readFileSync(path, "utf8").split("|")[2]).toBe("a-very-lo");
  });
});

describe("shutting down", () => {
  it("writes what is still buffered", () => {
    const path = join(dir, "close.log");
    const fd = openSync(path, "a");
    initLog({ component: "scribe", fd });
    log.info(EVENTS.THING_OK, { marker: "at-close" });
    closeLog();
    closeSync(fd);
    expect(readFileSync(path, "utf8")).toContain("at-close");
  });

  it("leaves nothing waiting", () => {
    initLog({ component: "scribe", fd: devNull });
    log.info(EVENTS.THING_OK);
    closeLog();
    expect(logStats().buffered).toBe(0);
  });
});

describe("changing the level on a running process", () => {
  // A restart destroys the state being investigated: the process that was
  // misbehaving is gone, and the next one behaves. Turning debug on for ninety
  // seconds on the node that is actually wrong is how the interesting record
  // gets written at all.

  it("starts writing records that were being suppressed", () => {
    const path = join(dir, "setlevel.log");
    const fd = openSync(path, "a");
    initLog({ component: "scribe", level: "info", fd });

    log.debug(EVENTS.THING_SLOW, { phase: "before" });
    setLevel("debug");
    log.debug(EVENTS.THING_SLOW, { phase: "after" });
    flushLog();
    closeSync(fd);

    const written = readFileSync(path, "utf8");
    expect(written).not.toContain("before");
    expect(written).toContain("after");
  });

  it("stops writing them again", () => {
    initLog({ component: "scribe", level: "debug", fd: devNull });
    expect(isEnabled("debug")).toBe(true);
    setLevel("info");
    expect(isEnabled("debug")).toBe(false);
  });

  it("reports the level in force", () => {
    initLog({ component: "scribe", level: "info", fd: devNull });
    expect(currentLevelName()).toBe("info");
    expect(setLevel("trace")).toBe("trace");
    expect(currentLevelName()).toBe("trace");
  });

  it("accepts any spelling an operator would type", () => {
    initLog({ component: "scribe", level: "info", fd: devNull });
    expect(setLevel("  DEBUG ")).toBe("debug");
  });

  it("leaves the threshold alone on a name it does not know", () => {
    // A typo in an operator's hands during an incident must not make anything
    // worse — including by silently turning the log off.
    initLog({ component: "scribe", level: "warn", fd: devNull });
    expect(setLevel("verbose")).toBe("warn");
    expect(isEnabled("warn")).toBe(true);
    expect(isEnabled("info")).toBe(false);
  });

  it("does not throw on an empty string", () => {
    initLog({ component: "scribe", level: "warn", fd: devNull });
    expect(() => setLevel("")).not.toThrow();
    expect(currentLevelName()).toBe("warn");
  });

  it("survives a later initLog, which re-reads the environment", () => {
    // setLevel is a runtime override, not a persisted setting. A restart or a
    // re-initialisation goes back to what the environment says, which is the
    // behaviour an operator expects from a temporary change.
    initLog({ component: "scribe", level: "info", fd: devNull });
    setLevel("trace");
    expect(isEnabled("trace")).toBe(true);
    process.env.LOG_LEVEL = "error";
    initLog({ component: "scribe", fd: devNull });
    expect(isEnabled("trace")).toBe(false);
    expect(isEnabled("error")).toBe(true);
  });
});
