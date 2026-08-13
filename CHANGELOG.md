# Changelog

## [0.3.2](https://github.com/antelm-dev/electron-run/compare/v0.3.1...v0.3.2) (2026-08-13)


### Bug Fixes

* propagate Vite environment settings ([4b39422](https://github.com/antelm-dev/electron-run/commit/4b3942227793780383ea8d0d8133e441f17f2a64))
* propagate Vite environment settings ([0920212](https://github.com/antelm-dev/electron-run/commit/0920212290bdc897dc633459be232db20f365ce0))

## [0.3.1](https://github.com/antelm-dev/electron-run/compare/v0.3.0...v0.3.1) (2026-08-13)


### Bug Fixes

* harden releases and honor Vite main watch paths ([1a97bd0](https://github.com/antelm-dev/electron-run/commit/1a97bd036e2436a269ac0fd20b4d04b8f7d8fe87))
* honor extra Vite main watch paths ([b8b379a](https://github.com/antelm-dev/electron-run/commit/b8b379a6764dcfe16246ae30c67071e6202f08d5))
* make npm publishing retryable ([45981ac](https://github.com/antelm-dev/electron-run/commit/45981ac9adc4b15a77a184b129cbccc134035f05))

## [0.3.0](https://github.com/antelm-dev/electron-run/compare/v0.2.0...v0.3.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* rename package to vite-plugin-electron-run

### Features

* rename package to vite-plugin-electron-run ([19a5226](https://github.com/antelm-dev/electron-run/commit/19a522600aca9ec3ea219e6db82d5da6184a7bee))

## [0.2.0](https://github.com/antelm-dev/electron-run/compare/v0.1.1...v0.2.0) (2026-08-13)


### Features

* add Vite plugin ([a2e0ff5](https://github.com/antelm-dev/electron-run/commit/a2e0ff5336710a2a8e38a5af721f09e020c03995))
* add Vite plugin ([05b0948](https://github.com/antelm-dev/electron-run/commit/05b0948dad4ffae13830a1c5bb0ba98cc938f901))

## [0.1.1](https://github.com/antelm-dev/electron-run/compare/v0.1.0...v0.1.1) (2026-08-12)


### Bug Fixes

* allow slow process identity probes to finish ([1680cfe](https://github.com/antelm-dev/electron-run/commit/1680cfe6731e49b58ed452394aa27693dcba83c3))
* allow slow process identity probes to finish ([60081b7](https://github.com/antelm-dev/electron-run/commit/60081b72a0ce0bc6125700975ec775ec64305bba))
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
