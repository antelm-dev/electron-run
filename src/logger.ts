const COLORS = {
  error: 31,
  warn: 33,
  info: 32,
  debug: 34,
} as const;

/** Minimum severity emitted by {@link createLogger}. */
export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** Minimal logging surface consumed by the runner. */
export interface LoggerLike {
  /** Report a failure that prevents an operation from completing. */
  error(...args: unknown[]): void;
  /** Report a recoverable failure or unsafe condition. */
  warn(...args: unknown[]): void;
  /** Report process lifecycle and status information. */
  info(...args: unknown[]): void;
  /** Report verbose diagnostic information. */
  debug(...args: unknown[]): void;
}

/**
 * Create a labelled console logger. Levels at or above `level` are emitted;
 * quieter levels become no-ops.
 *
 * @param label Text displayed beside each timestamp.
 * @param level Least severe level to emit. Defaults to `"info"`.
 * @returns A logger compatible with {@link ElectronRunOptions.logger}.
 */
export function createLogger(label: string, level: LogLevel = "info"): LoggerLike {
  const threshold = LEVELS.indexOf(level);

  const build = (logLevel: LogLevel) => {
    if (LEVELS.indexOf(logLevel) > threshold) {
      return () => void 0;
    }

    return (...args: unknown[]) => {
      const timestamp = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        hourCycle: "h23",
      });
      console[logLevel](`\x1b[${COLORS[logLevel]}m${timestamp} [${label}]\x1b[0m`, ...args);
    };
  };

  return {
    error: build("error"),
    warn: build("warn"),
    info: build("info"),
    debug: build("debug"),
  };
}
