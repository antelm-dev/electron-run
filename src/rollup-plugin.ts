import type { OutputOptions, Plugin } from "rollup";
import { createElectronRunner, type ElectronRunner } from "./core.js";
import type { ElectronRunOptions } from "./types.js";
import { validateElectronRunOptions } from "./validation.js";

export type { ElectronRunOptions } from "./types.js";

/**
 * Rollup plugin that (re)launches Electron on every bundle write and shuts the
 * process down when the watcher closes.
 *
 * Inert outside watch mode: a one-shot `rollup -c` must not spawn an app and
 * hang the build.
 *
 * @param options Electron runner options shared across rebuilds.
 * @returns A Rollup plugin that owns the Electron runner during watch mode.
 *
 * @example
 * ```js
 * import electronRun from "vite-plugin-electron-run/rollup-plugin";
 *
 * export default {
 *   input: "src/main.ts",
 *   output: { dir: "dist", format: "cjs" },
 *   plugins: [electronRun({ entry: "main.js" })],
 * };
 * ```
 */
export default function electronRun(options?: ElectronRunOptions): Plugin {
  validateElectronRunOptions(options ?? {});
  let runner: ElectronRunner | undefined;

  return {
    name: "electron-run",
    buildStart() {
      if (this.meta.watchMode && !runner) {
        runner = createElectronRunner(options);
      }
    },
    writeBundle(output: OutputOptions) {
      runner?.scheduleRestart(output, "rebuild");
    },
    async closeWatcher() {
      await runner?.close();
      runner = undefined;
    },
  };
}
