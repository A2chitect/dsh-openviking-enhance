# Verification

What this release's install / host contract / privacy claims rest on, and how to
reproduce them. This file is **append-only per release**: every release PR adds a
dated row before tagging.

## How to reproduce

```bash
pnpm test                        # typecheck + build + packaging contract +
                                 # independence gate + unit/contract tests +
                                 # client smoke + host smoke (live path redacted)
pnpm run verify:install          # clean-profile install -> boot -> bundle/route
                                 # -> reinstall -> uninstall, in a scratch DSH_HOME
```

`pnpm run verify:install` needs a `dsh` executable and pnpm on your PATH (the
script discovers both; pass `--dsh <path>` explicitly in CI). It creates its own
scratch `DSH_HOME` under the system temp directory and removes it unless
`--keep` is given. It never writes to OpenViking; the reachability probe is a
read-only `/health` call.

The release checklist (`RELEASING.md`) requires a dated row here plus the CI run
link **before tagging**.

## Verified matrix

| Version | Date | DSH (profile) | Node | OS | OpenViking | Install path | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.4.0 (PR #2) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 read-only | tarball into a scratch DSH home + mock-fixture browser capture | **pending release** — browser render evidence only; 0.4.0 is not tagged/published yet, so no clean-profile install record exists | PR #2 screenshots + review evidence; row becomes `pass` when the release ships |
| 0.5.0 (PR #3) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 contract via stand-in fixture (no real writes) | tarball into a scratch DSH home + stateful mock-fixture browser capture | **pending release** — browser render evidence only; 0.5.0 is not tagged/published yet | PR #3 BEFORE/AFTER capture set; write paths covered by fake-transport unit tests |
| 0.6.0 (PR #4) | 2026-11-10 | 0.2.1-rc.3 local + 0.2.2-rc.1 pinned in CI | 22.22.3 | macOS (Darwin 24); Linux CI | 0.5.3 reachable, read-only; mock fixture for the UI deltas | `pnpm pack` tarball → scratch `DSH_HOME` web profile | pass | `node scripts/verify-install.mjs …` → 27/27 steps, `tarballVersion === installedVersion` (0.3.0); CI `install-verify` job on the PR; browser BEFORE/AFTER set in the PR |

These not-yet-released versions are rows in an append-only table, not release
evidence: the stack merges in order `#2 → release 0.4.0 → #3 → release 0.5.0 →
#4 → release 0.6.0`, and each row becomes `pass` when its tagged version ships.

What the v0.6 local run actually proved:

1. `dsh plugin --profile web add <tarball>` installs the published tarball;
2. `dsh --profile web --dump-config` composes exactly one
   `- id: openviking-enhance` row naming `dsh-openviking-enhance`, and the version
   in the profile's installed `node_modules/dsh-openviking-enhance/package.json`
   **equals the version read from `package/package.json` inside the packed
   tarball** (both are recorded in the JSON summary as `installedVersion` and
   `tarballVersion`);
3. the profile **boots** and the real shell **composes this plugin's client
   half** into its boot page; the served composed bundle registers
   `window.__ModuleLoader__`/`load` and names the package (the shell's combo
   route, not a direct file path — matched to how DSH 0.2.x actually serves
   client bundles);
4. the plugin host route `GET /api/openviking-enhance/config` answers JSON
   without an API key field, and `GET /api/openviking-enhance/scope` answers a
   capability map;
5. reinstalling the same tarball is idempotent (one row, same version);
6. uninstall removes the row, the host route no longer answers 200, and the
   boot page no longer composes the client half;
7. the scratch home is cleaned up.

## Scenario checklist (manually re-run per release when CI cannot)

CI covers 1–6, 8–10 on Linux; the rest is maintainer evidence recorded here:

| # | Scenario | Covered by |
| --- | --- | --- |
| 1 | clean-profile install from the published tarball, installed version equals the packed version | `verify-install` (reads the tarball's `package/package.json`) |
| 2 | profile boot / non-blocking activation | `verify-install` |
| 3 | client bundle composed + host route answers | `verify-install` |
| 4 | tabs and `/viking` command present (browser render) | manual (mock-fixture capture or live DSH) |
| 5 | read paths: recall explain, preview, search, rules, skills, experience | host smoke against a live server (read-only) + manual |
| 6 | writes off by default (no write surface reachable) | unit/fence/smoke tests + manual |
| 7 | writes on, with a **disposable** profile only | manual, never CI |
| 8 | reinstall keeps exactly one row and the packed version | `verify-install` |
| 9 | upgrade from the previous published version | `verify-install --upgrade-from` (CI: tags only) |
| 10 | uninstall leaves no row/route/bundle | `verify-install` |
| 11 | Desktop carrier from the Plugins page | manual, Desktop app (not CI) |
| 12 | `pnpm test` full gate | CI `test` job |

| 0.7.0 (Unreleased branch) | — | TBD (native cockpit is browser-only) | TBD | TBD | TBD read-only | `pnpm pack` tarball → clean DSH profile (visual evidence teammate) | pending its PR | scenario checklist below; screenshots to be attached to PR #5 |

### v0.7 native-cockpit scenario checklist (evidence owner: verification teammate)

The native cockpit is browser-only, so the install-verify script can only prove
the bundle/route halves. The browser evidence must record, from a **clean DSH
profile** against the **live read-only OpenViking server** and with the v0.6
build as the "before" (Studio-iframe-only reading), each step's before/after
capture (redacted; `SMOKE_VERBOSE=1` never on for published evidence):

1. OpenViking row → native **Overview** paints (identity/version/totals/checks);
   the v0.6 build shows the Studio iframe for the same row.
2. **Browse**: expand `memories`, page a long directory with Load more, select a
   file and page its L2 with Show more, then "Show subtree" on a directory (the
   notice says 2 levels/100 nodes).
3. **Sessions**: page the list, filter by kind/id, open a session detail, open
   an archive diff; note that no transcript is shown.
4. **Commits**: recent list paints; force a refresh; if the fake live store is
   large enough, stop at the 8-session cap and capture the partial notice.
5. **Stats**: four metric cards plus category/hotness, and the explicit
   Refresh (no polling in the native views).
6. **Onboarding**: first-run card in Overview (all checks + hints), mark one
   done, run full check, dismiss, then reload and confirm the collapsed one-line
   state; Plugins-page Setup card shows the same count and opens Overview.
7. **Studio fallback**: switch to the Studio view (iframe works against 0.5.3)
   and capture "open in a new tab"; if a header-blocking fixture/served build is
   available, capture the blocked-studio explanation.
8. **Older-DSH fallback**: if a pinned older generation without
   `ctx.layout.selectPanel` is available, capture the Preview tab's absent
   "Open in cockpit" action (label/fallback note); otherwise record explicitly
   that this leg was not exercised.
9. **Read-only check**: the scenario run must not change any memory; re-opening
   Browse/Sessions shows the same server data, and the OpenViking request log
   contains only GETs (plus the validation-only rule probe).

## Live evidence

- v0.4/v0.5 browser evidence: mock-fixture captures from the verification
  teammate (clean profile, stand-in OpenViking fixture), linked from the PRs.
  This is explicitly **not** real-server evidence.
- v0.6 per the Lead sign-off adds no real-server screenshots: the trust/verify
  release changes no rendered surface beyond cost/privacy copy and the partial
  list notice. Real clean-profile + real-OpenViking evidence belongs to a later
  community-submission step, recorded there.
- Empty states are evidence of their own: when a list is empty, the capture
  script records what independent check ruled out a wrong path (e.g. "no
  Experiences": `fs/ls` of the experiences root answered the server's
  `NOT_FOUND`, and the server's own source writes experiences under
  `memories/experiences/`).

## Not covered here

- **Windows** — unverified; no CI runner, no clean-profile record.
- **macOS GUI automation / Electron desktop carrier** — manual only; the
  install-verify script drives the CLI/web profile, not the Desktop app.
- **Browser rendering in CI** — no headless browser in this repository; the
  client half is checked by the smoke harness and server-rendered component
  tests, and the UI itself by manual/screenshot evidence.
- **Real OpenViking data writes** — never in CI or automated tests; a maintainer
  who exercises write paths must use a disposable profile and never paste bodies
  into logs.
- **The official memory plugin installed end-to-end** — the host smoke runs a
  fake Cordis context; the mount/unmount path is unit-tested, not installed in
  CI.

## Update rule

Every release PR adds one dated row above (version, DSH/Node/OS, OpenViking
range actually probed, install path, result, evidence link), pastes or links the
`pnpm run verify:install` summary, and links the CI `install-verify` run. A row
that cannot be produced blocks the tag. When the tested DSH or OpenViking range
changes, update the compatibility chapter in both READMEs in the same PR (a test
asserts the README contract block matches `src/shared/limits.ts` and the exported
version ranges).
