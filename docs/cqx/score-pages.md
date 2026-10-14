The requested Score pages were captured from the production OpenNext app on local workerd with the real `gild-cqx-heavy` service binding and disposable local Git/D1. All viewport and theme checks passed; the desktop screenshots were visually reviewed.

These are cqx **v0.1.25** results. GitHub has not published v0.1.26 yet. The C/C++ parse-coverage bug in [cqx #82](https://github.com/cqxai/cqx/issues/82) remains: Lua's clean 100 and tinyxml2's C++ 100 are not evidence of complete coverage. The version/integrity/BUILD update and coverage labels are deferred until the release exists.

| Repository | Light desktop | Dark desktop | Light phone | Dark phone |
| --- | --- | --- | --- | --- |
| avatest/cJSON | [light 1400](./cJSON-light-1400.png) | [dark 1400](./cJSON-dark-1400.png) | [light 400](./cJSON-light-400.png) | [dark 400](./cJSON-dark-400.png) |
| avatest/lua | [light 1400](./lua-light-1400.png) | [dark 1400](./lua-dark-1400.png) | [light 400](./lua-light-400.png) | [dark 400](./lua-dark-400.png) |
| avatest/tinyxml2 | [light 1400](./tinyxml2-light-1400.png) | [dark 1400](./tinyxml2-dark-1400.png) | [light 400](./tinyxml2-light-400.png) | [dark 400](./tinyxml2-dark-400.png) |
| avatest/Polly | [light 1400](./Polly-light-1400.png) | [dark 1400](./Polly-dark-1400.png) | [light 400](./Polly-light-400.png) | [dark 400](./Polly-dark-400.png) |

[Source commits, first-view and cached timings](./evidence.json). First-view timings include retries until a real Score section and its immutable cache entry exist; an HTTP 200 error shell does not count as success.

-codex
