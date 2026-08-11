import cp from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getProcessIdentity, isProcessAlive, killTree, spawned } = vi.hoisted(() => {
  const spawned: { pid: number; emit(event: string, ...args: unknown[]): boolean }[] = [];

  // A signal only *asks* the process to go away: killTree resolves right away and
  // "exit" lands a tick later. The runner must wait for it before relaunching.
  return {
    spawned,
    getProcessIdentity: vi.fn(async () => "test-process-identity"),
    isProcessAlive: vi.fn(() => false),
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
  getProcessIdentity,
  isProcessAlive,
}));

import { createElectronRunner } from "../src/core.js";
import { listPidFiles, pidDir, pidFilePath, writePidFile } from "../src/pid-file.js";
import type { LaunchContext } from "../src/types.js";
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
  getProcessIdentity.mockResolvedValue("test-process-identity");
  isProcessAlive.mockReturnValue(false);
  killTree.mockImplementation(async (pid: number) => {
    for (const child of spawned) {
      if (child.pid === pid) {
        setTimeout(() => child.emit("exit", 0, null), 5);
      }
    }
  });
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

  it("resolves relative standalone output paths against the configured cwd", async () => {
    const relativeOut = path.join("build", "desktop");
    fs.mkdirSync(path.join(cwd, relativeOut), { recursive: true });
    fs.writeFileSync(path.join(cwd, relativeOut, "main.js"), "// entry", "utf-8");
    const spawn = vi.spyOn(cp, "spawn").mockReturnValue(new FakeChild() as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    runner.scheduleRestart({ dir: relativeOut });
    await flush();

    expect(spawn.mock.calls[0]?.[1]).toEqual([path.join(cwd, relativeOut, "main.js")]);
    await runner.close();
  });

  it("keeps the pid record when termination fails", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const child = new FakeChild();
    vi.spyOn(cp, "spawn").mockReturnValue(child as never);
    killTree.mockImplementationOnce(async () => undefined);
    killTree.mockRejectedValueOnce(new Error("access denied"));
    const { logger } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    await expect(runner.close()).rejects.toThrow("access denied");
    expect(listPidFiles(pidDir(cwd))).toHaveLength(1);

    child.emit("exit", 1, null);
  });

  it("retains recovery state in the synchronous process exit handler", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const child = new FakeChild();
    vi.spyOn(cp, "spawn").mockReturnValue(child as never);
    const before = new Set(process.listeners("exit"));
    const { logger } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    const exitHandler = process.listeners("exit").find((handler) => !before.has(handler));
    expect(exitHandler).toBeDefined();
    exitHandler?.(1);
    expect(listPidFiles(pidDir(cwd))).toHaveLength(1);

    await runner.close();
  });

  it("does not signal a reused pid whose identity does not match", async () => {
    const recoveredPid = 44_444;
    const context: LaunchContext = {
      cwd,
      env: {},
      entryFile: path.join(cwd, "dist", "main.js"),
      additionalArgs: [],
      clearScreen: false,
    };
    const record = pidFilePath(pidDir(cwd), Date.now(), 55_555);
    writePidFile(record, context, recoveredPid, new Date().toISOString(), "original-identity");
    isProcessAlive.mockImplementation((pid: number) => pid === recoveredPid);
    getProcessIdentity.mockResolvedValue("reused-pid-identity");
    const { logger, messages } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });

    runner.scheduleRestart({ dir: "missing" });
    await flush();

    expect(killTree).not.toHaveBeenCalled();
    expect(fs.existsSync(record)).toBe(true);
    expect(messages.some((message) => message.includes("identity does not match"))).toBe(true);
    await runner.close();
  });

  it("rolls back a child when pid persistence fails", async () => {
    fs.writeFileSync(path.join(outDir, "main.js"), "// entry", "utf-8");
    const child = new FakeChild();
    vi.spyOn(cp, "spawn").mockReturnValue(child as never);
    const writeFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).includes("electron-run-")) {
        throw new Error("read only cache");
      }
      return writeFileSync(file, ...args);
    });
    const { logger, messages } = captureLogger();
    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(killTree).toHaveBeenCalledWith(child.pid);
    expect(messages.some((message) => message.includes("read only cache"))).toBe(true);
    expect(listPidFiles(pidDir(cwd))).toHaveLength(0);
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

  it("close is final, idempotent, and removes only runner-owned listeners", async () => {
    attachTty();
    const unrelated = vi.fn();
    stdin.on("data", unrelated);
    const pause = vi.spyOn(stdin, "pause");
    const initialSignals = new Map(
      (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
        signal,
        process.listenerCount(signal),
      ]),
    );
    const { logger } = captureLogger();
    const spawn = vi.spyOn(cp, "spawn");
    const runner = createElectronRunner({ cwd, debounceMs: 1, logger });

    await runner.close();
    await runner.close();
    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(pause).not.toHaveBeenCalled();
    expect(stdin.listeners("data")).toEqual([unrelated]);
    for (const [signal, count] of initialSignals) {
      expect(process.listenerCount(signal)).toBe(count);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
