import { readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import type { ExternalOption, OutputOptions, Plugin as RollupPlugin, RollupWatcher } from "rollup";
import {
  build,
  type BuildOptions,
  type InlineConfig,
  type Plugin,
  type PluginOption,
  type ViteDevServer,
} from "vite";
import electronRun from "./rollup-plugin.js";
import type { ElectronRunOptions } from "./types.js";

export interface ElectronViteTargetOptions {
  /** TypeScript or JavaScript entry file for this Electron target. */
  input: string;
  /** Exact output file. Defaults to `out/main/index.cjs` or `out/preload/index.cjs`. */
  outFile?: string;
  /** Vite and Rollup-compatible plugins applied only to this target. */
  plugins?: PluginOption[];
  /** Additional modules to keep external alongside Electron and Node built-ins. */
  external?: ExternalOption;
  /** JavaScript compilation target. Defaults to `node16`. */
  target?: BuildOptions["target"];
  /** Override source-map generation. Defaults to `true` in development. */
  sourcemap?: BuildOptions["sourcemap"];
  /** Override Vite minification. Defaults to `false`. */
  minify?: BuildOptions["minify"];
  /** Compile-time replacements scoped to this target. */
  define?: Record<string, unknown>;
  /** Extra files or directories that should trigger a rebuild. */
  watch?: string[];
}

export interface ElectronVitePluginOptions {
  /** Main-process build. */
  main: ElectronViteTargetOptions;
  /** Optional sandbox-compatible, single-file CommonJS preload build. */
  preload?: ElectronViteTargetOptions;
  /** Existing Electron process-runner options. */
  runner?: ElectronRunOptions;
  /** Base directory for entries and outputs. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment variable containing the resolved Vite renderer URL. */
  devServerUrlEnv?: string;
}

interface ResolvedTarget extends ElectronViteTargetOptions {
  input: string;
  outFile: string;
}

const DEFAULT_EXTERNALS: (string | RegExp)[] = ["electron", ...builtinModules, /^node:/];

function normalizeExternal(external?: ExternalOption): ExternalOption {
  if (!external) return DEFAULT_EXTERNALS;
  return (source, importer, isResolved) => {
    if (
      DEFAULT_EXTERNALS.some((entry) =>
        typeof entry === "string" ? entry === source : entry.test(source),
      )
    ) {
      return true;
    }
    if (typeof external === "function") return external(source, importer, isResolved);
    const entries = Array.isArray(external) ? external : [external];
    return entries.some((entry) =>
      typeof entry === "string" ? entry === source : entry.test(source),
    );
  };
}

function sourceFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(file) : [file];
    });
  } catch {
    return [];
  }
}

function resolveTarget(
  cwd: string,
  target: ElectronViteTargetOptions,
  defaultOutFile: string,
): ResolvedTarget {
  return {
    ...target,
    input: path.resolve(cwd, target.input),
    outFile: path.resolve(cwd, target.outFile ?? defaultOutFile),
    watch: target.watch?.map((file) => path.resolve(cwd, file)),
  };
}

function targetConfig(target: ResolvedTarget, development: boolean): InlineConfig {
  const output: OutputOptions = {
    entryFileNames: path.basename(target.outFile),
    format: "cjs",
    inlineDynamicImports: true,
  };

  return {
    configFile: false,
    root: path.dirname(target.input),
    logLevel: "warn",
    clearScreen: false,
    define: target.define,
    plugins: target.plugins,
    ssr: { noExternal: true },
    build: {
      ssr: target.input,
      target: target.target ?? "node16",
      outDir: path.dirname(target.outFile),
      emptyOutDir: false,
      copyPublicDir: false,
      minify: target.minify ?? false,
      sourcemap: target.sourcemap ?? development,
      rollupOptions: {
        external: normalizeExternal(target.external),
        output,
      },
    },
  };
}

function preloadFirst(preload: ResolvedTarget, development: boolean): RollupPlugin {
  return {
    name: "electron-run:preload-first",
    buildStart: {
      order: "post",
      sequential: true,
      async handler() {
        if (development) {
          this.addWatchFile(path.dirname(preload.input));
          for (const file of sourceFiles(path.dirname(preload.input))) this.addWatchFile(file);
          for (const file of preload.watch ?? []) this.addWatchFile(file);
        }
        await build(targetConfig(preload, development));
      },
    },
  };
}

function rendererUrl(server: ViteDevServer): string {
  const resolved = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
  if (resolved) return resolved;
  const host =
    typeof server.config.server.host === "string" ? server.config.server.host : "localhost";
  return `http://${host}:${server.config.server.port ?? 5173}/`;
}

/**
 * Build Electron main/preload targets from a normal Vite project and manage
 * Electron through the existing resilient runner during `vite serve`.
 *
 * The renderer remains an ordinary Vite application. The preload is rebuilt
 * before every main-process build, so Electron only restarts after both outputs
 * are ready.
 */
export default function electronVite(options: ElectronVitePluginOptions): Plugin {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const main = resolveTarget(cwd, options.main, "out/main/index.cjs");
  const preload = options.preload
    ? resolveTarget(cwd, options.preload, "out/preload/index.cjs")
    : undefined;
  const urlEnvironment = options.devServerUrlEnv ?? "VITE_DEV_SERVER_URL";
  let command: "build" | "serve" = "serve";
  let watcher: RollupWatcher | undefined;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const mainConfig = (development: boolean, url?: string): InlineConfig => {
    const config = targetConfig(main, development);
    config.plugins = [
      ...(main.plugins ?? []),
      preload && preloadFirst(preload, development),
      development &&
        electronRun({
          ...options.runner,
          cwd: options.runner?.cwd ?? cwd,
          entry: options.runner?.entry ?? path.basename(main.outFile),
          env: {
            ...options.runner?.env,
            [urlEnvironment]: url ?? "",
          },
        }),
    ];
    if (development) config.build = { ...config.build, watch: {} };
    return config;
  };

  async function startWatcher(server: ViteDevServer) {
    const result = await build(mainConfig(true, rendererUrl(server)));
    if ("close" in result) watcher = result;
  }

  function closeWatcher(): Promise<void> {
    closing ??= Promise.resolve(starting).then(async () => {
      await watcher?.close();
      watcher = undefined;
    });
    return closing;
  }

  return {
    name: "electron-run:vite",
    configResolved(config) {
      command = config.command;
    },
    async closeBundle() {
      if (command === "build") await build(mainConfig(false));
    },
    configureServer(server) {
      const start = () => {
        starting ??= startWatcher(server).catch((error: unknown) => {
          server.config.logger.error(
            `Unable to start Electron builds: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      };

      if (!server.httpServer || server.httpServer.listening) start();
      else server.httpServer.once("listening", start);
      server.httpServer?.once("close", () => void closeWatcher());
      server.watcher?.once("close", () => void closeWatcher());
    },
  };
}
