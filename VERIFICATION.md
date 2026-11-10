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

## Base review status (fixed v0.9 base)

v1.0 is rebased onto the **fixed v0.9 head `b64d9cf`**, which carries the fixes for
PR #7's review round 1: **B1** client scope switch chain, **B2** peer read lens is
never write authority, **B3** session-scope mismatch gates writes host- and
client-side, **B4** expired tokens purged so a stale dialog cannot block a switch,
**B5** the activity metrics cache resets on a switch — plus ACL **S2** (no guess:
only documented `inherit`/`restricted` modes echoed, missing mode unknown, 401/5xx
distinguished). Regression tests: `test/v09-client-scope.test.mjs`,
`test/v09-component.test.mjs` (B1/B3/S4/S11),
`test/v09-scope-routes.test.mjs` ("Review round 1 regression tests"),
`test/v09-scope-units.test.mjs` (B4). PR #8's own review round 1 (N1 hidden-poll
self-loop, N2 mount focus steal, S1/S2/S4/S5) is addressed in this revision; see
`ACCEPTANCE.md` §13 and the CHANGELOG "Fixed (PR #8 review round 1)" entry.

## Verified matrix

| Version | Date | DSH (profile) | Node | OS | OpenViking | Install path | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.4.0 (PR #2) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 read-only | tarball into a scratch DSH home + mock-fixture browser capture | **pending release** — browser render evidence only; 0.4.0 is not tagged/published yet, so no clean-profile install record exists | PR #2 screenshots + review evidence; row becomes `pass` when the release ships |
| 0.5.0 (PR #3) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 contract via stand-in fixture (no real writes) | tarball into a scratch DSH home + stateful mock-fixture browser capture | **pending release** — browser render evidence only; 0.5.0 is not tagged/published yet | PR #3 BEFORE/AFTER capture set; write paths covered by fake-transport unit tests |
| 0.6.0 (PR #4) | 2026-11-10 | 0.2.1-rc.3 local + 0.2.2-rc.1 pinned in CI | 22.22.3 | macOS (Darwin 24); Linux CI | 0.5.3 reachable, read-only; mock fixture for the UI deltas | `pnpm pack` tarball → scratch `DSH_HOME` web profile | pass | `node scripts/verify-install.mjs …` → 27/27 steps, `tarballVersion === installedVersion` (0.3.0); CI `install-verify` job on the PR; browser BEFORE/AFTER set in the PR |
| 0.8.0 (PR #6) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22 | macOS 15 | 0.5.3 read-only + deterministic fake fixture for the action layer | tarball into a scratch DSH home; browser capture of the v0.7 cockpit + v0.8 fixture-labelled dialogs/plans/downloads | pending release — no live-store write: every action is exercised against the fake server/fake transport; live reads only) | `pnpm test` (v08 route/unit/component suites + smoke); fixture-labelled action screenshots; live read-only Snapshots/Compile/Tasks/Observability rows |
| 0.9.0 (PR #7) | 2026-11 | 0.2.2-rc.1 (web, scratch profile) | 22.22.3 | macOS 15 | 0.5.3 read-only (single live scope) + three invented fake servers (dev A, dev B, api_key C) for the multi-scope evidence | `pnpm test`; no live-store write anywhere — every scope/identity switch in tests is exercised against the fake servers and the fake `ctx.connection.fetch` transport; live server is read-only `/health`/reads | **pending release** — browser/evidence set: fixture-labelled two-scope capture (scope menu, banners, switch notice, ACL states) + live single-scope read-only screenshots; `pnpm test` includes the v0.9 host route/unit + component render suites |

| 1.0.0 (PR #8 — final; rebased on the fixed v0.9 head `b64d9cf`; ships the whole v0.4–v0.9 stack if no intermediate tags are cut) | 2026-11 | 0.2.2-rc.1 pinned in CI; 0.2.1-rc.3 local | 22 | macOS 15 M; Linux CI | 0.5.3 read-only + deterministic fake fixtures for the action/scope layers | `pnpm pack` tarball → scratch `DSH_HOME` web profile (`verify:install`) + browser BEFORE(v0.9)/AFTER(v1.0) capture | pending tag — hard gates green after review round 1 (`pnpm test` 566/566 unit, `verify:install` 27/27); a11y/bilingual/performance/degraded suites added; PR #7 blockers fixed in base and PR #8 review items addressed (ACCEPTANCE §13); human sign-off block still empty | v1.0 tests (`test/v10-*.test.mjs`), v0.9 review regression tests, F1–F14 ledger, final matrix, `ACCEPTANCE.md`; CI links to be filled at tag time |

These not-yet-released versions are rows in an append-only table, not release
evidence. Two release paths are documented in `RELEASING.md`:
**primary** — one tag per merged PR (`#2 → 0.4.0 → … → #8 → 1.0.0`); **fallback**
(applicable at drafting: no intermediate version has been tagged or published) —
the whole `## Unreleased` block is promoted into a single **1.0.0** section and
the rows above ship in that tag. The human sign-off block in `ACCEPTANCE.md`
gates the tag either way.

## PR #6 review round 1 (v0.8) — fixed evidence

| Review item | Fix | Evidence |
| --- | --- | --- |
| B1 ancestor-of-sessions restore/commit | `classifySnapshotScope` now refuses the sessions tree, its descendants **and every ancestor of it** (`viking://user/<me>` included); classifier unit tests assert all three | `test/v08-units.test.mjs` |
| S3 clamped-50 plan counts | `SnapshotRestorePlan.writeTotal/deleteTotal` carry the real dry-run counts; the dialog shows them even when the row list is capped and states "showing X of Y" | unit test + dialog copy |
| S1 pack body deadline | per-chunk inactivity (30 s) and overall body deadline; aborted streams delete the partial file and release the shared mutation gate | `test/v08-units.test.mjs` stalled-body test |
| S2 pack user scope | pack export requires the active user (bare `viking://user` and other identities refused); both READMEs state a pack contains full session text | classifier unit tests + README |
| S4 execute re-runs action gate | `OpsService.execute` re-runs `gateFor(token.action)` after the token checks and before the identity check | route unit tests (capability flip) |
| S6 verifyCommit comment | bounded 3-attempt read-back retry implemented; the service takes a branch (unit-tested with `release`) and the v0.8 action call sites pass the documented fixed `main` | route test with a lagging snapshot log |
| S5 undo expected paths | normalized full-URI comparison (not basenames) and the undo dry run is re-run immediately before Apply | unit test (same basename, other directory) |
| S7 destructive tests | revision-mismatch (`restoreMode:'conflict'`), pack-too-large, non-zip signature, expired download token, gate contention, undo-after-identity-switch | `test/v08-*` |
| Smaller items | partial-writeback branch now writes a real audit row and returns its id; typed-word confirm disabled until it matches; empty `publishOperationId` removed; file-version audit no longer fills `snapshot.sourceCommit`; downloads swept on history read/startup/client abort; undo stays available if `enableOps` is switched off after the action; evidence fan-out has a 15 s overall deadline; message cap unified in `limits.ts`; read-route `paths` capped; pack transport errors are not cached; download tokens are identity-checked on consume | unit/route tests |

### Known limits (not covered by round 1)

- Ops tokens are in-memory: a host restart invalidates pending confirmations and
  undo handles (documented; the audit file is the durable record).
- A pack export that finishes after the client vanished can leave a temp file
  until the next sweep (startup/history/export) — deleted at most one sweep later.
- The undo dry run is re-checked immediately before Apply, but a write that
  lands between that check and the server applying the restore is the server's
  forward-commit semantics (audit + reindex still record it).
- Compile re-run is a NEW operation; there is no idempotent retry across
  different keys by design.
- Live destructive-action screenshots against a real store remain out of scope
  (tests use the deterministic fake server); fixture evidence is labelled.

## PR #6 review round 2 (v0.8) — fixed evidence

| Review item | Fix | Evidence |
| --- | --- | --- |
| B2 non-canonical URIs bypass the sessions ancestor rule | `classifySnapshotScope` builds the canonical `viking://` form once, uses it for every sessions comparison and returns it downstream (plan/audit/undo); `classifySnapshotPaths` inherits it | unit tests: `viking://user//alice` and `viking:///user/alice` refused; `viking://user/alice//memories` → `viking://user/alice/memories` |
| N1 the S5 test could not fail on the old implementation | the case now runs a real `applyRestore` (`writtenPaths:['report.md']`) and asserts the same-basename/other-directory plan is `extraChanges`; the old basename implementation fails it | `test/v08-units.test.mjs` S5 case |
| N2 truncation flag contradicted the copy | per-array clamp flag (both prepare and undo plans); 40+40 rows is not truncated | unit test (60/55 and 40+40) |
| N3 `verifyCommit` retried failed requests | `!ok` returns false immediately; only a successful stale head gets the bounded ~0.2 s retry | unit test for both paths |
| N4 pack copy | both locale dictionaries and the README state the active-user rule, not the old "user/**" wording | locale parity + README |
| N5 cross-instance temp-file sweep | filenames carry the owning pid; startup sweep keeps live owners and our own files, deletes dead owners and legacy files older than one TTL | unit test (orphan matrix) |
| N6 pack probe timeout | probe passes the 5 s status budget instead of the 120 s stream default | capability probe code |
| N7 double undo dry run | the undo apply path runs one dry run (plan + pre-apply read in one) | S5 test asserts the dry-run call count |
| N8 residuals | dead duplicate error branch, unused import, unconsumed re-export and `void startedAt` removed | typecheck + review of diff |
| N9 over-claiming evidence | the **stalled-body** test proves the inactivity deadline; a separate **total-deadline** test proves the `totalMs` branch; `verifyCommit` supports/passes a branch and v0.8's call sites use the documented fixed `main` | `test/v08-units.test.mjs` deadlines |
| N10 rejected-promise handling | the inactivity helper rejects the outer promise directly | unit tests |

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

| 0.7.0 (PR #5, pending) | — | TBD (native cockpit is browser-only) | TBD | TBD | TBD read-only | `pnpm pack` tarball → clean DSH profile (verification teammate) | pending PR #5 | scenario checklist below; browser captures under `assets/v07-*` (before/after) attached to PR #5, final row filled at merge |

### v0.7 native-cockpit scenario checklist (evidence owner: verification teammate; captures under `assets/v07-before-*` / `assets/v07-after-*`)

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

**Stills to re-shoot after PR #5 review round 1.** Two scenes captured earlier
predate the review-round-1 UI text and are stale by design; the Lead re-shoots
them before merge (the README/CHANGELOG describe both changes):

- `assets/v07-after-plugins-setup.png` — the Plugins-page Setup card now also
  offers "Forget local setup state" (and its hint).
- `assets/v07-after-native-browse.png` — a directory whose loaded page reports
  `hasMore` now renders its count as `N+ entries (more available)` instead of a
  plain total.

## v1.0 acceptance checklist (manual items + automated suites)

Automated at drafting: `pnpm test` (typecheck/build/packaging/independence +
a11y, bilingual-render, performance-budget, degraded-copy suites + client/host
smoke) and `pnpm run verify:install` (27/27 clean-profile steps). Manual evidence
still required before tagging, recorded here by the maintainer:

- [ ] browser capture set: BEFORE = v0.9 build, AFTER = v1.0 build (a11y/final
      diffs), fixture-labelled where data is invented
- [ ] Studio-off core-flow walkthrough (12 steps, README section) with screenshots
- [ ] keyboard-only pass over tree/tabs/dialogs/scope menu (ACCEPTANCE §10)
- [ ] screen reader pass (macOS VoiceOver); Windows/NVDA remains **U**
- [ ] both themes contrast + 200% zoom + reduced-motion checks
- [ ] EN and ZH walkthrough of the 12 daily checks
- [ ] CI run id (unit + install-verify jobs) linked in the 1.0.0 row
- [ ] review status confirmed: fixed v0.9 base `b64d9cf` (PR #7 blockers B1–B5 +
      ACL S2 regression tests) and PR #8 review round 1 addressed (ACCEPTANCE §13)
- [ ] human sign-off block in `ACCEPTANCE.md` completed

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

### What the v0.9 review round 2 fixed (and how)

- Round 2 (verdict approve) pre-merge items + follow-ups fixed: evidence-attachment
  scope header (E2E), switch-back plans only allowed differing identity fields with
  the error surfaced (component tests incl. peer-only under `api_key`), `/scopes`
  probes before computing rules and "Refresh health" refreshes both scopes (E2E
  recovery from unprobed and from unhealthy), Activity "Commit now" gated like the
  commit pill, the session-scope record stores the endpoint (legacy endpoint
  changes mismatch; old files tolerated — E2E + unit), and the host switch mutex
  now spans the async switch handler (E2E race test). Small drift (N7) fixed too.
  No real OpenViking store was written; the fake servers remain the only mutation
  targets.

### What the v0.9 review round 1 fixed (and how)

- Five blockers + material suggestions addressed; the full list is in
  `CHANGELOG.md` under "v0.9 — review round 1 fixes". Evidence: full `pnpm test`
  (typecheck + build + packaging/independence + unit + client/host smoke) green;
  new `test/v09-client-scope` integration suite drives the real `scopedFetch` /
  store (identity round-trip, host-side switch discovery, ConfigForm switch,
  in-flight-read abort); the v0.9 route suite gained sessionless-write peer,
  session-scope-mismatch write refusal, scope-scoped Activity metrics, ACL
  401/500/no-mode, corrupt-scope-state boot, discovery-route and active-profile
  deletion cases; the component suite gained the banner error state, warnings
  rendering, blocked-reason copy, recorded session identity and the
  preview/force-commit gating predicates. No real OpenViking store was written;
  the fake servers remain the only mutation targets.

### What the v0.9 local run proved (scope layer)

1. `pnpm run typecheck` / `pnpm run build` stay green with the new host modules
   (`scope-state`, `scope-service`, `session-scope-map`, `acl-service`,
   `plugin-connection-facts`) and the new client stores/components.
2. The v0.9 host route suite boots the built host against **three invented fake
   OpenViking servers** (dev A, dev B, api_key C): boot precedence (Config →
   scope state → profile header → legacy), response scope labels, request-side
   `scope-changed`, host-side stale-read refusal, guarded switching, identity
   overrides per auth mode, `identity-changed` undo refusal, the session-scope
   mismatch, the four ACL states, and **zero `/admin` requests** in every flow.
3. The v0.9 component suite renders the real client bundle and checks the scope
   menu's grouping/health/warnings, the disabled identity fields with the
   auth-mode reason, the persistent banner and switch notice, the two scope
   switches, the session mismatch banner and the Access tab's first paint.
4. `pnpm run smoke` adds the offline scoped routes, the wrong-scope `409`
   refusal, the ACL state answer, and the "no key in any scope payload" check;
   the live read path stays redacted and read-only.
5. No test wrote a real OpenViking store: the fake servers are the only mutation
   targets and the live server is only read.

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
