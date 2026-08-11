import fs from "node:fs";
import path from "node:path";
import { PID_DIR, PID_FILE_PREFIX } from "./constants.js";
import type { LoggerLike } from "./logger.js";
import { isProcessAlive } from "./process.js";
import type { LaunchContext, PidInfo } from "./types.js";

/** `<timestamp>-<pid of the runner that wrote the file>` */
const PID_FILE_NAME = new RegExp(`^${PID_FILE_PREFIX}\\d+-(\\d+)\\.json$`);

/** Directory holding the pid files for a project, kept out of the project root. */
export function pidDir(cwd: string): string {
  return path.resolve(cwd, PID_DIR);
}

/** Absolute path of a fresh pid file for the current process. */
export function pidFilePath(dir: string, timestamp: number, pid: number): string {
  return path.resolve(dir, `${PID_FILE_PREFIX}${timestamp}-${pid}.json`);
}

/** List every pid file currently present in `dir`. Missing directory yields `[]`. */
export function listPidFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.startsWith(PID_FILE_PREFIX) && fileName.endsWith(".json"))
    .map((fileName) => path.resolve(dir, fileName));
}

/**
 * True when this runner may kill and delete `filePath`: either it owns the file,
 * or the runner that wrote it is gone and left an orphan behind. Files belonging
 * to another *live* runner (a second watcher, a sibling package) are left alone.
 */
export function isReclaimable(filePath: string): boolean {
  const owner = PID_FILE_NAME.exec(path.basename(filePath))?.[1];
  if (!owner) {
    return false;
  }

  const ownerPid = Number(owner);
  return ownerPid === process.pid || !isProcessAlive(ownerPid);
}

/** Read and parse a pid file, returning `null` on any read/parse failure. */
export function readPidInfo(filePath: string, logger: LoggerLike): PidInfo | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PidInfo;
  } catch (error) {
    logger.warn(`Error reading pid file: ${filePath}`, error);
    return null;
  }
}

/** Delete a pid file if it exists. */
export function removePidFile(filePath: string | null, logger: LoggerLike): void {
  if (!filePath) {
    logger.warn("No pid file provided to removePidFile");
    return;
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/** Persist a launch snapshot to `filePath`. */
export function writePidFile(
  filePath: string,
  context: LaunchContext,
  pid: number,
  startedAt: string,
): void {
  const info: PidInfo = {
    pid,
    startedAt,
    entry: context.entryFile,
    args: context.additionalArgs,
    cwd: context.cwd,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(info, null, 2), "utf-8");
}
