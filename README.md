# electron-run

Live-reload for Electron during development. Drop it into a Rollup watch config and it (re)launches your Electron app on every rebuild, cleans up orphaned processes, and gives you interactive restart controls from the terminal.

## Features

- Rollup plugin that restarts Electron on each bundle write (debounced), inert outside watch mode
- Waits for the previous process to actually exit before relaunching, escalating to `SIGKILL` if needed
- Tracks process identity via pid files, stops the whole tree on confirmed shutdown, and retains crash-recovery state
- Interactive stdin commands: `rs`, `start`, `stop`, `status`, `clear`, `help`
- Clean shutdown on `SIGINT` / `SIGTERM` / `SIGHUP`
- Zero runtime dependencies; pluggable logger

## Installation

```bash
npm install --save-dev rollup-plugin-electron-run
```

**Peer dependencies:** `electron` (provided by your app) and `rollup >= 4` (only if you use the plugin).

This package is ESM-only and requires Node.js 18 or newer. Load it with
`import` or dynamic `import()`; CommonJS `require()` is not supported.

## Quick start

### As a Rollup plugin

```js
// rollup.config.mjs
import electronRun from "rollup-plugin-electron-run";

export default {
  input: "src/main.ts",
  output: { dir: "dist", format: "cjs" },
  plugins: [
    // ...your build plugins
    electronRun({
      entry: "main.js", // resolved against the output dir
      additionalArgs: ["--inspect"],
    }),
  ],
};
```

Run Rollup in watch mode (`rollup -c -w`). Each rebuild relaunches Electron; press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop everything. A plain `rollup -c` build is unaffected — the plugin only starts Electron in watch mode.

Running processes are tracked through pid files under `node_modules/.cache/electron-run/`. A confirmed stop removes its record. If the watcher exits before it can confirm that Electron stopped, the record is retained so a later runner can recover the process. Recovery only signals a recorded process after the old watcher is gone and the child identity can be validated; an invalid or unverifiable record is never trusted as a PID to kill. Files owned by another _running_ watcher are left alone, which keeps concurrent watchers (monorepos, two terminals) from killing each other.

Recovery is deliberately fail-safe rather than immediate: a crash, forced host shutdown, or power loss can leave Electron running until the next runner starts, and a process whose identity can no longer be proven must be cleaned up manually.

The plugin is also available at the `rollup-plugin-electron-run/rollup-plugin` entry point:

```js
import electronRun from "rollup-plugin-electron-run/rollup-plugin";
```

### Standalone runner

Use the runner directly if you drive rebuilds yourself (e.g. with esbuild or a custom watcher):

```ts
import { createElectronRunner } from "rollup-plugin-electron-run";

const runner = createElectronRunner({
  entry: "main.js",
  cwd: process.cwd(),
  clearScreen: true,
});

// call whenever a build finishes
runner.scheduleRestart({ dir: "dist" }, "rebuild");

// on shutdown
await runner.close();
```

For the standalone runner, a relative output directory such as `dist` is
resolved from the configured `cwd`; `entry` is then resolved inside that output
directory. Absolute output directories are used unchanged.

## Process termination and platform support

On macOS and Linux, shutdown first requests graceful termination and escalates
to a forceful kill after the shutdown timeout. On Windows, the runner first
requests non-forceful process-tree termination with `taskkill /T`; if the tree
is still running after the timeout, it retries with `taskkill /T /F`. Unexpected
`taskkill` failures are reported, and live-child tracking is retained rather
than treating a failed stop as success.

CI runs the lifecycle suite on Linux, Windows, and macOS with Node.js 22, and
the full suite on Linux with Node.js 24. A packed, dependency-free consumer
probe verifies that both ESM entry points load at the declared Node.js 18 floor.
The repository's development tools themselves require Node.js 22 or newer.

## Interactive commands

While the runner is attached to a TTY, type a command and press <kbd>Enter</kbd>:

| Command         | Action                           |
| --------------- | -------------------------------- |
| `rs`, `restart` | Restart the Electron process     |
| `start`         | Start it if not already running  |
| `stop`          | Stop the running process         |
| `status`        | Print whether Electron is active |
| `clear`, `cls`  | Clear the terminal               |
| `help`          | List the available commands      |

Disable this with `stdinControls: false`.

## Options

| Option           | Type                     | Default             | Description                                                                                                |
| ---------------- | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `entry`          | `string`                 | `"main.js"`         | Entry file resolved against the bundle output directory.                                                   |
| `electronPath`   | `string`                 | resolves `electron` | Path to the Electron binary. Set it when `electron` isn't resolvable from this package (e.g. when linked). |
| `debounceMs`     | `number`                 | `150`               | Debounce before a rebuild triggers a restart.                                                              |
| `additionalArgs` | `string[]`               | `[]`                | Extra CLI args passed to Electron before the entry file.                                                   |
| `cwd`            | `string`                 | `process.cwd()`     | Working directory for the spawned process.                                                                 |
| `env`            | `Record<string, string>` | `{}`                | Extra environment variables merged onto `process.env`.                                                     |
| `stdinControls`  | `boolean`                | `true`              | Enable interactive stdin commands.                                                                         |
| `clearScreen`    | `boolean`                | `false`             | Clear the terminal before each launch.                                                                     |
| `logger`         | `LoggerLike`             | console logger      | Custom logger (`error`/`warn`/`info`/`debug`).                                                             |

## API

| Export                           | Description                                              |
| -------------------------------- | -------------------------------------------------------- |
| `electronRun(options?)`          | Default export — the Rollup plugin.                      |
| `createElectronRunner(options?)` | Create a standalone runner (`scheduleRestart`, `close`). |
| `createLogger(label, level?)`    | The labelled console logger used by default.             |

Types (`ElectronRunOptions`, `ElectronRunner`, `LoggerLike`, `LaunchContext`, `PidInfo`, `Command`, `BundleOutputLocation`) are exported from the package root.

## Development

```bash
pnpm install
pnpm run build       # tsc -> dist
pnpm run test        # vitest
pnpm run test:coverage # vitest with enforced coverage floors
pnpm run lint        # oxlint
pnpm run fmt:check   # oxfmt
pnpm audit --audit-level high
```

## License

MIT © [Adel Terki](LICENSE)
