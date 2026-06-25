# Changelog

## [0.12.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.11.0...v0.12.0) (2026-06-25)


### Features

* **targets:** add generic agents skills root ([#62](https://github.com/calvinnwq/skill-suitcase/issues/62)) ([197e862](https://github.com/calvinnwq/skill-suitcase/commit/197e8622e4d96ff9305be46daa6499a7d852eaf4))


### Bug Fixes

* **apply:** preserve executable file modes ([0adcf77](https://github.com/calvinnwq/skill-suitcase/commit/0adcf775e3e2c32fa8f6ede1157c8484d3cf69c7))

## [0.11.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.10.1...v0.11.0) (2026-06-25)


### Features

* **core:** support manifest logical groups ([#60](https://github.com/calvinnwq/skill-suitcase/issues/60)) ([efa2531](https://github.com/calvinnwq/skill-suitcase/commit/efa25314320d1486e921414043990b1258c45e45))
* **pack:** add source materialization policy ([c095e23](https://github.com/calvinnwq/skill-suitcase/commit/c095e2326be933b141232992b44629d2a3f00eb3))
* **status:** report scoped upstream lineage ([48fbdca](https://github.com/calvinnwq/skill-suitcase/commit/48fbdca3ef6bce27c6168b458f27dd253298b364))


### Bug Fixes

* **packing:** preserve provider read-only boundaries ([#59](https://github.com/calvinnwq/skill-suitcase/issues/59)) ([39f62bb](https://github.com/calvinnwq/skill-suitcase/commit/39f62bb3e09bcad1ec1c749a88c4c21adb063024))

## [0.10.1](https://github.com/calvinnwq/skill-suitcase/compare/v0.10.0...v0.10.1) (2026-06-24)


### Bug Fixes

* **validate:** skip upstream skills in strict contract scoring ([5816cac](https://github.com/calvinnwq/skill-suitcase/commit/5816cac5a8e4a804aa43b15e22c92282227e9c05))

## [0.10.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.9.0...v0.10.0) (2026-06-23)


### Features

* **upstream:** add source refresh lane ([43adcab](https://github.com/calvinnwq/skill-suitcase/commit/43adcab1ca30043c6ee78d11c9cde34cd479561a))
* **upstream:** add source refresh lane ([e91842b](https://github.com/calvinnwq/skill-suitcase/commit/e91842ba3198f1acafb814e4a882b2dc0b7a48b0))


### Bug Fixes

* **apply:** harden dirty-behind provenance checks ([a81e3bf](https://github.com/calvinnwq/skill-suitcase/commit/a81e3bf7a08feb749f52f4f24dbecadae1802a34))

## [0.9.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.8.0...v0.9.0) (2026-06-21)


### Features

* block untracked source files during materialization ([de52788](https://github.com/calvinnwq/skill-suitcase/commit/de527885054d36e83e96e6b924231f44c251a877))
* **core:** block untracked source materialization ([3be7030](https://github.com/calvinnwq/skill-suitcase/commit/3be70307747cdd3cd5572ab689e6d22694624658))

## [0.8.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.7.0...v0.8.0) (2026-06-20)


### Features

* add import-target flow for catalog skill edits ([b4e2156](https://github.com/calvinnwq/skill-suitcase/commit/b4e21560f4f6337dfb8dc418f8b3fb69044cf04f))
* **import-target:** Implemented the `import-target --apply` execution slice for NGX-493: an atomic, hash-verified import of a dirty receipt-owned target skill into the catalog source path that refreshes the receipt so the target reads `current` and leaves the repo as ordinary git changes, with focused TDD tests and all verification gates green. ([77e4d45](https://github.com/calvinnwq/skill-suitcase/commit/77e4d453f7a5fc94f98cf7563302c4459e8d4ddb))
* **import-target:** Implemented the first slice of NGX-493: a read-only `import-target --dry-run` CLI command that plans importing intentional local edits from a modeled writable target back into the catalog for dirty receipt-owned skills, deterministically routing/refusing every other target state, fully tested with all verification gates green. ([fb1d1cf](https://github.com/calvinnwq/skill-suitcase/commit/fb1d1cfa1845447a30df1ab098a96abc02223f4c))

## [0.7.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.6.0...v0.7.0) (2026-06-19)


### Features

* **repair:** add dirty receipt repair flow ([d5de9f2](https://github.com/calvinnwq/skill-suitcase/commit/d5de9f2ffab4b12c0d70db7625c39f21d2d6707c))
* **repair:** Implemented NGX-487's repair --apply execution and rollback wiring for receipt-owned dirty skills (atomic backup-and-replace from catalog, rollback-metadata receipt, post-apply status verification, full failure unwinding), with focused apply/rollback/atomicity tests; all verification gates pass. ([0cf593f](https://github.com/calvinnwq/skill-suitcase/commit/0cf593fea13f2e2bd11dd33dcf94a3aad651451e))
* **repair:** Implemented the first slice of NGX-487: a read-only `repair --dry-run` command that plans dirty-repair for receipt-owned skills and deterministically routes/refuses all other target states, fully tested with all verification gates passing. ([44f1fc8](https://github.com/calvinnwq/skill-suitcase/commit/44f1fc8f45540dfff1bd44f98fe37c67d2b6c939))


### Bug Fixes

* **test:** add repair core entrypoint and legacy import to boundaries test ([e3ac66e](https://github.com/calvinnwq/skill-suitcase/commit/e3ac66e9f85b050c5a22c0508d84f522677f46d9))

## [0.6.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.5.1...v0.6.0) (2026-06-19)


### Features

* add skill suitcase operator skill ([fc14589](https://github.com/calvinnwq/skill-suitcase/commit/fc1458985d165519c7b39bd96e127a524bb0f18e))
* add Skill Suitcase operator skill ([2645cb5](https://github.com/calvinnwq/skill-suitcase/commit/2645cb5d96eb4f690c77bae0ec49b6e7adbe2c56))


### Bug Fixes

* address operator skill review comments ([cc26852](https://github.com/calvinnwq/skill-suitcase/commit/cc268526528489e37afd3ae4b6f7fe47ee50051b))

## [0.5.1](https://github.com/calvinnwq/skill-suitcase/compare/v0.5.0...v0.5.1) (2026-06-17)


### Bug Fixes

* **package:** expose skill-suitcase cli bin ([9ab7f51](https://github.com/calvinnwq/skill-suitcase/commit/9ab7f512797ca8f12745cee41775833d8cad3ea4))
* **package:** expose skill-suitcase cli bin ([afe8d10](https://github.com/calvinnwq/skill-suitcase/commit/afe8d1090a9d29384caf1d4532d408d07bfc6ba4))
* **package:** expose skill-suitcase CLI bin ([9ab7f51](https://github.com/calvinnwq/skill-suitcase/commit/9ab7f512797ca8f12745cee41775833d8cad3ea4))

## [0.5.0](https://github.com/calvinnwq/skill-suitcase/compare/v0.4.3...v0.5.0) (2026-06-17)


### Features

* add reconcile flow for unknown target skills ([07795d6](https://github.com/calvinnwq/skill-suitcase/commit/07795d69805e69632d79ee14ae06aba6a965f987))
* **cli:** add reconcile flow for unknown target skills ([13eb126](https://github.com/calvinnwq/skill-suitcase/commit/13eb1263ec0f0caf42a9cc288c2f2b167a024364))
* **cli:** add reconcile flow for unknown target skills ([13eb126](https://github.com/calvinnwq/skill-suitcase/commit/13eb1263ec0f0caf42a9cc288c2f2b167a024364))

## [0.4.3](https://github.com/calvinnwq/skill-suitcase/compare/v0.4.2...v0.4.3) (2026-06-16)


### Bug Fixes

* **package:** preserve npm cli bin ([ce13dd5](https://github.com/calvinnwq/skill-suitcase/commit/ce13dd501928ac605f02f1ef8fb170bebe5aeb94))
* **package:** preserve npm cli bin ([ce13dd5](https://github.com/calvinnwq/skill-suitcase/commit/ce13dd501928ac605f02f1ef8fb170bebe5aeb94))
* **package:** preserve npm cli bin ([82a83d2](https://github.com/calvinnwq/skill-suitcase/commit/82a83d22c1efd362a433614930ffc1f55b96fbfb))

## [0.4.2](https://github.com/calvinnwq/skill-suitcase/compare/v0.4.1...v0.4.2) (2026-06-16)


### Bug Fixes

* **package:** prepare npm publish payload ([28862cd](https://github.com/calvinnwq/skill-suitcase/commit/28862cdce0b191d028c023fa9d125f8ce7934e6c))
* **package:** prepare npm publish payload ([28862cd](https://github.com/calvinnwq/skill-suitcase/commit/28862cdce0b191d028c023fa9d125f8ce7934e6c))
* **package:** prepare npm publish payload ([5d28c7e](https://github.com/calvinnwq/skill-suitcase/commit/5d28c7e54f3b3f66facf623f5733873386b48d2a))

## [0.4.1](https://github.com/calvinnwq/skill-suitcase/compare/v0.4.0...v0.4.1) (2026-06-16)


### Bug Fixes

* use plain release tags ([c44914d](https://github.com/calvinnwq/skill-suitcase/commit/c44914d99430d3e2072553488691cf7e996c6ca0))

## [0.4.0](https://github.com/calvinnwq/skill-suitcase/compare/skill-suitcase-v0.3.0...skill-suitcase-v0.4.0) (2026-06-16)


### Features

* **promote:** add target skill promotion flow ([f12fedb](https://github.com/calvinnwq/skill-suitcase/commit/f12fedbeff1009d29ffab276578d2b7dd51a1127))
* **promote:** Implemented the live `promote --apply` execution for NGX-457 (copy → hash-verify → backup+symlink → receipt, fully transactional) with TDD, completing all four acceptance criteria; all verification gates pass. ([d40e8f8](https://github.com/calvinnwq/skill-suitcase/commit/d40e8f893969af72ee4762f1dd178435c5ce2cbb))
* **promote:** Implemented the read-only/dry-run `promote` plan for NGX-457 with machine-readable conflict detection, wired as a new CLI command with TDD; all verification gates pass. ([f60fe40](https://github.com/calvinnwq/skill-suitcase/commit/f60fe40120cfcac8c418f00acf9a58cd61fd6a5d))

## [0.3.0](https://github.com/calvinnwq/skill-suitcase/compare/skill-suitcase-v0.2.0...skill-suitcase-v0.3.0) (2026-06-16)


### Features

* add import onboarding command for NGX-385 ([1fc0e31](https://github.com/calvinnwq/skill-suitcase/commit/1fc0e31688fe6b3b3fd7a59ef0613f90049b0bbd))
* add promote flow for target-created skills ([4ab30e6](https://github.com/calvinnwq/skill-suitcase/commit/4ab30e6d9979b40b0abcf513ff8ffc38914e5532))
* add skills.sh target registry coverage ([#24](https://github.com/calvinnwq/skill-suitcase/issues/24)) ([67b5f02](https://github.com/calvinnwq/skill-suitcase/commit/67b5f02461d66bb16b853a8084c69c0a2e699fb9))
* add targeted track skill filters ([5319c6c](https://github.com/calvinnwq/skill-suitcase/commit/5319c6caa4ed6bb17987b4f5114f7d18c0e9e913))
* **apply:** implement apply --mode symlink with source-root escape guard ([e43994e](https://github.com/calvinnwq/skill-suitcase/commit/e43994e3dc3081194ad8e1c94612952cb1ca5e74))
* **cli:** add import onboarding command ([4398a09](https://github.com/calvinnwq/skill-suitcase/commit/4398a097bc74abfbd5d0911dd8f48ef5ea90b703))
* **cli:** add targeted track skill filters ([7edd362](https://github.com/calvinnwq/skill-suitcase/commit/7edd362f1be9371c6bfc8b85ab2fd87422bc93f9))
* **cli:** support local target path overrides ([9ea56ad](https://github.com/calvinnwq/skill-suitcase/commit/9ea56ad4dfb73b834907e1bee0c21fb5c107776f))
* **core:** add native symlink install mode ([d5dffde](https://github.com/calvinnwq/skill-suitcase/commit/d5dffde5d00837e43117155e4362b39e63571d14))
* **rollback:** remove apply-created symlinks in rollback while refusing drifted real directories ([4335cf9](https://github.com/calvinnwq/skill-suitcase/commit/4335cf91f1002df1f20f26c85bae73202aba4f32))
* **rollback:** treat adopted and refreshed symlink installs as safe no-ops in rollback ([d1f7acc](https://github.com/calvinnwq/skill-suitcase/commit/d1f7acc228d782a4a64a8aa403939d0f83bfc427))
* **status:** add symlink-install-state classifier for correct/broken/wrong-target/real-directory receipts ([b2f4e36](https://github.com/calvinnwq/skill-suitcase/commit/b2f4e36544190244c750e10161393a2ed40d166d))
* support local target path overrides ([5ce2488](https://github.com/calvinnwq/skill-suitcase/commit/5ce2488e90489e6576d2b801d9fe468f2e2d8e19))
* **track:** adopt existing correct symlinks as symlink-mode receipts without rewriting files ([e4c752b](https://github.com/calvinnwq/skill-suitcase/commit/e4c752b489284b5abab54d7b43374c37f7812eaa))
* **validate:** add strict Skillify-10 contract validation mode ([46ce993](https://github.com/calvinnwq/skill-suitcase/commit/46ce99399332950fc9ae1b14db6461d6fdb57904))
* **validate:** add strict Skillify-10 contract validation mode for NGX-386 ([59ab28f](https://github.com/calvinnwq/skill-suitcase/commit/59ab28f4ca3c4bb68170fdd1698ae2d40d50d5c4))


### Bug Fixes

* **cli:** reject unsupported command flags ([41440c6](https://github.com/calvinnwq/skill-suitcase/commit/41440c681e24cf05c6d728c84b4cfc34d73a39c7))
* **cli:** reject unsupported command flags ([c09c764](https://github.com/calvinnwq/skill-suitcase/commit/c09c7646ee281ce1d6684513eb198c9546a5df9b))
* **cli:** use canonical target names ([917d10d](https://github.com/calvinnwq/skill-suitcase/commit/917d10df6897cb001cad57959c13f399305dda91))
* **cli:** use canonical target names ([4f12fcb](https://github.com/calvinnwq/skill-suitcase/commit/4f12fcbb37ff055f76218d8635eea676f93f2c7a))
* **import:** ignore support skill directories ([#20](https://github.com/calvinnwq/skill-suitcase/issues/20)) ([6ad8093](https://github.com/calvinnwq/skill-suitcase/commit/6ad8093849329757affead515ec747e6887bf9dd))

## [0.2.0](https://github.com/calvinnwq/skill-suitcase/compare/skill-suitcase-v0.1.0...skill-suitcase-v0.2.0) (2026-06-13)


### Features

* add deterministic plan lock support ([1cd8931](https://github.com/calvinnwq/skill-suitcase/commit/1cd8931a424464e379edfc32a8852d6148565d37))
* add explicit pack output ([28c4d17](https://github.com/calvinnwq/skill-suitcase/commit/28c4d170cc28e9bd03281bc2117c902bf81b7f3c))
* add explicit platform adapters for NGX-382 NGX-383 ([c365df2](https://github.com/calvinnwq/skill-suitcase/commit/c365df2e84b59e610cd79b78489b33a1e70d3ae1))
* add read-only install diff command ([31e6102](https://github.com/calvinnwq/skill-suitcase/commit/31e6102ace10077d0397fc72ca4d3faa345dc1e3))
* add skill suitcase receipt support ([a0e2d3f](https://github.com/calvinnwq/skill-suitcase/commit/a0e2d3f5616be6d0ea38de99312759ff43caa222))
* add source variants for NGX-384 ([3ffb4b6](https://github.com/calvinnwq/skill-suitcase/commit/3ffb4b6e1ca37409abc2f18ab88669d27774ccfb))
* add target discovery command ([9a9b2ca](https://github.com/calvinnwq/skill-suitcase/commit/9a9b2cabc5962849867b7089038c477886ea4a90))
* **apply:** add transactional apply command with dirty-target refusal ([c38c8bb](https://github.com/calvinnwq/skill-suitcase/commit/c38c8bbe7a9ed35edaa5d4d1f1052652733750bb))
* **apply:** implement transactional apply with dirty-target refusal ([d6b0998](https://github.com/calvinnwq/skill-suitcase/commit/d6b0998da8109137c7ba3bb4c25252c3504bf12c))
* **cli:** add receipt rollback and track commands ([b95b43e](https://github.com/calvinnwq/skill-suitcase/commit/b95b43e99bd1a423a3e57bb5712ab5a9d733c1a3))
* **core:** add explicit platform adapters and source variant selection ([82984f4](https://github.com/calvinnwq/skill-suitcase/commit/82984f48a5598d1c6b619b9e4d843eb837a2f585))
* **pack:** store immutable artifacts under .skill-suitcase/artifacts/&lt;id&gt;/ with provenance ([0ee16ca](https://github.com/calvinnwq/skill-suitcase/commit/0ee16ca5172422c4f8ed5e1ca967224a2f723a5c))
* **pack:** store immutable pack artifacts ([87706d5](https://github.com/calvinnwq/skill-suitcase/commit/87706d57badda5ebcf1032b84cb8e4e1fad1f384))
* **plan-lock:** add deterministic lock generation and stale-validity assessment ([ca46062](https://github.com/calvinnwq/skill-suitcase/commit/ca460624ba901a9e0b654a8bee8dff799534784e))
* **receipt:** add receipt schema, builder, upsert, and write helpers ([af71dc4](https://github.com/calvinnwq/skill-suitcase/commit/af71dc498d972dae30910193da631f4f574936f9))
* **status:** add manifest-wide read-only status command ([b3a596b](https://github.com/calvinnwq/skill-suitcase/commit/b3a596b09a31cfc7b3a69a571881b5eca8d3a40a))
* **status:** add read-only skill install status ([a16d602](https://github.com/calvinnwq/skill-suitcase/commit/a16d602ec41355438f91b2da457e64020096849d))
* **status:** migrate receipt reading to .skill-suitcase-receipt.json with legacy .skills-sync.json compat ([4c5a99d](https://github.com/calvinnwq/skill-suitcase/commit/4c5a99d37619387ff93170927751daf6ae881774))


### Bug Fixes

* report blocked apply variants for NGX-384 ([3785494](https://github.com/calvinnwq/skill-suitcase/commit/378549425211257741e40799b08fdb20f4438bd8))

## Changelog

Releases are managed by Release Please.
