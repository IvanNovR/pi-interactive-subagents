# Changelog

## [1.1.0](https://github.com/IvanNovR/pi-interactive-subagents/compare/v1.0.1...v1.1.0) (2026-11-25)


### Features

* **subagents:** add resumable subtree stops and centered tree controls ([7f1414e](https://github.com/IvanNovR/pi-interactive-subagents/commit/7f1414e758618955580c75352b3dad6232529390))

- Cancel a descendant subtree with `subagent_stop`, using cooperative Escape cancellation and bounded TERM/KILL fallback with explicit cleanup failures.
- Inspect the active descendant tree in centered `/subagents` dialogs; confirm a selected subtree stop separately, or cancel with Escape.
- Resume stopped Pi agents by name with preserved history and sandbox settings.
- Reject duplicate explicit names to prevent ambiguous targeting and lost resume handles; omitted names still auto-suffix.

## [1.0.1](https://github.com/IvanNovR/pi-interactive-subagents/compare/v1.0.0...v1.0.1) (2026-11-12)


### Bug Fixes

* **release:** document approval-required PR checks ([a5283d3](https://github.com/IvanNovR/pi-interactive-subagents/commit/a5283d353498708eeb8fc689b0ed9cf7125bd512))

## 1.0.0 (2026-11-12)


### Features

* **subagents:** add inline settings with native model selection ([15261ab](https://github.com/IvanNovR/pi-interactive-subagents/commit/15261abfa42e9fe419d54075e47875bd54d55708))
* **subagents:** add persistent model settings and interactive configuration ([6e6f7a3](https://github.com/IvanNovR/pi-interactive-subagents/commit/6e6f7a3f900ff8476ef8651d7416aed7cb49c954))


### Bug Fixes

* **release:** set first scoped version to 1.0.0 ([bf7cb77](https://github.com/IvanNovR/pi-interactive-subagents/commit/bf7cb77ab28588549f5b62f42756ad44dff11ffe))

## Changelog

Release notes for `@ivannovr/pi-interactive-subagents`. Versioned entries are maintained by release-please.
