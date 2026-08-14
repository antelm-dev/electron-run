import fs from "node:fs";
import path from "node:path";
import type { LoggerLike } from "./logger.js";
import type { BundleOutputLocation, ElectronRunOptions } from "./types.js";

interface ValidationIssue {
  optionPath: string;
  message: string;
  resolvedPath?: string;
}

export interface ValidatedViteTarget {
  input: string;
  outFile: string;
  plugins?: unknown[];
  external?: unknown;
  target?: unknown;
  sourcemap?: unknown;
  minify?: unknown;
  define?: Record<string, unknown>;
  watch?: string[];
}

export interface ValidatedViteOptions {
  cwd: string;
  main: ValidatedViteTarget;
  preload?: ValidatedViteTarget;
  runner?: ElectronRunOptions;
  devServerUrlEnv: string;
}

const RUNNER_KEYS = [
  "entry",
  "electronPath",
  "debounceMs",
  "additionalArgs",
  "cwd",
  "env",
  "stdinControls",
  "clearScreen",
  "manageProcessSignals",
  "logger",
] as const;
const VITE_KEYS = ["main", "preload", "runner", "cwd", "devServerUrlEnv"] as const;
const TARGET_KEYS = [
  "input",
  "outFile",
  "plugins",
  "external",
  "target",
  "sourcemap",
  "minify",
  "define",
  "watch",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  issues: ValidationIssue[],
) {
  for (const key of Object.keys(value)
    .filter((key) => !known.includes(key))
    .sort()) {
    issues.push({ optionPath: `${prefix}.${key}`, message: "unknown option" });
  }
}

function expectString(
  value: unknown,
  optionPath: string,
  issues: ValidationIssue[],
): value is string {
  if (typeof value === "string" && value.length > 0) return true;
  issues.push({ optionPath, message: "expected a non-empty string" });
  return false;
}

function expectStringArray(value: unknown, optionPath: string, issues: ValidationIssue[]) {
  if (!Array.isArray(value)) {
    issues.push({ optionPath, message: "expected an array of strings" });
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      valid = false;
      issues.push({
        optionPath: `${optionPath}[${index}]`,
        message: "expected a non-empty string",
      });
    }
  });
  return valid;
}

function accessibleKind(file: string): "file" | "directory" | undefined {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    const stat = fs.statSync(file);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
  } catch {
    // Report a single stable diagnostic below.
  }
  return undefined;
}

function pathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function physicalPath(file: string): string {
  let existing = file;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return file;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...missing);
  } catch {
    return file;
  }
}

function validateProjectPath(
  project: string,
  value: unknown,
  optionPath: string,
  expected: "file" | "directory" | "file or directory" | "output",
  issues: ValidationIssue[],
): string | undefined {
  if (!expectString(value, optionPath, issues)) return undefined;
  const resolved = path.resolve(project, value);
  const physicalProject = physicalPath(project);
  const physicalResolved = physicalPath(resolved);
  if (!pathWithin(project, resolved) || !pathWithin(physicalProject, physicalResolved)) {
    issues.push({
      optionPath,
      message: "must stay within the project directory",
      resolvedPath: resolved,
    });
    return resolved;
  }
  if (expected === "output") {
    const kind = accessibleKind(resolved);
    if (kind === "directory") {
      issues.push({
        optionPath,
        message: "expected an output file path, but found a directory",
        resolvedPath: resolved,
      });
    }
    return resolved;
  }
  const kind = accessibleKind(resolved);
  if (kind !== expected && !(expected === "file or directory" && kind)) {
    issues.push({ optionPath, message: `expected a readable ${expected}`, resolvedPath: resolved });
  }
  return resolved;
}

function validateLogger(value: unknown, optionPath: string, issues: ValidationIssue[]) {
  if (!isRecord(value)) {
    issues.push({ optionPath, message: "expected a logger object" });
    return;
  }
  for (const method of ["error", "warn", "info", "debug"] satisfies (keyof LoggerLike)[]) {
    if (typeof value[method] !== "function") {
      issues.push({ optionPath: `${optionPath}.${method}`, message: "expected a function" });
    }
  }
}

function validateRunnerRecord(
  value: unknown,
  prefix: string,
  issues: ValidationIssue[],
): value is ElectronRunOptions {
  if (!isRecord(value)) {
    issues.push({ optionPath: prefix, message: "expected an options object" });
    return false;
  }
  addUnknownKeys(value, RUNNER_KEYS, prefix, issues);
  for (const key of ["entry", "electronPath", "cwd"] as const) {
    if (value[key] !== undefined) expectString(value[key], `${prefix}.${key}`, issues);
  }
  if (
    value.debounceMs !== undefined &&
    (typeof value.debounceMs !== "number" ||
      !Number.isFinite(value.debounceMs) ||
      value.debounceMs < 0)
  ) {
    issues.push({
      optionPath: `${prefix}.debounceMs`,
      message: "expected a finite non-negative number",
    });
  }
  if (value.additionalArgs !== undefined) {
    expectStringArray(value.additionalArgs, `${prefix}.additionalArgs`, issues);
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      issues.push({ optionPath: `${prefix}.env`, message: "expected an object of string values" });
    } else {
      for (const key of Object.keys(value.env).sort()) {
        if (typeof value.env[key] !== "string") {
          issues.push({ optionPath: `${prefix}.env.${key}`, message: "expected a string" });
        }
      }
    }
  }
  for (const key of ["stdinControls", "clearScreen", "manageProcessSignals"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      issues.push({ optionPath: `${prefix}.${key}`, message: "expected a boolean" });
    }
  }
  if (value.logger !== undefined) validateLogger(value.logger, `${prefix}.logger`, issues);
  return true;
}

function validateRunnerPaths(
  options: Record<string, unknown>,
  prefix: string,
  issues: ValidationIssue[],
) {
  const cwd = path.resolve(
    typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd(),
  );
  if (accessibleKind(cwd) !== "directory") {
    issues.push({
      optionPath: `${prefix}.cwd`,
      message: "expected a readable directory",
      resolvedPath: cwd,
    });
  }
  if (typeof options.electronPath === "string" && options.electronPath) {
    const electronPath = path.resolve(cwd, options.electronPath);
    if (accessibleKind(electronPath) !== "file") {
      issues.push({
        optionPath: `${prefix}.electronPath`,
        message: "expected a readable file",
        resolvedPath: electronPath,
      });
    }
  }
}

function throwIssues(issues: ValidationIssue[]): void {
  if (!issues.length) return;
  issues.sort(
    (left, right) =>
      (left.optionPath < right.optionPath ? -1 : left.optionPath > right.optionPath ? 1 : 0) ||
      (left.message < right.message ? -1 : left.message > right.message ? 1 : 0),
  );
  throw new Error(
    `Invalid electron-run configuration:\n${issues
      .map(
        ({ optionPath, message, resolvedPath }) =>
          `- ${optionPath}: ${message}${resolvedPath ? ` (resolved: ${resolvedPath})` : ""}`,
      )
      .join("\n")}`,
  );
}

/** Validate options known when a standalone or Rollup runner is created. */
export function validateElectronRunOptions(
  options: unknown,
  prefix = "options",
): asserts options is ElectronRunOptions {
  const issues: ValidationIssue[] = [];
  if (validateRunnerRecord(options, prefix, issues) && isRecord(options)) {
    validateRunnerPaths(options, prefix, issues);
  }
  throwIssues(issues);
}

/** Validate a post-build output descriptor and resolve its generated runner entry. */
export function validateBundleEntry(
  output: unknown,
  cwd: string,
  entry: string,
): { output: BundleOutputLocation; entryFile: string } {
  const issues: ValidationIssue[] = [];
  if (!isRecord(output)) {
    issues.push({ optionPath: "output", message: "expected an output object" });
    throwIssues(issues);
  }
  const outputRecord = output as Record<string, unknown>;
  if (outputRecord.dir !== undefined && typeof outputRecord.dir !== "string") {
    issues.push({ optionPath: "output.dir", message: "expected a non-empty string" });
  }
  if (outputRecord.file !== undefined && typeof outputRecord.file !== "string") {
    issues.push({ optionPath: "output.file", message: "expected a non-empty string" });
  }
  if (typeof outputRecord.dir === "string" && outputRecord.dir.length === 0) {
    issues.push({ optionPath: "output.dir", message: "expected a non-empty string" });
  }
  if (typeof outputRecord.file === "string" && outputRecord.file.length === 0) {
    issues.push({ optionPath: "output.file", message: "expected a non-empty string" });
  }
  if (outputRecord.dir !== undefined && outputRecord.file !== undefined) {
    issues.push({ optionPath: "output.dir", message: "cannot be combined with output.file" });
    issues.push({ optionPath: "output.file", message: "cannot be combined with output.dir" });
  }
  const outDir =
    typeof outputRecord.dir === "string" && outputRecord.dir
      ? path.resolve(cwd, outputRecord.dir)
      : typeof outputRecord.file === "string" && outputRecord.file
        ? path.dirname(path.resolve(cwd, outputRecord.file))
        : cwd;
  const entryFile = path.resolve(outDir, entry);
  if (
    !pathWithin(outDir, entryFile) ||
    !pathWithin(physicalPath(outDir), physicalPath(entryFile))
  ) {
    issues.push({
      optionPath: "options.entry",
      message: "must stay within the bundle output directory",
      resolvedPath: entryFile,
    });
  }
  if (accessibleKind(entryFile) !== "file") {
    issues.push({
      optionPath: "options.entry",
      message: "expected a readable generated file",
      resolvedPath: entryFile,
    });
  }
  throwIssues(issues);
  return { output: outputRecord as BundleOutputLocation, entryFile };
}

function validateTarget(
  value: unknown,
  prefix: "main" | "preload",
  project: string,
  defaultOutFile: string,
  issues: ValidationIssue[],
): ValidatedViteTarget | undefined {
  if (!isRecord(value)) {
    issues.push({ optionPath: prefix, message: "expected a target options object" });
    return undefined;
  }
  addUnknownKeys(value, TARGET_KEYS, prefix, issues);
  const input = validateProjectPath(project, value.input, `${prefix}.input`, "file", issues);
  const outFile = validateProjectPath(
    project,
    value.outFile ?? defaultOutFile,
    `${prefix}.outFile`,
    "output",
    issues,
  );
  if (value.plugins !== undefined && !Array.isArray(value.plugins)) {
    issues.push({ optionPath: `${prefix}.plugins`, message: "expected an array" });
  }
  if (value.external !== undefined) {
    const entries = Array.isArray(value.external) ? value.external : [value.external];
    if (
      !entries.every(
        (entry) =>
          typeof entry === "string" || entry instanceof RegExp || typeof entry === "function",
      )
    ) {
      issues.push({
        optionPath: `${prefix}.external`,
        message: "expected a string, regular expression, function, or an array of them",
      });
    }
  }
  if (value.target !== undefined) {
    const valid =
      value.target === false ||
      (typeof value.target === "string" && value.target.length > 0) ||
      (Array.isArray(value.target) &&
        value.target.every((entry) => typeof entry === "string" && entry.length > 0));
    if (!valid)
      issues.push({
        optionPath: `${prefix}.target`,
        message: "expected false, a target string, or an array of target strings",
      });
  }
  if (
    value.sourcemap !== undefined &&
    typeof value.sourcemap !== "boolean" &&
    value.sourcemap !== "inline" &&
    value.sourcemap !== "hidden"
  ) {
    issues.push({
      optionPath: `${prefix}.sourcemap`,
      message: 'expected a boolean, "inline", or "hidden"',
    });
  }
  if (
    value.minify !== undefined &&
    typeof value.minify !== "boolean" &&
    value.minify !== "esbuild" &&
    value.minify !== "terser"
  ) {
    issues.push({
      optionPath: `${prefix}.minify`,
      message: 'expected a boolean, "esbuild", or "terser"',
    });
  }
  if (value.define !== undefined && !isRecord(value.define)) {
    issues.push({ optionPath: `${prefix}.define`, message: "expected an object" });
  }
  let watch: string[] | undefined;
  if (value.watch !== undefined && expectStringArray(value.watch, `${prefix}.watch`, issues)) {
    watch = (value.watch as string[])
      .map((entry, index) =>
        validateProjectPath(
          project,
          entry,
          `${prefix}.watch[${index}]`,
          "file or directory",
          issues,
        ),
      )
      .filter((entry): entry is string => Boolean(entry));
  }
  if (!input || !outFile) return undefined;
  return {
    ...value,
    input,
    outFile,
    plugins: value.plugins as unknown[] | undefined,
    define: value.define as Record<string, unknown> | undefined,
    watch,
  };
}

/** Validate and resolve all paths accepted by the Vite plugin boundary. */
export function validateVitePluginOptions(options: unknown): ValidatedViteOptions {
  const issues: ValidationIssue[] = [];
  if (!isRecord(options)) {
    issues.push({ optionPath: "options", message: "expected an options object" });
    throwIssues(issues);
  }
  const optionRecord = options as Record<string, unknown>;
  addUnknownKeys(optionRecord, VITE_KEYS, "options", issues);
  const cwdValue = optionRecord.cwd ?? process.cwd();
  const cwd =
    typeof cwdValue === "string" && cwdValue ? path.resolve(cwdValue) : path.resolve(process.cwd());
  if (!expectString(cwdValue, "cwd", issues) || accessibleKind(cwd) !== "directory") {
    if (typeof cwdValue === "string" && cwdValue) {
      issues.push({
        optionPath: "cwd",
        message: "expected a readable directory",
        resolvedPath: cwd,
      });
    }
  }
  const main = validateTarget(optionRecord.main, "main", cwd, "out/main/index.cjs", issues);
  const preload =
    optionRecord.preload === undefined
      ? undefined
      : validateTarget(optionRecord.preload, "preload", cwd, "out/preload/index.cjs", issues);
  if (
    optionRecord.runner !== undefined &&
    validateRunnerRecord(optionRecord.runner, "runner", issues) &&
    isRecord(optionRecord.runner)
  ) {
    validateRunnerPaths(optionRecord.runner, "runner", issues);
  }
  if (optionRecord.devServerUrlEnv !== undefined) {
    expectString(optionRecord.devServerUrlEnv, "devServerUrlEnv", issues);
  }
  throwIssues(issues);
  return {
    cwd,
    main: main!,
    preload,
    runner: optionRecord.runner as ElectronRunOptions | undefined,
    devServerUrlEnv:
      typeof optionRecord.devServerUrlEnv === "string"
        ? optionRecord.devServerUrlEnv
        : "VITE_DEV_SERVER_URL",
  };
}
