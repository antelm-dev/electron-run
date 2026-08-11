import cp from "node:child_process";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTerminal, isProcessAlive, killTree, resolveElectronBinary } from "../src/process.js";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe("killTree", () => {
  it("resolves immediately when no pid is given", async () => {
    await expect(killTree(undefined)).resolves.toBeUndefined();
  });

  it("uses taskkill on win32", async () => {
    setPlatform("win32");
    const execFile = vi.spyOn(cp, "execFile").mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1) as (err: Error | null) => void;
      cb(null);
      return {};
    }) as never);

    await killTree(4242);

    expect(execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.any(Function),
    );
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
});

describe("clearTerminal", () => {
  it("writes an ANSI clear sequence to stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearTerminal();
    expect(write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");
  });
});
