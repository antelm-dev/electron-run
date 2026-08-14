import type { Plugin } from "rollup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createElectronRunner, runner } = vi.hoisted(() => {
  const runner = { scheduleRestart: vi.fn(), close: vi.fn(async () => {}) };
  return { runner, createElectronRunner: vi.fn(() => runner) };
});

vi.mock("../src/core.js", () => ({ createElectronRunner }));

import electronRun from "../src/rollup-plugin.js";

/** Call a plugin hook with a minimal Rollup plugin context. */
function callHook(
  plugin: Plugin,
  name: "buildStart" | "writeBundle" | "closeWatcher",
  watchMode: boolean,
) {
  const hook = plugin[name] as unknown as (this: unknown, ...args: unknown[]) => unknown;
  return hook.call({ meta: { watchMode } }, { dir: "dist" });
}

beforeEach(() => {
  createElectronRunner.mockClear();
  runner.scheduleRestart.mockClear();
  runner.close.mockClear();
});

describe("electronRun", () => {
  it("does nothing for a one-shot build", async () => {
    const plugin = electronRun();

    callHook(plugin, "buildStart", false);
    callHook(plugin, "writeBundle", false);

    expect(createElectronRunner).not.toHaveBeenCalled();
    expect(runner.scheduleRestart).not.toHaveBeenCalled();
  });

  it("restarts Electron on every write in watch mode", async () => {
    const plugin = electronRun({ entry: "app.js", manageProcessSignals: false });

    callHook(plugin, "buildStart", true);
    callHook(plugin, "writeBundle", true);
    callHook(plugin, "writeBundle", true);

    expect(createElectronRunner).toHaveBeenCalledWith({
      entry: "app.js",
      manageProcessSignals: false,
    });
    expect(runner.scheduleRestart).toHaveBeenCalledTimes(2);
    expect(runner.scheduleRestart).toHaveBeenLastCalledWith({ dir: "dist" }, "rebuild");
  });

  it("creates a single runner across rebuilds and closes it with the watcher", async () => {
    const plugin = electronRun();

    callHook(plugin, "buildStart", true);
    callHook(plugin, "buildStart", true);
    expect(createElectronRunner).toHaveBeenCalledOnce();

    await callHook(plugin, "closeWatcher", true);
    expect(runner.close).toHaveBeenCalledOnce();
  });
});
