import cp from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { killTree, spawned } = vi.hoisted(() => {
  const spawned: { pid: number; emit(event: string, ...args: unknown[]): boolean }[] = [];

  // A signal only *asks* the process to go away: killTree resolves right away and
  // "exit" lands a tick later. The runner must wait for it before relaunching.
  return {
    spawned,
    killTree: vi.fn(async (pid: number) => {
      for (const child of spawned) {
        if (child.pid === pid) {
          setTimeout(() => child.emit("exit", 0, null), 5);
        }
      }
    }),
  };
});

vi.mock("../src/process.js", () => ({
  resolveElectronBinary: () => "electron-binary",
  killTree,
  clearTerminal: vi.fn(),
  isProcessAlive: () => false,
}));

import { createElectronRunner } from "../src/core.js";
import { listPidFiles, pidDir } from "../src/pid-file.js";
import type { LoggerLike } from "../src/logger.js";

class FakeChild extends EventEmitter {
  pid = 12_345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    spawned.push(this);
    this.once("exit", (code: number) => {
      this.exitCode = code;
    });
  }
}

function captureLogger() {
  const messages: string[] = [];
  const record =
    (...prefix: string[]) =>
    (...args: unknown[]) => {
      messages.push([...prefix, ...args.map(String)].join(" "));
    };
  const logger: LoggerLike = {
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
  };
  return { logger, messages };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

let cwd: string;
let outDir: string;

beforeEach(() => {
  spawned.length = 0;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "electron-run-cwd-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-run-out-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("createElectronRunner", () => {
  it("does not spawn when the entry file is missing", async () => {
    const spawn = vi.spyOn(cp, "spawn");
    const { logger, messages } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 1,
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    await flush();
    await runner.close();

    expect(spawn).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("Entry file not found"))).toBe(true);
  });

  it("spawns Electron with resolved args and writes a pid file", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const child = new FakeChild();
    const spawn = vi.spyOn(cp, "spawn").mockReturnValue(child as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 1,
      additionalArgs: ["--inspect"],
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(spawn).toHaveBeenCalledOnce();
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe("electron-binary");
    expect(args).toEqual(["--inspect", path.resolve(outDir, "main.js")]);
    expect(listPidFiles(pidDir(cwd))).toHaveLength(1);

    await runner.close();
    expect(killTree).toHaveBeenCalledWith(child.pid);
    expect(listPidFiles(pidDir(cwd))).toHaveLength(0);
  });

  it("keeps the project root clean by writing pid files under node_modules/.cache", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    vi.spyOn(cp, "spawn").mockReturnValue(new FakeChild() as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(fs.readdirSync(cwd)).toEqual(["node_modules"]);
    expect(pidDir(cwd)).toBe(path.resolve(cwd, "node_modules/.cache/electron-run"));

    await runner.close();
  });

  it("waits for the previous process to exit before relaunching", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const first = new FakeChild();
    const second = new FakeChild();
    second.pid = 999;
    const events: string[] = [];
    first.once("exit", () => events.push("first exited"));

    const spawn = vi.spyOn(cp, "spawn").mockImplementation((() => {
      const child = spawn.mock.calls.length === 1 ? first : second;
      events.push(`spawned ${child.pid}`);
      return child;
    }) as never);

    const { logger } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });

    runner.scheduleRestart({ dir: outDir });
    await flush();

    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(events).toEqual(["spawned 12345", "first exited", "spawned 999"]);
    await runner.close();
  });

  it("debounces rapid restart requests into a single launch", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const spawn = vi.spyOn(cp, "spawn").mockReturnValue(new FakeChild() as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 20,
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    runner.scheduleRestart({ dir: outDir });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(spawn).toHaveBeenCalledOnce();
    await runner.close();
  });
});

describe("interactive stdin commands", () => {
  const realStdin = process.stdin;
  let stdin: PassThrough & { isTTY: boolean };

  /** Swap process.stdin for a TTY-looking stream the test can write commands to. */
  function attachTty() {
    stdin = Object.assign(new PassThrough(), { isTTY: true });
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  }

  async function send(command: string) {
    stdin.write(`${command}\n`);
    await flush();
  }

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  });

  it("answers help and status without a running process", async () => {
    attachTty();
    const { logger, messages } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, logger });

    await send("help");
    await send("status");
    await send("not-a-command");

    expect(messages).toEqual([
      "info Commands: rs|restart, start, stop, status, clear|cls, help",
      "info Electron stopped",
    ]);

    await runner.close();
  });

  it("stops and restarts the process on demand", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    attachTty();
    const spawn = vi.spyOn(cp, "spawn").mockImplementation((() => new FakeChild()) as never);
    const { logger, messages } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, logger });

    runner.scheduleRestart({ dir: outDir });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);

    await send("stop");
    expect(killTree).toHaveBeenCalledWith(12_345);
    expect(listPidFiles(pidDir(cwd))).toHaveLength(0);

    await send("status");
    expect(messages.at(-1)).toBe("info Electron stopped");

    await send("start");
    expect(spawn).toHaveBeenCalledTimes(2);

    await send("rs");
    expect(spawn).toHaveBeenCalledTimes(3);

    await runner.close();
  });

  it("ignores stdin when it is not a TTY", async () => {
    const { logger, messages } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, logger });

    expect(messages).toEqual([]);
    await runner.close();
  });
});
