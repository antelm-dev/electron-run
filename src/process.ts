import cp from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** ANSI sequence that clears the screen and the scrollback buffer. */
const CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";

export type ElectronNodeTarget = "node16" | "node18" | "node20" | "node22" | "node24";

export interface ElectronTargetResolution {
  /** Installed Electron package version, when it could be read and parsed. */
  electronVersion?: string;
  /** Vite build target compatible with the installed Electron runtime. */
  target: ElectronNodeTarget;
  /** Why the conservative fallback was selected. */
  fallbackReason?: string;
}

function electronResolutionBases(cwd: string): string[] {
  return [path.resolve(cwd, "package.json"), import.meta.url];
}

/** Map a valid Electron version to the Node target embedded by that release. */
export function electronNodeTarget(version: unknown): ElectronNodeTarget | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d+)(?:\.|$)/.exec(version);
  if (!match) return undefined;
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major)) return undefined;
  if (major >= 40) return "node24";
  if (major >= 35) return "node22";
  if (major >= 29) return "node20";
  if (major >= 23) return "node18";
  return "node16";
}

/** Resolve the consumer's Electron version and its compatible default Vite target. */
export function resolveElectronTarget(cwd: string = process.cwd()): ElectronTargetResolution {
  for (const from of electronResolutionBases(cwd)) {
    const require = createRequire(from);
    let packagePath: string;
    try {
      packagePath = require.resolve("electron/package.json");
    } catch {
      continue;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        version?: unknown;
      };
      const target = electronNodeTarget(packageJson.version);
      if (target) {
        return { electronVersion: packageJson.version as string, target };
      }
      return {
        target: "node16",
        fallbackReason: `${packagePath} does not contain a valid Electron version`,
      };
    } catch {
      return {
        target: "node16",
        fallbackReason: `${packagePath} could not be read as Electron package metadata`,
      };
    }
  }

  return {
    target: "node16",
    fallbackReason: "electron/package.json could not be resolved",
  };
}

/**
 * Resolve the absolute path to the Electron binary via the `electron` package.
 *
 * Resolution starts from the consuming project: `electron` is a peer dependency,
 * so under strict pnpm (or when this package is linked) it isn't reachable from
 * this package's own directory. Falling back to a self-relative lookup keeps
 * flat/hoisted layouts working.
 */
export function resolveElectronBinary(cwd: string = process.cwd()): string {
  for (const from of electronResolutionBases(cwd)) {
    const require = createRequire(from);

    try {
      require.resolve("electron");
    } catch {
      // Not installed under this base — try the next one.
      continue;
    }

    // Resolution succeeded, so let the package speak for itself: a half-installed
    // Electron reports a much more useful error than anything we could invent.
    return require("electron") as string;
  }

  throw new Error(
    "Cannot resolve the `electron` package. Install it in your project, or set the `electronPath` option.",
  );
}

/**
 * Signal a process and its whole tree.
 *
 * On Windows this shells out to `taskkill /T`, adding `/F` only for SIGKILL. On
 * POSIX the child is spawned detached, so the negated pid reaches the whole
 * process group (Electron's helper processes included); a lone process without
 * a group is signalled directly. Already-dead processes (`ESRCH`) are ignored.
 */
export function killTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!pid) {
      resolve();
      return;
    }

    if (process.platform === "win32") {
      const args = ["/pid", String(pid), "/T"];
      if (signal === "SIGKILL") {
        args.push("/F");
      }
      cp.execFile("taskkill", args, (error) => {
        if (!error || !isProcessAlive(pid)) {
          resolve();
          return;
        }
        reject(error);
      });
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
        // No process group under that pid — fall back to the process itself.
        try {
          process.kill(pid, signal);
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException)?.code !== "ESRCH") {
            reject(fallbackError);
            return;
          }
        }
      } else {
        reject(error);
        return;
      }
    }

    resolve();
  });
}

/** True when a process with this pid is still running. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function execFileText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    cp.execFile(file, args, { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

/**
 * Return a stable identity for a live process, or `null` when it cannot be
 * established. Recovery must never signal a pid unless this value matches the
 * identity captured at launch.
 */
export async function getProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) {
        return null;
      }
      // Fields after the command start at field 3; process start time is field 22.
      const startTime = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/)[19];
      const executable = fs.readlinkSync(`/proc/${pid}/exe`);
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return startTime ? JSON.stringify([startTime, executable, commandLine]) : null;
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($null -ne $p) { @($p.CreationDate, $p.ExecutablePath, $p.CommandLine) | ConvertTo-Json -Compress }",
    ].join("; ");
    return execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }

  return execFileText("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="]);
}

/** Clear the terminal by writing an ANSI reset sequence to stdout. */
export function clearTerminal(): void {
  process.stdout.write(CLEAR_SEQUENCE);
}
