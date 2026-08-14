import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import electronVite from "../src/vite-plugin.js";

describe("electronVite consumer build", () => {
  let fixture: string | undefined;

  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  it("builds renderer, main, and a single-file CommonJS preload", async () => {
    fixture = await mkdtemp(path.join(process.cwd(), ".electron-run-vite-build-"));
    const renderer = path.join(fixture, "renderer");
    const envDir = path.join(fixture, "config/env");
    await mkdir(renderer, { recursive: true });
    await mkdir(envDir, { recursive: true });
    await writeFile(path.join(envDir, ".env.staging"), "VITE_DESKTOP_VALUE=from-staging-env\n");
    await writeFile(
      path.join(renderer, "index.html"),
      '<!doctype html><div id="app"></div><script type="module" src="/main.ts"></script>',
    );
    await writeFile(
      path.join(renderer, "main.ts"),
      'document.querySelector("#app")!.textContent = "ready";',
    );
    await writeFile(
      path.join(fixture, "main.ts"),
      'import { app } from "electron"; const version: string = app.getVersion(); console.log({ version, mode: import.meta.env.MODE, value: import.meta.env.VITE_DESKTOP_VALUE, dev: import.meta.env.DEV, prod: import.meta.env.PROD });',
    );
    await writeFile(
      path.join(fixture, "preload.ts"),
      'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("api", { mode: import.meta.env.MODE, value: import.meta.env.VITE_DESKTOP_VALUE, dev: import.meta.env.DEV, prod: import.meta.env.PROD });',
    );

    await build({
      configFile: false,
      root: renderer,
      mode: "staging",
      envDir,
      logLevel: "silent",
      plugins: [
        electronVite({
          cwd: fixture,
          main: { input: "main.ts" },
          preload: { input: "preload.ts" },
        }),
      ],
      build: {
        outDir: path.join(fixture, "out/renderer"),
        emptyOutDir: true,
      },
    });

    const mainOutput = path.join(fixture, "out/main/index.cjs");
    const preloadOutput = path.join(fixture, "out/preload/index.cjs");
    expect(existsSync(path.join(fixture, "out/renderer/index.html"))).toBe(true);
    expect(existsSync(mainOutput)).toBe(true);
    expect(existsSync(preloadOutput)).toBe(true);
    const mainBundle = await readFile(mainOutput, "utf8");
    const preloadBundle = await readFile(preloadOutput, "utf8");
    expect(mainBundle).toContain('require("electron")');
    expect(preloadBundle).toContain('require("electron")');
    for (const bundle of [mainBundle, preloadBundle]) {
      expect(bundle).toContain("staging");
      expect(bundle).toContain("from-staging-env");
      expect(bundle).toMatch(/dev:\s*false/);
      expect(bundle).toMatch(/prod:\s*true/);
    }
  });

  it("rebuilds and relaunches when an extra main watch path changes", async () => {
    fixture = await mkdtemp(path.join(process.cwd(), ".electron-run-vite-watch-"));
    const renderer = path.join(fixture, "renderer");
    const mainSource = path.join(fixture, "main.ts");
    const watchedState = path.join(fixture, "main-state.txt");
    const marker = path.join(fixture, "launch.txt");
    await mkdir(renderer, { recursive: true });
    await writeFile(path.join(renderer, "index.html"), "<!doctype html><h1>ready</h1>");

    await writeFile(watchedState, "first");
    await writeFile(
      mainSource,
      `import { readFileSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, readFileSync(${JSON.stringify(watchedState)}, "utf8"));`,
    );

    const server = await createServer({
      configFile: false,
      root: renderer,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        electronVite({
          cwd: fixture,
          main: { input: "main.ts", watch: ["main-state.txt"] },
          runner: {
            electronPath: process.execPath,
            stdinControls: false,
            debounceMs: 10,
          },
        }),
      ],
    });

    try {
      await server.listen();
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("first"), {
        timeout: 10_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(watchedState, "second-build");
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("second-build"), {
        timeout: 10_000,
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it("maps development main-process stacks back to TypeScript source", async () => {
    fixture = await mkdtemp(path.join(process.cwd(), ".electron-run-vite-trace-"));
    const renderer = path.join(fixture, "renderer");
    const stackFile = path.join(fixture, "stack.txt");
    await mkdir(renderer, { recursive: true });
    await writeFile(path.join(renderer, "index.html"), "<!doctype html><h1>ready</h1>");
    await writeFile(
      path.join(fixture, "main.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        "function captureMappedStack(): void {",
        `  writeFileSync(${JSON.stringify(stackFile)}, new Error("mapped trace").stack ?? "");`,
        "}",
        "captureMappedStack();",
      ].join("\n"),
    );

    const server = await createServer({
      configFile: false,
      root: renderer,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        electronVite({
          cwd: fixture,
          main: { input: "main.ts" },
          runner: {
            electronPath: process.execPath,
            stdinControls: false,
            env: { ELECTRON_RUN_TRACE_TEST: "preserved" },
          },
        }),
      ],
    });

    try {
      await server.listen();
      await vi.waitFor(async () => expect(existsSync(stackFile)).toBe(true), { timeout: 10_000 });
      const stack = await readFile(stackFile, "utf8");
      expect(stack).toContain("main.ts:3:");
    } finally {
      await server.close();
    }
  }, 20_000);
});
