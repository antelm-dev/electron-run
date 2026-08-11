# Changelog

## 0.1.0

Initial release.

### Features

- Rollup plugin that restarts Electron on every bundle write, debounced.
- Standalone runner (`createElectronRunner`) for custom watchers.
- Interactive stdin commands: `rs`, `start`, `stop`, `status`, `clear`, `help`.
- Pid file tracking under `node_modules/.cache/electron-run/`, so a crashed
  watcher cannot leave Electron processes behind.
- `electronPath` option, for setups where the `electron` package is not
  resolvable from the consuming project.
