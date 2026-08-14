# vite-plugin-electron-run

[![CI](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml/badge.svg)](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vite-plugin-electron-run)](https://www.npmjs.com/package/vite-plugin-electron-run)
[![node](https://img.shields.io/node/v/vite-plugin-electron-run)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/vite-plugin-electron-run)](https://github.com/antelm-dev/electron-run/blob/master/LICENSE)

Build and live-reload Electron from a normal Vite or Rollup project.

- Builds TypeScript main and preload targets alongside a Vite renderer
- Keeps the renderer framework-neutral and preserves target-scoped plugins
- Builds a sandbox-compatible preload before the main-process bundle
- Restarts Electron after each bundle write
- Stops the previous process before relaunching
- Cleans up the process tree when the watcher closes and reclaims stale processes on restart
- Provides interactive restart controls in the terminal
- Has zero runtime dependencies

## Install

```bash
npm install --save-dev vite-plugin-electron-run
```

This package was previously published as `rollup-plugin-electron-run`. The
package root now exports the Vite plugin; use the `/rollup-plugin` entry point
for a Rollup configuration.

Requires Node.js 18 or newer and Electron 20 or newer. Vite 5–7 or Rollup 4 or
newer is required only when using its corresponding plugin. The package is
ESM-only.

## Usage

### Vite

Use the Vite plugin when one configuration should serve/build the renderer,
bundle main and preload code, and manage Electron during development:

```ts
// vite.config.ts
import electron from "vite-plugin-electron-run";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [
    electron({
      main: { input: "src/main/index.ts" },
      preload: { input: "src/preload/index.ts" },
    }),
  ],
  build: { outDir: "../../out/renderer" },
});
```

Then use the ordinary Vite commands:

```bash
vite        # renderer HMR, watched Electron builds, and Electron launch
vite build  # renderer, preload, and main production outputs
```

Defaults are `out/main/index.cjs` and `out/preload/index.cjs`. Vite handles
TypeScript and dependency bundling; Electron and Node built-ins stay external.
The preload is emitted as one CommonJS file for sandboxed renderers. During
development, `process.env.VITE_DEV_SERVER_URL` contains Vite's resolved renderer
URL. Use it in the main process and fall back to the built renderer in
production:

```ts
import path from "node:path";
import { app, BrowserWindow } from "electron";

async function createWindow() {
  const window = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(createWindow);
```

`vite build` produces the renderer, preload, and main bundles. Packaging,
code-signing, and application distribution remain the responsibility of an
Electron packager such as Electron Forge or electron-builder.

Main and preload builds inherit the resolved renderer `mode` and `envDir`, so
the same `.env`, `.env.local`, and mode-specific files supply their
`VITE_*` values. The plugin defines `import.meta.env.DEV` as `true` and
`import.meta.env.PROD` as `false` for watched `vite serve` targets, with the
values reversed for `vite build`. This avoids inheriting an ambiguous
`NODE_ENV` from tools that call Vite's JavaScript API. Use
`process.env.VITE_DEV_SERVER_URL` for the live renderer URL. Target-level
`define` values are applied last and can explicitly override these defaults.

Unless a target is set explicitly, the plugin reads the consuming project's
installed `electron/package.json` and chooses the matching Node build target:
Electron 20–22 uses `node16`, 23–28 uses `node18`, 29–34 uses `node20`, 35–39
uses `node22`, and 40 or newer uses `node24`. If Electron metadata is missing
or malformed, the plugin reports the reason once and conservatively falls back
to `node16`. Explicit `target` values always win for both main and preload.

Development main builds emit source maps by default. The runner adds Node's
source-map support so uncaught errors and captured stacks point back to the
original TypeScript source. Existing `runner.env.NODE_OPTIONS`, other runner
environment variables, `additionalArgs`, and the renderer URL variable are
preserved. Set `main.sourcemap: false` to disable both map emission and the
injected source-map flag; production behavior is unchanged.

Rollup-compatible plugins remain target-scoped. For example, attach the
`electron-ipc-module` bridge generator to the main build:

```ts
import ipcBridge from "electron-ipc-module/rollup-plugin";

electron({
  main: {
    input: "src/main/index.ts",
    plugins: [
      ipcBridge({
        ipcDir: "src/main/ipc",
        outFile: "src/preload/generated/ipc-bridge.ts",
        tsconfig: "tsconfig.main.json",
      }),
    ],
  },
  preload: { input: "src/preload/index.ts" },
});
```

Each target also accepts `outFile`, `external`, `target`, `sourcemap`, `minify`,
`define`, and extra `watch` paths. Pass existing process options under `runner`:

```ts
electron({
  main: { input: "src/main/index.ts" },
  runner: { additionalArgs: ["--inspect"], stdinControls: false },
});
```

### Rollup

Add the plugin to your Rollup configuration:

```js
// rollup.config.mjs
import electronRun from "vite-plugin-electron-run/rollup-plugin";

export default {
  input: "src/main.ts",
  output: { dir: "dist", format: "cjs" },
  plugins: [
    electronRun({
      entry: "main.js",
    }),
  ],
};
```

Start Rollup in watch mode:

```bash
npx rollup --config --watch
```

Electron restarts after every successful rebuild. The plugin does nothing during
a regular, non-watch build.

## Interactive commands

Type a command and press <kbd>Enter</kbd> while the watcher is running:

| Command         | Action                           |
| --------------- | -------------------------------- |
| `rs`, `restart` | Restart Electron                 |
| `start`         | Start Electron if it is stopped  |
| `stop`          | Stop Electron                    |
| `status`        | Show whether Electron is running |
| `clear`, `cls`  | Clear the terminal               |
| `help`          | Show available commands          |

Commands are available only when the watcher owns an interactive TTY. Set
`stdinControls: false` to disable them.

## Options

### Vite plugin

| Option            | Type                        | Default                 | Description                                      |
| ----------------- | --------------------------- | ----------------------- | ------------------------------------------------ |
| `main`            | `ElectronViteTargetOptions` | required                | Main-process build                               |
| `preload`         | `ElectronViteTargetOptions` | none                    | Optional single-file CommonJS preload build      |
| `runner`          | `ElectronRunOptions`        | `{}`                    | Electron process options; Vite owns host signals |
| `cwd`             | `string`                    | `process.cwd()`         | Base directory for target inputs and outputs     |
| `devServerUrlEnv` | `string`                    | `"VITE_DEV_SERVER_URL"` | Environment variable receiving the renderer URL  |

Each main or preload target accepts these options:

| Option      | Type                        | Default                                         | Description                                   |
| ----------- | --------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `input`     | `string`                    | required                                        | TypeScript or JavaScript entry file           |
| `outFile`   | `string`                    | `out/main/index.cjs` or `out/preload/index.cjs` | Exact output file                             |
| `plugins`   | `PluginOption[]`            | `[]`                                            | Target-scoped Vite/Rollup plugins             |
| `external`  | `ExternalOption`            | Electron and Node built-ins                     | Additional modules to keep external           |
| `target`    | `BuildOptions["target"]`    | detected from Electron (`node16` fallback)      | JavaScript compilation target                 |
| `sourcemap` | `BuildOptions["sourcemap"]` | `true` during development                       | Source-map generation                         |
| `minify`    | `BuildOptions["minify"]`    | `false`                                         | Vite minification setting                     |
| `define`    | `Record<string, unknown>`   | none                                            | Target-scoped compile-time replacements       |
| `watch`     | `string[]`                  | `[]`                                            | Extra paths that trigger development rebuilds |

### Process runner

These options are accepted by the Rollup plugin, standalone runner, and the
Vite plugin's `runner` property.

| Option                 | Type                     | Default          | Description                                                         |
| ---------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------- |
| `entry`                | `string`                 | `"main.js"`      | Entry relative to the output; Vite uses the `main.outFile` basename |
| `electronPath`         | `string`                 | resolved locally | Path to the Electron binary                                         |
| `debounceMs`           | `number`                 | `150`            | Delay before restarting after a rebuild                             |
| `additionalArgs`       | `string[]`               | `[]`             | Arguments passed to Electron before the entry                       |
| `cwd`                  | `string`                 | `process.cwd()`  | Working directory for Electron                                      |
| `env`                  | `Record<string, string>` | `{}`             | Environment variables merged with `process.env`                     |
| `stdinControls`        | `boolean`                | `true`           | Enable interactive terminal commands                                |
| `manageProcessSignals` | `boolean`                | see below        | Stop Electron and exit the host on `SIGINT`, `SIGTERM`, or `SIGHUP` |
| `clearScreen`          | `boolean`                | `false`          | Clear the terminal before launching                                 |
| `logger`               | `LoggerLike`             | console logger   | Custom `error`/`warn`/`info`/`debug` logger                         |

The standalone runner and Rollup plugin default `manageProcessSignals` to
`true`, preserving their ownership of process shutdown. The Vite plugin is
embedded in Vite's dev server and defaults it to `false`, so Ctrl-C can finish
Vite's asynchronous shutdown before the watched build closes the runner and
stops Electron. An explicit `runner.manageProcessSignals` value always wins.

### Configuration validation

All three public entry points validate their options before starting build or
launch work. A single `Invalid electron-run configuration` error lists every
detectable problem in option-path order, including unknown keys and invalid
value shapes. Filesystem errors include the resolved absolute path, for
example:

```text
Invalid electron-run configuration:
- main.input: expected a readable file (resolved: /project/src/mian.ts)
- main.outFile: must stay within the project directory (resolved: /shared/main.cjs)
```

For the Vite plugin, `cwd` must be a readable directory. Each `main.input` and
`preload.input` must already be a readable file, and every extra `watch` entry
must already be a readable file or directory. Inputs, outputs, and watch paths
must resolve inside `cwd`; traversal, absolute paths outside the project, and
symlinks that escape it are rejected. Output files may be generated later and
therefore do not need to exist when the plugin is configured.

Standalone and Rollup runner options are checked when their public API is
called, before signal or stdin listeners are registered. The runner entry is a
generated bundle artifact, so it is not required during runner construction;
it is resolved and checked when `scheduleRestart` receives the completed bundle
location. `output.dir` and `output.file` cannot be supplied together.

## Standalone runner

Use the runner directly with another bundler or a custom watcher:

```ts
import { createElectronRunner } from "vite-plugin-electron-run/runner";

const runner = createElectronRunner({ entry: "main.js" });

runner.scheduleRestart({ dir: "dist" }, "rebuild");

// When your watcher shuts down:
await runner.close();
```

Standalone runners own process signals by default. Set
`manageProcessSignals: false` when embedding one in a host that owns shutdown,
and make that host await `runner.close()` from its close hook.

The runner stores process identity records under
`node_modules/.cache/electron-run/`. A normal watcher close stops the process
tree immediately. If the watcher terminates before cleanup can finish, the next
launch verifies the saved operating-system identity before reclaiming the stale
process, avoiding accidental termination after PID reuse.

See the [API reference](https://antelm-dev.github.io/electron-run/) for complete
types and signatures.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm fmt:check
```

### Prereleases

Prerelease tags publish automatically to npm under the `next` dist-tag without
moving `latest`. The tag must point at a commit whose `package.json` version is
the same prerelease version:

```bash
pnpm version 1.0.0-alpha.1 --no-git-tag-version
git add package.json pnpm-lock.yaml
git commit -m "chore: prepare 1.0.0-alpha.1"
git tag v1.0.0-alpha.1
git push origin HEAD v1.0.0-alpha.1
```

The release workflow runs the complete package checks before publishing with
npm trusted publishing and provenance. It can also be run manually with an
existing tag to retry an interrupted stable or prerelease publication. Stable
versions remain managed by the release-please PR flow.

## License

MIT © [Adel Terki](https://github.com/antelm-dev/electron-run/blob/master/LICENSE)
