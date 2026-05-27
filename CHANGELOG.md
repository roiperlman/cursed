# [0.5.0](https://github.com/roiperlman/cursed/compare/v0.4.0...v0.5.0) (2026-05-27)


### Bug Fixes

* **marketplace:** use './' instead of '.' for plugin source (ROI-48) ([#20](https://github.com/roiperlman/cursed/issues/20)) ([3404590](https://github.com/roiperlman/cursed/commit/34045909153459ce4347f6a87d0265cc159ca281))


### Features

* **render:** surface adapter tag in panel render output (ROI-3) ([#21](https://github.com/roiperlman/cursed/issues/21)) ([6203216](https://github.com/roiperlman/cursed/commit/6203216eb890e569ac2aa1392d78e4813506446f))

# [0.4.0](https://github.com/roiperlman/cursed/compare/v0.3.1...v0.4.0) (2026-05-26)


### Features

* **review:** add --include-untracked flag ([#14](https://github.com/roiperlman/cursed/issues/14)) ([880c433](https://github.com/roiperlman/cursed/commit/880c4336abc9d1ab39d6452b73adf0205c7123f8))

## [0.3.1](https://github.com/roiperlman/cursed/compare/v0.3.0...v0.3.1) (2026-05-24)


### Bug Fixes

* **jobs:** anchor synthesized-stale GC on original live-deadline (ROI-4) ([#15](https://github.com/roiperlman/cursed/issues/15)) ([b61de1c](https://github.com/roiperlman/cursed/commit/b61de1c9f8e9f4406bc6a5b75c04d7f8ea0888d7)), closes [#13](https://github.com/roiperlman/cursed/issues/13)

# [0.3.0](https://github.com/roiperlman/cursed/compare/v0.2.3...v0.3.0) (2026-05-24)


### Features

* **types:** add adapter field to RunRecord ([#7](https://github.com/roiperlman/cursed/issues/7)) ([ca098b5](https://github.com/roiperlman/cursed/commit/ca098b58f37beb3244e7650d07cc900e65283ab0))

## [0.2.3](https://github.com/roiperlman/cursed/compare/v0.2.2...v0.2.3) (2026-05-23)


### Bug Fixes

* **adapters:** use inlined catalogs in adapterForModel so model routing survives bundling ([#6](https://github.com/roiperlman/cursed/issues/6)) ([7af9350](https://github.com/roiperlman/cursed/commit/7af9350b039c97ca429deb835d326705c1cc9010)), closes [#4](https://github.com/roiperlman/cursed/issues/4) [#4](https://github.com/roiperlman/cursed/issues/4) [gpt-5.2-xhi#fast](https://github.com/gpt-5.2-xhi/issues/fast) [#4](https://github.com/roiperlman/cursed/issues/4) [#4](https://github.com/roiperlman/cursed/issues/4)

## [0.2.2](https://github.com/roiperlman/cursed/compare/v0.2.1...v0.2.2) (2026-05-23)


### Bug Fixes

* **adapters:** inline model catalogs so tier resolution survives bundling ([#4](https://github.com/roiperlman/cursed/issues/4)) ([3c05ba5](https://github.com/roiperlman/cursed/commit/3c05ba57106ff254c2c522ba5746a265fab164ef))

## [0.2.1](https://github.com/roiperlman/cursed/compare/v0.2.0...v0.2.1) (2026-05-21)


### Bug Fixes

* **readme:** list the Antigravity (agy) adapter in the Adapters section ([a8cd7f1](https://github.com/roiperlman/cursed/commit/a8cd7f147dd196006f95a791a8a6423c928743f2))

# [0.2.0](https://github.com/roiperlman/cursed/compare/v0.1.3...v0.2.0) (2026-05-21)


### Features

* add antigravity CLI adapter ([#1](https://github.com/roiperlman/cursed/issues/1)) ([665d169](https://github.com/roiperlman/cursed/commit/665d1699488a7ce8a7b7396a60e9dfb081132745))

## [0.1.3](https://github.com/roiperlman/cursed/compare/v0.1.2...v0.1.3) (2026-05-21)


### Bug Fixes

* **deps:** bump claude-code-testbed to ^0.4.0 ([84cb588](https://github.com/roiperlman/cursed/commit/84cb58821c03f9c2b228675007460ac1e497968d))

## [0.1.2](https://github.com/roiperlman/cursed/compare/v0.1.1...v0.1.2) (2026-05-21)


### Bug Fixes

* **release:** rename npm scope to [@roip](https://github.com/roip) (actual npm username) ([4fe2257](https://github.com/roiperlman/cursed/commit/4fe2257e4df6145f591ed1a283f7b710af66bd76))

## [0.1.1](https://github.com/roiperlman/cursed/compare/v0.1.0...v0.1.1) (2026-05-21)


### Bug Fixes

* **release:** publish @roiperlman/cursed as public scoped package ([d85ebc5](https://github.com/roiperlman/cursed/commit/d85ebc592b28ad1097135bcfb53172c1370dd146))

# [0.1.0](https://github.com/roiperlman/cursed/compare/v0.0.0...v0.1.0) (2026-05-21)


### Features

* add npm publishing CI/CD and open source configuration ([0543e45](https://github.com/roiperlman/cursed/commit/0543e456c207c14b5bd80dfa0faaac709165673f))
* bundle MCP server so /plugin install works with no npm install ([3448a15](https://github.com/roiperlman/cursed/commit/3448a15e06dfe29a282bb196dd7fcf48c0b69734))
