import type { OutputOptions, Plugin } from "rollup";
import { createElectronRunner, type ElectronRunner } from "./core.js";
import type { ElectronRunOptions } from "./types.js";

export type { ElectronRunOptions } from "./types.js";

/**
 * Rollup plugin that (re)launches Electron on every bundle write and shuts the
 * process down when the watcher closes.
 *
 * Inert outside watch mode: a one-shot `rollup -c` must not spawn an app and
 * hang the build.
 */
export default function electronRun(options?: ElectronRunOptions): Plugin {
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
