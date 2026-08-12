import type { LoggerLike } from "./logger.js";

/** A command accepted from interactive stdin while the runner is active. */
export type Command = "rs" | "restart" | "start" | "stop" | "status" | "clear" | "cls" | "help";

/** Snapshot persisted to a pid file while an Electron process is running. */
export interface PidInfo {
  /** Operating-system process identifier. */
  pid: number;
  /** ISO timestamp recorded when the process was launched. */
  startedAt: string;
  /** Absolute path to the Electron application entry file. */
  entry: string;
  /** Arguments supplied to Electron before the entry file. */
  args: string[];
  /** Working directory from which Electron was launched. */
  cwd: string;
  /** OS-derived identity used to distinguish a live child from a reused pid. */
  identity: string;
}

/** Fully resolved parameters used to spawn an Electron process. */
export interface LaunchContext {
  /** Working directory used for the child process. */
  cwd: string;
  /** Additional environment variables merged with the parent environment. */
  env: Record<string, string>;
  /** Absolute path to the bundled Electron entry file. */
  entryFile: string;
  /** Arguments inserted before the Electron entry file. */
  additionalArgs: string[];
  /** Whether to clear the terminal immediately before launch. */
  clearScreen: boolean;
}

/**
 * Rollup output descriptor used to locate the bundled entry file. Relative
 * paths are resolved from the runner's configured `cwd`.
 */
export interface BundleOutputLocation {
  /** Directory containing the bundle output. Mutually exclusive with {@link file}. */
  dir?: string;
  /** Path to a single bundle output file. Mutually exclusive with {@link dir}. */
  file?: string;
}

/** Options accepted by {@link createElectronRunner}. */
export interface ElectronRunOptions {
  /** Entry file resolved against the bundle output directory. Defaults to `main.js`. */
  entry?: string;
  /**
   * Path to the Electron binary to launch. Defaults to resolving the `electron`
   * package. Set this when the `electron` package isn't resolvable from this
   * library (e.g. when it's linked into another project).
   */
  electronPath?: string;
  /** Debounce in ms before a rebuild triggers a restart. Defaults to `150`. */
  debounceMs?: number;
  /** Extra CLI args passed to the Electron binary before the entry file. */
  additionalArgs?: string[];
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra environment variables merged onto `process.env`. */
  env?: Record<string, string>;
  /** Enable interactive stdin commands (rs, start, stop, …). Defaults to `true`. */
  stdinControls?: boolean;
  /** Clear the terminal before each launch. Defaults to `false`. */
  clearScreen?: boolean;
  /** Custom logger. Defaults to a labelled console logger. */
  logger?: LoggerLike;
}
