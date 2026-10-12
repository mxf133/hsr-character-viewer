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
| Recommendation data, scoring, or conclusion algorithms | `src/core/advice.js`, `src/server/conclusion.js` | `herta-test.mjs`, `team-plan-test.mjs`; add `e2e-test.mjs` for API payload changes |
| Web UI (⚠️ being rebuilt — `public/` is only a "开发中" placeholder; the old page was deleted in v4.6.85) | `public/index.html`, `public/styles/placeholder.css`, and whatever new files the rebuild adds | `e2e-test.mjs` asserts the placeholder (no `<script>`, old UI assets must 404). The old CDP geometry suite was deleted with the old UI; re-add one when the new UI lands |
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

Run `node tools/run-tests.mjs` for the full suite before handing off code changes, as required by `HANDOFF.md` §9.1. ⚠️ That script captures child output through pipes, so under a file sandbox it fails with `spawn EPERM`; run it with full access, or run the suites directly (`node tools/herta-test.mjs`) as an equivalent. Documentation-only changes do not need the test suite.

## Repository Invariants

- The app is dependency-free Node.js ESM; no build or install step is needed.
- Keep reads of cached Star Rail data offline. Network refreshes must remain explicit and follow the existing gate in `src/server/cache-policy.js`.
- Keep user-facing names sourced from `theherta/i18n-zh.json`, except manually maintained boss names.
- Preserve existing data contracts and single sources of truth; check `HANDOFF.md` §4.4 before changing scoring, weights, cache behavior, or shared UI components.
- Avoid unrelated historical-document and version-changelog edits. For functional changes, follow the synchronization rules in `HANDOFF.md` §4.4 and §9.1.
