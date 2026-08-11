import cp from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/** ANSI sequence that clears the screen and the scrollback buffer. */
const CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";

/**
 * Resolve the absolute path to the Electron binary via the `electron` package.
 *
 * Resolution starts from the consuming project: `electron` is a peer dependency,
 * so under strict pnpm (or when this package is linked) it isn't reachable from
 * this package's own directory. Falling back to a self-relative lookup keeps
 * flat/hoisted layouts working.
 */
export function resolveElectronBinary(cwd: string = process.cwd()): string {
  for (const from of [path.resolve(cwd, "package.json"), import.meta.url]) {
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
 * On Windows this shells out to `taskkill /T /F`, which is always forceful. On
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
      cp.execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Clear the terminal by writing an ANSI reset sequence to stdout. */
export function clearTerminal(): void {
  process.stdout.write(CLEAR_SEQUENCE);
}
