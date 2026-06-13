# Changelog

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
