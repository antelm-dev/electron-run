import { EventEmitter } from "node:events";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const watcher = { close: vi.fn(async () => {}) };
  const runnerPlugin = { name: "electron-run" };
  return {
    watcher,
    runnerPlugin,
    build: vi.fn(async () => watcher),
    electronRun: vi.fn(() => runnerPlugin),
  };
});

vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  build: mocks.build,
}));
vi.mock("../src/rollup-plugin.js", () => ({ default: mocks.electronRun }));

import electronVite from "../src/vite-plugin.js";

function hook<T extends keyof Plugin>(plugin: Plugin, name: T): (...args: any[]) => any {
  const value = plugin[name];
  return (typeof value === "object" ? value.handler : value) as (...args: any[]) => any;
}

beforeEach(() => {
  mocks.build.mockClear();
  mocks.electronRun.mockClear();
  mocks.watcher.close.mockClear();
  mocks.build.mockResolvedValue(mocks.watcher);
});

describe("electronVite", () => {
  it("builds preload before main during a production app build", async () => {
    const cwd = path.resolve("fixture");
    const plugin = electronVite({
      cwd,
      main: { input: "src/main.ts", plugins: [{ name: "main-user-plugin" }] },
      preload: { input: "src/preload.ts", plugins: [{ name: "preload-user-plugin" }] },
    });

    const envDir = path.join(cwd, "config/env");
    hook(plugin, "configResolved")({ command: "build", mode: "staging", envDir });
    await hook(plugin, "closeBundle").call({ meta: { watchMode: false } });

    expect(mocks.build).toHaveBeenCalledOnce();
    const mainConfig = mocks.build.mock.calls[0]![0];
    expect(mainConfig).toMatchObject({ mode: "staging", envDir });
    expect(mainConfig.define).toMatchObject({
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
    });
    expect(mainConfig.build?.ssr).toBe(path.join(cwd, "src/main.ts"));
    expect(mainConfig.build?.rollupOptions?.output).toMatchObject({
      entryFileNames: "index.cjs",
      format: "cjs",
      inlineDynamicImports: true,
    });

    const preloadPlugin = (mainConfig.plugins as Plugin[]).find(
      (candidate) => candidate?.name === "electron-run:preload-first",
    )!;
    await hook(preloadPlugin, "buildStart").call({ addWatchFile: vi.fn() });

    expect(mocks.build).toHaveBeenCalledTimes(2);
    const preloadConfig = mocks.build.mock.calls[1]![0];
    expect(preloadConfig).toMatchObject({ mode: "staging", envDir });
    expect(preloadConfig.define).toMatchObject({
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
    });
    expect(preloadConfig.build?.ssr).toBe(path.join(cwd, "src/preload.ts"));
    expect(preloadConfig.build?.rollupOptions?.output).toMatchObject({
      entryFileNames: "index.cjs",
      format: "cjs",
      inlineDynamicImports: true,
    });
    expect(mocks.electronRun).not.toHaveBeenCalled();
  });

  it("starts a watched build with the resolved renderer URL and closes it with Vite", async () => {
    const cwd = path.resolve("fixture");
    const plugin = electronVite({
      cwd,
      main: { input: "src/main.ts", watch: ["generated/main-state.json"] },
      runner: { stdinControls: false },
    });
    const envDir = path.join(cwd, "config/env");
    hook(plugin, "configResolved")({ command: "serve", mode: "development", envDir });

    const httpServer = Object.assign(new EventEmitter(), { listening: false });
    const server = {
      httpServer,
      resolvedUrls: { local: ["http://localhost:4173/"], network: [] },
      config: {
        server: { host: "localhost", port: 4173 },
        logger: { error: vi.fn() },
      },
    } as unknown as ViteDevServer;

    hook(plugin, "configureServer")(server);
    httpServer.emit("listening");
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());

    expect(mocks.electronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: "index.cjs",
        stdinControls: false,
        manageProcessSignals: false,
        env: { VITE_DEV_SERVER_URL: "http://localhost:4173/" },
      }),
    );
    const watchedConfig = mocks.build.mock.calls[0]![0];
    expect(watchedConfig).toMatchObject({ mode: "development", envDir });
    expect(watchedConfig.define).toMatchObject({
      "import.meta.env.DEV": "true",
      "import.meta.env.PROD": "false",
    });
    expect(watchedConfig.build?.watch).toEqual({});

    const addWatchFile = vi.fn();
    const watchPlugin = (watchedConfig.plugins as Plugin[]).find(
      (candidate) => candidate?.name === "electron-run:watch-main",
    )!;
    hook(watchPlugin, "buildStart").call({ addWatchFile });
    expect(addWatchFile).toHaveBeenCalledWith(path.join(cwd, "generated/main-state.json"));

    httpServer.emit("close");
    await vi.waitFor(() => expect(mocks.watcher.close).toHaveBeenCalledOnce());
  });

  it("allows an explicit runner setting to opt into process signal ownership", async () => {
    const plugin = electronVite({
      main: { input: "src/main.ts" },
      runner: { manageProcessSignals: true },
    });
    hook(plugin, "configResolved")({ command: "serve", mode: "development", envDir: false });
    const server = {
      httpServer: undefined,
      resolvedUrls: { local: ["http://localhost:5173/"], network: [] },
      config: { server: {}, logger: { error: vi.fn() } },
    } as unknown as ViteDevServer;

    hook(plugin, "configureServer")(server);
    await vi.waitFor(() => expect(mocks.electronRun).toHaveBeenCalledOnce());

    expect(mocks.electronRun).toHaveBeenCalledWith(
      expect.objectContaining({ manageProcessSignals: true }),
    );
  });

  it("allows target define values to override the environment defaults", async () => {
    const plugin = electronVite({
      main: {
        input: "src/main.ts",
        define: { "import.meta.env.DEV": "custom-development-flag" },
      },
    });

    hook(plugin, "configResolved")({ command: "build", mode: "production", envDir: false });
    await hook(plugin, "closeBundle").call({ meta: { watchMode: false } });

    expect(mocks.build.mock.calls[0]![0]).toMatchObject({
      envDir: false,
      define: {
        "import.meta.env.DEV": "custom-development-flag",
        "import.meta.env.PROD": "true",
      },
    });
  });
});
