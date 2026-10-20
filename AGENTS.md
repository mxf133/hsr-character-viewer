# Agent Guide

Keep each task focused. This repository has extensive historical documentation; use it as a lookup source instead of reading it end to end.

## Start Here

- Check `git status --short --branch` before editing. Work on the task's branch/worktree.
- Find the implementation and its direct callers with `rg`; read the matching test before changing behavior.
- Read only the relevant parts of `HANDOFF.md`: §4.4 for invariants, §5 for verification, and the matching feature entry for recent decisions. `README.md` documents product behavior; do not read it all for a code change.
- Keep production changes local to the owning module. Do not bump the app version for documentation-only or agent-workflow changes.

## Version Control Conventions

These are hard rules for every session (human and agent alike). This directory hosts concurrent sessions working on the same repo, so discipline matters more than any branch model.

- **Model**: trunk-based development — `main` is always shippable; every task gets a short-lived `feat/*` or `fix/*` branch that is merged back and deleted. Do **not** introduce `develop`/`release` branches (Git Flow) — it is overkill here and conflicts with the game-aligned versioning.
- **Never work directly on `main`**. Each concurrent session (WorkBuddy, codex, human) uses its own branch or worktree. Do not resolve another session's conflicts, do not commit on its behalf, and do not check out a new branch on top of someone else's half-finished merge. Check `git status --short --branch` first; if you see `UU`/`AA` or a `MERGE_HEAD`, stop and look before acting.
- **Branch naming**: `feat/<what>`, `fix/<what>`, or `<tool>/<what>` for agent sessions. Keep them short-lived (days, not weeks).
- **Worktrees live in `.worktrees/`**, named `branch name with `/` → `-``. After a branch is merged, remove its worktree with `git worktree remove` and prune with `git worktree prune` — do not leave prunable worktrees around.
- **Commit message format**: `type(scope): summary` with `type` ∈ {feat, fix, docs, chore, test, style, refactor}. A `!` after `type` marks a breaking change. Message files must be **UTF-8 with no BOM** (verify the first three bytes are not `ef bb bf` before `git commit -F`).
- **`git add <specific files>`, never `git add -A`** — `-A` drags in `.workbuddy/`, `data/`, `.worktrees/`, and other sessions' files.
- **Version ↔ tag binding**: every time `PROGRAM_VERSION` in `src/version.js` is bumped (and `package.json` `version` is kept in sync) and the change lands on `main`, tag the commit `v<version>` immediately (e.g. `git tag v4.6.121`). A version number without a matching tag is a liability — tags are the only reliable way to map "which code shipped as vX". Never tag a commit whose `src/version.js` still shows the previous version.
- **Author identity**: keep one `user.name`/`user.email` for the repo. Distinguish agent sessions via branch prefix or `Co-authored-by`, not by changing author identity.
- After merging a branch, delete it (`git branch -d`, or `-D` only after confirming its commits are reachable from `main`). Do not accumulate `backup/main-before-*` branches — use tags for snapshots instead.

## Code And Test Map

| Change area | Main files | Focused checks |
| --- | --- | --- |
| Recommendation data, scoring, or conclusion algorithms | `public/scripts/advice.js`, `src/server/conclusion.js` | `herta-test.mjs`, `team-plan-test.mjs`; add `e2e-test.mjs` for API payload changes |
| Version weights reaching both weighted chains (`archiveFrontier` and `resolveScope`/`conclusionEnvs`) | `src/server/archive.js`, `src/server/conclusion.js` | `version-weight-plan-test.mjs` (any change to `resolveScope`, `conclusionEnvs`, `avRowFor`, or `buildAvTeams`) |
| Recommendation rendering or styles | `public/scripts/advice-view.js`, `public/scripts/battle-record.js`, `public/index.html`, `public/styles/` | `herta-test.mjs`, `e2e-test.mjs`; `check-advice-layout.mjs` for browser geometry |
| Board / team-plan search and pagination | `public/scripts/advice-paging.js`, `public/scripts/advice-view.js`, `src/server/plan-index.js` (server-side full-pool index since v4.6.134) | `paging-test.mjs` (offline: matching, page slicing, pager window), `plan-page-test.mjs` (offline: tokens, AND search, alt hits, paging, LRU); `_probe-plan-page-perf.mjs` / `_probe-plan-page-ui.mjs` for the 100k and browser checks |
| Server routes, records, cache, or persistence | `src/server/` | `e2e-test.mjs` plus the matching focused test (`cache-policy-test.mjs`, `request-throttle-test.mjs`, or `team-plan-test.mjs`) |
| Login, signing, or Star Rail payload parsing | `src/mihoyo/` | `qr-poll-regression.mjs`, `api-wiring-test.mjs`, `hsr-parse-test.mjs`, or `devicefp-test.mjs` as applicable |
| QR encoding/decoding | `src/qr/` | `qr-tables-check.mjs`, `qr-selftest.mjs` |
| Windows startup scripts | `start.bat`, `bin/` | `launcher-test.mjs`, `launcher-open-test.mjs` |
| Translation data | `theherta/i18n-zh.json`, `tools/data/hsr-bosses-zh.mjs` | `herta-i18n-check.mjs`（生成物）+ `i18n-audit.mjs`（源表 / 官方简中 / 全数据源） |

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
