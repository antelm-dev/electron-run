import cp, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS, DEFAULT_DEBOUNCE_MS, DEFAULT_ENTRY, KILL_TIMEOUT_MS } from "./constants.js";
import { createLogger } from "./logger.js";
import {
  isReclaimable,
  listPidFiles,
  pidDir,
  pidFilePath,
  readPidInfo,
  removePidFile,
  writePidFile,
} from "./pid-file.js";
import { clearTerminal, killTree, resolveElectronBinary } from "./process.js";
import { createTaskQueue } from "./task-queue.js";
import type { BundleOutputLocation, Command, ElectronRunOptions, LaunchContext } from "./types.js";

export type { ElectronRunOptions } from "./types.js";

/** A handle over an Electron process that restarts on rebuild and stops cleanly. */
export interface ElectronRunner {
  /** Debounced restart triggered from a bundle write. */
  scheduleRestart(output: BundleOutputLocation, reason?: string): void;
  /** Stop the running process and flush the queue. */
  close(): Promise<void>;
}

/** Resolve `true` when the child exits before `timeoutMs`, `false` on timeout. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };

    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    child.once("exit", onExit);
  });
}

export function createElectronRunner(options: ElectronRunOptions = {}): ElectronRunner {
  const entry = options.entry ?? DEFAULT_ENTRY;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const additionalArgs = options.additionalArgs ?? [];
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? {};
  const enableStdinControls = options.stdinControls ?? true;
  const clearScreen = options.clearScreen ?? false;
  const logger = options.logger ?? createLogger("electron-run");
  const electronBinary = options.electronPath;
  const pidsDir = pidDir(cwd);

  const enqueue = createTaskQueue();

  /**
   * Queue a task nobody awaits. Failures (an unresolvable Electron binary, a
   * kill that was refused) must not surface as an unhandled rejection and take
   * the watcher down with them.
   */
  function run(task: () => Promise<void>) {
    enqueue(task).catch((error) => logger.error("Electron task failed", error));
  }

  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let currentProcess: ChildProcess | null = null;
  let currentPidFile: string | null = null;
  let lastLaunchContext: LaunchContext | null = null;
  let shutdownRegistered = false;
  let stdinRegistered = false;
  let isShuttingDown = false;

  /** Ask the process tree to exit, then force it if it outlives the timeout. */
  async function terminate(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await killTree(child.pid);
    if (await waitForExit(child, KILL_TIMEOUT_MS)) {
      return;
    }

    logger.warn(`Electron (pid ${child.pid}) ignored SIGTERM, forcing it down`);
    await killTree(child.pid, "SIGKILL");
    await waitForExit(child, KILL_TIMEOUT_MS);
  }

  async function stopElectronProcess() {
    const child = currentProcess;
    const knownPidFiles = new Set(listPidFiles(pidsDir).filter(isReclaimable));

    if (currentPidFile) {
      knownPidFiles.add(currentPidFile);
    }

    if (child) {
      await terminate(child);
    }

    for (const pidFile of knownPidFiles) {
      const info = readPidInfo(pidFile, logger);
      if (info?.pid && info.pid !== child?.pid) {
        await killTree(info.pid);
      }
      removePidFile(pidFile, logger);
    }

    currentProcess = null;
    currentPidFile = null;
  }

  function maybeClearTerminal() {
    if (clearScreen) {
      clearTerminal();
    }
  }

  function startElectronProcess(context: LaunchContext): ChildProcess | null {
    maybeClearTerminal();

    if (!fs.existsSync(context.entryFile)) {
      logger.info(`Entry file not found: ${context.entryFile}`);
      return null;
    }

    const pidFile = pidFilePath(pidsDir, Date.now(), process.pid);

    const child = cp.spawn(
      electronBinary ?? resolveElectronBinary(cwd),
      [...context.additionalArgs, context.entryFile],
      {
        cwd: context.cwd,
        // stdin stays with the runner, which reads it for the interactive commands.
        stdio: ["ignore", "inherit", "inherit"],
        // Own process group on POSIX, so killTree reaches Electron's helper processes.
        detached: process.platform !== "win32",
        shell: false,
        env: { ...process.env, ...context.env },
      },
    );

    currentProcess = child;
    currentPidFile = pidFile;
    writePidFile(pidFile, context, child.pid ?? 0, new Date().toISOString());

    const detach = () => {
      if (currentProcess === child) {
        currentProcess = null;
        currentPidFile = null;
      }
      removePidFile(pidFile, logger);
    };

    child.once("spawn", () => {
      logger.info(`Electron started (pid ${child.pid})`);
    });

    child.once("exit", (code, signal) => {
      detach();
      logger.info(`Electron stopped (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });

    child.once("error", (error) => {
      detach();
      logger.error("Unable to launch Electron", error);
    });

    return child;
  }

  async function restartElectron(context: LaunchContext, reason: string) {
    lastLaunchContext = context;
    logger.info(`Restarting Electron (${reason})`);
    await stopElectronProcess();
    startElectronProcess(context);
  }

  function registerShutdown() {
    if (shutdownRegistered) {
      return;
    }

    shutdownRegistered = true;

    const shutdown = async (exitCode: number) => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      clearTimeout(restartTimer);
      await stopElectronProcess();
      process.exit(exitCode);
    };

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        void shutdown(signal === "SIGINT" ? 130 : 0);
      });
    }

    process.once("exit", () => {
      clearTimeout(restartTimer);
      for (const pidFile of listPidFiles(pidsDir).filter(isReclaimable)) {
        removePidFile(pidFile, logger);
      }
    });
  }

  function getLastLaunchContext() {
    if (lastLaunchContext) {
      return lastLaunchContext;
    }

    logger.info("No Electron launch context available");
    return null;
  }

  function logStatus() {
    if (currentProcess?.pid) {
      logger.info(`Electron active (pid ${currentProcess.pid})`);
      return;
    }

    logger.info("Electron stopped");
  }

  function handleCommand(command: Command) {
    if (command === "help") {
      logger.info("Commands: rs|restart, start, stop, status, clear|cls, help");
      return;
    }

    if (command === "status") {
      logStatus();
      return;
    }

    if (command === "clear" || command === "cls") {
      clearTerminal();
      return;
    }

    const context = getLastLaunchContext();
    if (!context) {
      return;
    }

    if (command === "stop") {
      run(() => stopElectronProcess());
      return;
    }

    if (command === "start") {
      run(async () => {
        if (currentProcess?.pid) {
          logger.info(`Electron already active (pid ${currentProcess.pid})`);
          return;
        }

        startElectronProcess(context);
      });
      return;
    }

    run(() => restartElectron(context, "manual command"));
  }

  function registerStdin() {
    if (stdinRegistered || !process.stdin.isTTY) {
      return;
    }

    stdinRegistered = true;
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    process.stdin.on("data", (chunk: string) => {
      const commands = chunk
        .split(/\r?\n/)
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is Command => COMMANDS.has(value as Command));

      for (const command of commands) {
        handleCommand(command);
      }
    });
  }

  function createLaunchContext(output: BundleOutputLocation): LaunchContext {
    const outDir = output.dir ?? path.dirname(output.file ?? "");
    const entryFile = path.resolve(outDir || cwd, entry);

    return {
      cwd,
      env,
      entryFile,
      additionalArgs,
      clearScreen,
    };
  }

  registerShutdown();
  if (enableStdinControls) {
    registerStdin();
  }

  return {
    scheduleRestart(output: BundleOutputLocation, reason = "rebuild") {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        const context = createLaunchContext(output);
        run(() => restartElectron(context, reason));
      }, debounceMs);
    },
    async close() {
      clearTimeout(restartTimer);
      await enqueue(() => stopElectronProcess());

      // Release stdin, otherwise the resumed stream keeps the event loop alive.
      if (stdinRegistered) {
        process.stdin.pause();
      }
    },
  };
}
