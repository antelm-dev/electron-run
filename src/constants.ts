/** Prefix for the per-process pid tracking files. */
export const PID_FILE_PREFIX = "electron-run-";

/** Directory (relative to `cwd`) holding the pid files, so they stay out of the project root. */
export const PID_DIR = "node_modules/.cache/electron-run";

/** Default entry file resolved against the bundle output directory. */
export const DEFAULT_ENTRY = "main.js";

/** Default debounce (ms) applied before a rebuild triggers a restart. */
export const DEFAULT_DEBOUNCE_MS = 150;

/** How long to wait for a graceful exit before escalating to `SIGKILL`. */
export const KILL_TIMEOUT_MS = 3000;

/** Interactive stdin commands accepted while the runner is attached to a TTY. */
export const COMMANDS = new Set([
  "rs",
  "restart",
  "start",
  "stop",
  "status",
  "clear",
  "cls",
  "help",
] as const);
