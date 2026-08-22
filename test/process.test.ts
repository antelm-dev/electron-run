import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTerminal,
  electronNodeTarget,
  isProcessAlive,
  killTree,
  resolveElectronBinary,
  resolveElectronTarget,
} from "../src/process.js";

const originalPlatform = process.platform;
const fixtures: string[] = [];

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function electronFixture(version: unknown): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "electron-run-target-"));
  fixtures.push(fixture);
  const packageDirectory = path.join(fixture, "node_modules/electron");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(fixture, "package.json"), "{}");
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ version }));
  return fixture;
}

describe("killTree", () => {
  it("resolves immediately when no pid is given", async () => {
    await expect(killTree(undefined)).resolves.toBeUndefined();
  });

  it("targets the pid alone for a graceful taskkill on win32", async () => {
    setPlatform("win32");
    const execFile = vi.spyOn(cp, "execFile").mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1) as (err: Error | null) => void;
      cb(null);
      return {};
    }) as never);

    await killTree(4242);

    expect(execFile).toHaveBeenCalledWith("taskkill", ["/pid", "4242"], expect.any(Function));
  });

  it("adds /T /F only for a forceful Windows termination", async () => {
    setPlatform("win32");
    const execFile = vi.spyOn(cp, "execFile").mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1) as (err: Error | null) => void;
      cb(null);
      return {};
    }) as never);

    await killTree(4242, "SIGKILL");
    expect(execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.any(Function),
    );
  });

  it("rejects an unexpected taskkill failure while the process is alive", async () => {
    setPlatform("win32");
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(cp, "execFile").mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1) as (err: Error | null) => void;
      cb(new Error("access denied"));
      return {};
    }) as never);

    await expect(killTree(4242)).rejects.toThrow("access denied");
  });

  it("signals the whole process group on posix platforms", async () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await killTree(555);

    expect(kill).toHaveBeenCalledWith(-555, "SIGTERM");
  });

  it("forwards an explicit signal", async () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await killTree(555, "SIGKILL");

    expect(kill).toHaveBeenCalledWith(-555, "SIGKILL");
  });

  it("falls back to the bare pid when there is no process group", async () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) {
        const error = new Error("no such group") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });

    await killTree(555);

    expect(kill).toHaveBeenNthCalledWith(1, -555, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, 555, "SIGTERM");
  });

  it("tolerates an already-dead process (ESRCH)", async () => {
    setPlatform("linux");
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    await expect(killTree(1)).resolves.toBeUndefined();
  });

  it("rejects on unexpected kill errors", async () => {
    setPlatform("linux");
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    await expect(killTree(1)).rejects.toThrow("not permitted");
  });
});

describe("resolveElectronBinary", () => {
  it("falls back to a self-relative lookup when the cwd cannot resolve electron", () => {
    // os.tmpdir() has no node_modules, so the fallback base is the only way to
    // reach electron. Whether the binary is downloaded is not this test's
    // business — it only asserts that resolution did not give up.
    expect(() => resolveElectronBinary(os.tmpdir())).not.toThrow(/Cannot resolve/);
  });
});

describe("Electron target resolution", () => {
  it.each([
    ["22.3.0", "node16"],
    ["23.0.0", "node18"],
    ["28.3.3", "node18"],
    ["29.0.0", "node20"],
    ["34.5.8", "node20"],
    ["35.0.0", "node22"],
    ["39.7.2", "node22"],
    ["40.0.0", "node24"],
  ] as const)("maps Electron %s to %s", (version, target) => {
    expect(electronNodeTarget(version)).toBe(target);
  });

  it.each([undefined, null, "", "v40.0.0", "not-semver"])(
    "rejects malformed version %j",
    (version) => {
      expect(electronNodeTarget(version)).toBeUndefined();
    },
  );

  it("prefers the consuming project's Electron package", () => {
    const fixture = electronFixture("28.2.0");

    expect(resolveElectronTarget(fixture)).toEqual({
      electronVersion: "28.2.0",
      target: "node18",
    });
  });

  it("falls back to node16 for malformed consumer package metadata", () => {
    const fixture = electronFixture("future");

    expect(resolveElectronTarget(fixture)).toMatchObject({
      target: "node16",
      fallbackReason: expect.stringContaining("does not contain a valid Electron version"),
    });
  });
});

describe("isProcessAlive", () => {
  it("recognises the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a dead process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    expect(isProcessAlive(4_242)).toBe(false);
  });

  it("treats EPERM as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(isProcessAlive(1)).toBe(true);
  });

  it("rejects invalid pids without signalling", () => {
    const kill = vi.spyOn(process, "kill");
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("clearTerminal", () => {
  it("writes an ANSI clear sequence to stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearTerminal();
    expect(write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");
  });
});
