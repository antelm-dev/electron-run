# vite-plugin-electron-run

[![CI](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml/badge.svg)](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vite-plugin-electron-run)](https://www.npmjs.com/package/vite-plugin-electron-run)
[![node](https://img.shields.io/node/v/vite-plugin-electron-run)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/vite-plugin-electron-run)](LICENSE)

Build and live-reload Electron from a normal Vite or Rollup project.

- Builds TypeScript main and preload targets alongside a Vite renderer
- Keeps the renderer framework-neutral and preserves target-scoped plugins
- Builds a sandbox-compatible preload before the main-process bundle
- Restarts Electron after each bundle write
- Stops the previous process before relaunching
- Cleans up the process tree when the watcher exits
- Provides interactive restart controls in the terminal
- Has zero runtime dependencies

## Install

```bash
npm install --save-dev vite-plugin-electron-run
```

This package was previously published as `rollup-plugin-electron-run`. The
package root now exports the Vite plugin; use the `/rollup-plugin` entry point
for a Rollup configuration.

Requires Node.js 18 or newer and Electron. Vite 5–7 or Rollup 4 or newer is
required only when using its corresponding plugin. The package is ESM-only.

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
development, `VITE_DEV_SERVER_URL` contains Vite's resolved renderer URL.

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

Set `stdinControls: false` to disable these commands.

## Options

These process options are accepted by the Rollup plugin, standalone runner,
and the Vite plugin's `runner` property.

| Option           | Type                     | Default          | Description                                     |
| ---------------- | ------------------------ | ---------------- | ----------------------------------------------- |
| `entry`          | `string`                 | `"main.js"`      | Entry file relative to the bundle output        |
| `electronPath`   | `string`                 | resolved locally | Path to the Electron binary                     |
| `debounceMs`     | `number`                 | `150`            | Delay before restarting after a rebuild         |
| `additionalArgs` | `string[]`               | `[]`             | Arguments passed to Electron before the entry   |
| `cwd`            | `string`                 | `process.cwd()`  | Working directory for Electron                  |
| `env`            | `Record<string, string>` | `{}`             | Environment variables merged with `process.env` |
| `stdinControls`  | `boolean`                | `true`           | Enable interactive terminal commands            |
| `clearScreen`    | `boolean`                | `false`          | Clear the terminal before launching             |
| `logger`         | `LoggerLike`             | console logger   | Custom `error`/`warn`/`info`/`debug` logger     |

## Standalone runner

Use the runner directly with another bundler or a custom watcher:

```ts
import { createElectronRunner } from "vite-plugin-electron-run/runner";

const runner = createElectronRunner({ entry: "main.js" });

runner.scheduleRestart({ dir: "dist" }, "rebuild");

// When your watcher shuts down:
await runner.close();
```

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

## License

MIT © [Adel Terki](LICENSE)
