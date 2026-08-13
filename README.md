# rollup-plugin-electron-run

[![CI](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml/badge.svg)](https://github.com/antelm-dev/electron-run/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rollup-plugin-electron-run)](https://www.npmjs.com/package/rollup-plugin-electron-run)
[![node](https://img.shields.io/node/v/rollup-plugin-electron-run)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/rollup-plugin-electron-run)](LICENSE)

Live-reload Electron whenever Rollup rebuilds.

- Restarts Electron after each bundle write
- Stops the previous process before relaunching
- Cleans up the process tree when the watcher exits
- Provides interactive restart controls in the terminal
- Has zero runtime dependencies

## Install

```bash
npm install --save-dev rollup-plugin-electron-run
```

Requires Node.js 18 or newer and Electron. Rollup 4 or newer is required when
using the Rollup plugin. The package is ESM-only.

## Usage

Add the plugin to your Rollup configuration:

```js
// rollup.config.mjs
import electronRun from "rollup-plugin-electron-run";

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

### Interactive commands

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
import { createElectronRunner } from "rollup-plugin-electron-run";

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
