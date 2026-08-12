# Changelog

## [0.1.1](https://github.com/antelm-dev/electron-run/compare/v0.1.0...v0.1.1) (2026-08-12)


### Bug Fixes

* coordinate shared stdin ownership ([c74e939](https://github.com/antelm-dev/electron-run/commit/c74e939b1040d2ea369764ec6a4641ee1c346da9))
* harden Electron process lifecycle ([a647711](https://github.com/antelm-dev/electron-run/commit/a647711ea26d5ab62035d68cc912ebf25655d2c2))
* harden process lifecycle handling ([1dd2bbb](https://github.com/antelm-dev/electron-run/commit/1dd2bbbda328cc28c9730edf82b0d8b10c1b941e))
* restore runner-owned stdin state ([2290146](https://github.com/antelm-dev/electron-run/commit/2290146e000ba67caa2fd4e625ed2b5e787c7ba3))

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
