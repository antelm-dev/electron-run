# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rollup plugin that restarts Electron on every bundle write, debounced.
- Standalone runner (`createElectronRunner`) for custom watchers.
- Interactive stdin commands: `rs`, `start`, `stop`, `status`, `clear`, `help`.
- Pid file tracking under `node_modules/.cache/electron-run/`, so a crashed
  watcher cannot leave Electron processes behind.
- `electronPath` option, for setups where the `electron` package is not
  resolvable from the consuming project.

[unreleased]: https://github.com/antelm-dev/electron-run/commits/master
