# Agent Guide

Keep each task focused. This repository has extensive historical documentation; use it as a lookup source instead of reading it end to end.

## Start Here

- Check `git status --short --branch` before editing. Work on the task's branch/worktree.
- Find the implementation and its direct callers with `rg`; read the matching test before changing behavior.
- Read only the relevant parts of `HANDOFF.md`: §4.4 for invariants, §5 for verification, and the matching feature entry for recent decisions. `README.md` documents product behavior; do not read it all for a code change.
- Keep production changes local to the owning module. Do not bump the app version for documentation-only or agent-workflow changes.

## Code And Test Map

| Change area | Main files | Focused checks |
| --- | --- | --- |
| Recommendation data, scoring, or conclusion algorithms | `public/scripts/advice.js`, `src/server/conclusion.js` | `herta-test.mjs`, `team-plan-test.mjs`; add `e2e-test.mjs` for API payload changes |
| Version weights reaching both weighted chains (`archiveFrontier` and `resolveScope`/`conclusionEnvs`) | `src/server/archive.js`, `src/server/conclusion.js` | `version-weight-plan-test.mjs` (any change to `resolveScope`, `conclusionEnvs`, `avRowFor`, or `buildAvTeams`) |
| Recommendation rendering or styles | `public/scripts/advice-view.js`, `public/scripts/battle-record.js`, `public/index.html`, `public/styles/` | `herta-test.mjs`, `e2e-test.mjs`; `check-advice-layout.mjs` for browser geometry |
| Board / team-plan search and pagination | `public/scripts/advice-paging.js`, `public/scripts/advice-view.js` | `paging-test.mjs` (offline: matching, page slicing, pager window) |
| Server routes, records, cache, or persistence | `src/server/` | `e2e-test.mjs` plus the matching focused test (`cache-policy-test.mjs`, `request-throttle-test.mjs`, or `team-plan-test.mjs`) |
| Login, signing, or Star Rail payload parsing | `src/mihoyo/` | `qr-poll-regression.mjs`, `api-wiring-test.mjs`, `hsr-parse-test.mjs`, or `devicefp-test.mjs` as applicable |
| QR encoding/decoding | `src/qr/` | `qr-tables-check.mjs`, `qr-selftest.mjs` |
| Windows startup scripts | `start.bat`, `bin/` | `launcher-test.mjs`, `launcher-open-test.mjs` |
| Translation data | `theherta/i18n-zh.json`, `tools/data/hsr-bosses-zh.mjs` | `herta-i18n-check.mjs` |

Run one or more focused suites while iterating:

```bash
node tools/run-tests.mjs --list
node tools/run-tests.mjs --suite herta-test.mjs
node tools/run-tests.mjs --suite herta-test.mjs --suite e2e-test.mjs
```

Run `node tools/run-tests.mjs` for the full suite before handing off code changes, as required by `HANDOFF.md` §9.1. The CDP layout suite is included only when port 9222 is available; it uses the existing browser and can take several minutes. Run it deliberately when a UI geometry change needs that coverage. Documentation-only changes do not need the test suite.

**Before running the CDP layout suite, read [`docs/CDP布局套件.md`](docs/CDP布局套件.md)** — it is the step-by-step setup and troubleshooting guide (service + debug browser + the virtual-account store, why a wrong `CHECK_ADVICE_URL` silently tests `main` instead of your code, and what each `✗` / `–` means). Read it rather than rediscovering it: getting the environment wrong there produces a wall of `null` failures that look like real layout regressions.

## Repository Invariants

- The app is dependency-free Node.js ESM; no build or install step is needed.
- Keep reads of cached Star Rail data offline. Network refreshes must remain explicit and follow the existing gate in `src/server/cache-policy.js`.
- Keep user-facing names sourced from `theherta/i18n-zh.json`, except manually maintained boss names.
- Preserve existing data contracts and single sources of truth; check `HANDOFF.md` §4.4 before changing scoring, weights, cache behavior, or shared UI components.
- Avoid unrelated historical-document and version-changelog edits. For functional changes, follow the synchronization rules in `HANDOFF.md` §4.4 and §9.1.
