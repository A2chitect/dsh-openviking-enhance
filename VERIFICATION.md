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
| 0.4.0 (PR #2) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 read-only | tarball into a scratch DSH home + mock-fixture browser capture | pass (browser render only; no clean-profile install/uninstall record) | PR #2 screenshots + review evidence; see "Live evidence" |
| 0.5.0 (PR #3, awaited) | — | — | — | — | — | — | pending its PR | — |
| 0.6.0 (Unreleased branch) | 2026-11-10 | 0.2.1-rc.3 (local binary; CI pins 0.2.2-rc.1) | 22.22.3 | macOS (Darwin 24) | 0.5.3 reachable, read-only | `pnpm pack` tarball → scratch `DSH_HOME` web profile | pass | `node scripts/verify-install.mjs --dsh "$(command -v dsh)" --tarball /tmp/dsh-openviking-enhance-*.tgz --json-out /tmp/install-verify.json` → 23/23 steps, about 5 s; CI: `install-verify` job (URL added on the PR) |

What the v0.6 local run actually proved:

1. `dsh plugin --profile web add <tarball>` installs the published tarball;
2. `dsh --profile web --dump-config` composes exactly one
   `- id: openviking-enhance` row naming `dsh-openviking-enhance`, and the
   installed package version is the tarball version;
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
| 1 | clean-profile install from the published tarball | `verify-install` |
| 2 | profile boot / non-blocking activation | `verify-install` |
| 3 | client bundle composed + host route answers | `verify-install` |
| 4 | tabs and `/viking` command present (browser render) | manual (mock-fixture capture or live DSH) |
| 5 | read paths: recall explain, preview, search, rules, skills, experience | host smoke against a live server (read-only) + manual |
| 6 | writes off by default (no write surface reachable) | unit/fence/smoke tests + manual |
| 7 | writes on, with a **disposable** profile only | manual, never CI |
| 8 | reinstall keeps exactly one row | `verify-install` |
| 9 | upgrade from the previous published version | `verify-install --upgrade-from` (CI: tags only) |
| 10 | uninstall leaves no row/route/bundle | `verify-install` |
| 11 | Desktop carrier from the Plugins page | manual, Desktop app (not CI) |
| 12 | `pnpm test` full gate | CI `test` job |

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
