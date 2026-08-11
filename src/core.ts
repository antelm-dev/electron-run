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
import {
  clearTerminal,
  getProcessIdentity,
  isProcessAlive,
  killTree,
  resolveElectronBinary,
} from "./process.js";
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

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
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
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  /** Ask the process tree to exit, then force it if it outlives the timeout. */
  async function terminate(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    try {
      await killTree(child.pid);
    } catch (error) {
      logger.warn(`Graceful Electron termination failed for pid ${child.pid}`, error);
    }
    if (await waitForExit(child, KILL_TIMEOUT_MS)) {
      return;
    }

    logger.warn(`Electron (pid ${child.pid}) ignored SIGTERM, forcing it down`);
    await killTree(child.pid, "SIGKILL");
    if (!(await waitForExit(child, KILL_TIMEOUT_MS))) {
      throw new Error(`Electron (pid ${child.pid}) did not exit after SIGKILL`);
    }
  }

  async function terminateRecoveredPid(pid: number): Promise<void> {
    try {
      await killTree(pid);
    } catch (error) {
      logger.warn(`Graceful recovered-process termination failed for pid ${pid}`, error);
    }
    if (await waitForPidExit(pid, KILL_TIMEOUT_MS)) {
      return;
    }
    logger.warn(`Recovered Electron (pid ${pid}) ignored SIGTERM, forcing it down`);
    await killTree(pid, "SIGKILL");
    if (!(await waitForPidExit(pid, KILL_TIMEOUT_MS))) {
      throw new Error(`Recovered Electron (pid ${pid}) did not exit after SIGKILL`);
    }
  }

  async function stopElectronProcess() {
    const child = currentProcess;
    if (child) {
      await terminate(child);
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`Electron (pid ${child.pid}) termination was not confirmed`);
      }
    }

    currentProcess = null;
    currentPidFile = null;

    for (const pidFile of listPidFiles(pidsDir).filter(isReclaimable)) {
      const info = readPidInfo(pidFile, logger);
      if (!info) {
        removePidFile(pidFile, logger);
        continue;
      }

      if (!isProcessAlive(info.pid)) {
        removePidFile(pidFile, logger);
        continue;
      }

      const identity = await getProcessIdentity(info.pid);
      if (!identity || identity !== info.identity) {
        logger.warn(`Refusing to reclaim pid ${info.pid}: process identity does not match`);
        continue;
      }

      await terminateRecoveredPid(info.pid);
      removePidFile(pidFile, logger);
    }
  }

  function maybeClearTerminal() {
    if (clearScreen) {
      clearTerminal();
    }
  }

  async function startElectronProcess(context: LaunchContext): Promise<ChildProcess | null> {
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

    currentProcess = child;
    currentPidFile = pidFile;

    try {
      let identity: string | null = null;
      const identityDeadline = Date.now() + 1_000;
      while (
        child.pid &&
        !identity &&
        currentProcess === child &&
        child.exitCode === null &&
        child.signalCode === null &&
        Date.now() < identityDeadline
      ) {
        identity = await getProcessIdentity(child.pid);
        if (!identity) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (currentProcess !== child) {
        return null;
      }
      if (!identity) {
        throw new Error("Unable to establish Electron process identity");
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return null;
      }
      writePidFile(pidFile, context, child.pid!, new Date().toISOString(), identity);
    } catch (error) {
      try {
        await terminate(child);
      } catch (terminationError) {
        logger.error("Unable to roll back unpersisted Electron process", terminationError);
      }
      throw error;
    }

    return child;
  }

  async function restartElectron(context: LaunchContext, reason: string) {
    lastLaunchContext = context;
    logger.info(`Restarting Electron (${reason})`);
    await stopElectronProcess();
    await startElectronProcess(context);
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
      try {
        await stopElectronProcess();
      } catch (error) {
        logger.error("Unable to stop Electron during shutdown", error);
      } finally {
        process.exit(exitCode);
      }
    };

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => {
        void shutdown(signal === "SIGINT" ? 130 : 0);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    process.once("exit", handleProcessExit);
  }

  function handleProcessExit() {
    clearTimeout(restartTimer);
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

        await startElectronProcess(context);
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

    process.stdin.on("data", handleStdinData);
  }

  function handleStdinData(chunk: string) {
    const commands = chunk
      .split(/\r?\n/)
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is Command => COMMANDS.has(value as Command));

    for (const command of commands) {
      handleCommand(command);
    }
  }

  function createLaunchContext(output: BundleOutputLocation): LaunchContext {
    const outDir = output.dir
      ? path.resolve(cwd, output.dir)
      : path.dirname(output.file ? path.resolve(cwd, output.file) : "");
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
      if (closed) {
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        const context = createLaunchContext(output);
        run(() => restartElectron(context, reason));
      }, debounceMs);
    },
    close() {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      clearTimeout(restartTimer);

      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
      process.off("exit", handleProcessExit);
      if (stdinRegistered) {
        process.stdin.off("data", handleStdinData);
        stdinRegistered = false;
      }

      closePromise = enqueue(() => stopElectronProcess());
      return closePromise;
    },
  };
}
