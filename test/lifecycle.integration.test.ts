import cp, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElectronRunner } from "../src/core.js";
import { pidDir, pidFilePath, readPidInfo, writePidFile } from "../src/pid-file.js";
import { getProcessIdentity, isProcessAlive } from "../src/process.js";
import type { LoggerLike } from "../src/logger.js";
import type { LaunchContext } from "../src/types.js";

const logger: LoggerLike = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "electron-run-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for lifecycle state");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForIdentity(pid: number): Promise<string> {
  let identity: string | null = null;
  const deadline = Date.now() + 8_000;
  while (!identity && Date.now() < deadline) {
    identity = await getProcessIdentity(pid);
    if (!identity) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!identity) {
    throw new Error(`Unable to establish identity for fixture pid ${pid}`);
  }
  return identity;
}

afterEach(async () => {
  for (const child of children) {
    if (child.pid && isProcessAlive(child.pid)) {
      child.kill("SIGKILL");
      await waitUntil(() => !isProcessAlive(child.pid!), 5_000).catch(() => undefined);
    }
  }
  children.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover child still holding the cwd makes Windows report EBUSY here.
      // The temp directory is disposable; never let cleanup mask the real failure.
    }
  }
});

describe("real child lifecycle", () => {
  it("starts and stops a real child without leaving a pid record", async () => {
    const cwd = temporaryDirectory();
    const output = path.join(cwd, "dist");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "main.js"), "setInterval(() => {}, 1000);\n", "utf8");

    const runner = createElectronRunner({
      cwd,
      electronPath: process.execPath,
      debounceMs: 1,
      stdinControls: false,
      manageProcessSignals: false,
      logger,
    });
    runner.scheduleRestart({ dir: "dist" }, "integration test");

    const directory = pidDir(cwd);
    await waitUntil(() => fs.existsSync(directory) && fs.readdirSync(directory).length === 1);
    const recordPath = path.join(directory, fs.readdirSync(directory)[0]!);
    const record = readPidInfo(recordPath, logger);
    expect(record).not.toBeNull();
    expect(isProcessAlive(record!.pid)).toBe(true);

    await runner.close();
    expect(isProcessAlive(record!.pid)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  }, 15_000);

  it("reclaims a real orphan only when its persisted identity matches", async () => {
    const cwd = temporaryDirectory();
    const fixture = path.join(cwd, "fixture.cjs");
    fs.writeFileSync(fixture, "setInterval(() => {}, 1000);\n", "utf8");
    const child = cp.spawn(process.execPath, [fixture], {
      cwd,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const identity = await waitForIdentity(child.pid!);
    const context: LaunchContext = {
      cwd,
      env: {},
      entryFile: fixture,
      additionalArgs: [],
      clearScreen: false,
    };
    const recordPath = pidFilePath(pidDir(cwd), Date.now(), 2_147_483_647);
    writePidFile(recordPath, context, child.pid!, new Date().toISOString(), identity);

    const runner = createElectronRunner({ cwd, debounceMs: 1, stdinControls: false, logger });
    fs.mkdirSync(path.join(cwd, "missing-output"));
    fs.writeFileSync(path.join(cwd, "missing-output/main.js"), "// generated", "utf8");
    runner.scheduleRestart({ dir: "missing-output" }, "recover orphan");
    fs.rmSync(path.join(cwd, "missing-output/main.js"));
    await waitUntil(() => !isProcessAlive(child.pid!) && !fs.existsSync(recordPath), 12_000);
    children.delete(child);

    await runner.close();
  }, 15_000);
});
