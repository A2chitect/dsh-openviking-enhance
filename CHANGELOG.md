# Changelog

Notable changes to `dsh-openviking-enhance`. The `version` field in
[`package.json`](package.json) is the source of truth; every release is tagged
`vX.Y.Z` in git. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Notes for the next release go under `## Unreleased`, which `pnpm run release`
promotes to a dated section — see [RELEASING.md](RELEASING.md).


## Unreleased

### v1.0 — Native complete (this PR)

Native — complete. The final roadmap version is a completion/polish/verification
release, not a new interaction paradigm: the core explain/operate/trust flow runs
inside DSH without the Studio iframe, the plugin's own widgets are
accessibility-aligned, bilingual parity is enforced at render time, request
budgets are test-enforced, degraded states share one localized copy layer, and
the licence/API-stability decision plus the acceptance record are now tracked
files. **No new write semantics**: every v0.3–v0.9 behaviour is additive and the
write/ops gates are unchanged.

#### Added

- **F1–F14 native-completeness ledger + Studio-off core-flow walkthrough** in both
  READMEs: every core task names its native surface, the version that shipped it,
  and whether Studio is required (F10 capture pause/archive retry and the
  Studio/CLI-only advanced operations stay documented non-goals with their
  upstream dependency).
- **Final compatibility/evidence matrix** with honest **L / CI / M / D / U**
  labels (Windows, desktop write parity, OpenViking 0.5.2/0.5.4, non-`dev` auth
  modes stay unverified; nothing upgraded to "verified" without evidence).
- **Tracked decisions** — `DECISIONS.md`: MIT + independently implemented contract
  (with the escalation trigger and the independence gate as the control) and the
  API-stability classification (own semver surface, DSH pinned range, OpenViking
  tested range + probes, official-plugin in-process state explicitly unstable),
  plus the post-1.0 semver policy and the release-path/upgrade-pin decision.
- **`ACCEPTANCE.md`** — verdict taxonomy, roadmap goal/exit-criterion mapping,
  invariants, 12-item daily-check checklist marked **frequency-unmeasured**, the
  5-real-users protocol marked **externally-unverified** (no fabricated study),
  manual a11y/bilingual/degraded checklists, known limitations, and the human
  sign-off block that gates the `v1.0.0` tag.
- **Accessibility (WCAG 2.2 AA-aligned for the plugin's widgets)**: Browse is a real
  ARIA tree (roving tabindex, Up/Down/Home/End, Right/Left expand-collapse-enter-
  leave, Enter/Space select, `aria-level`/`aria-selected`/`aria-expanded`/`aria-busy`);
  every tab strip (cockpit/Explore/Activity/Browse/Stats/Operate/Preview) is a
  tablist/tab/tabpanel with `aria-labelledby` (no dangling `aria-controls`: only
  the active panel is mounted), arrow/Home/End selection that skips unavailable
  preview tiers, and roving tabindex; write/ops/undo dialogs trap Tab and restore focus
  to the opener; toasts/host warnings are explicit live regions (assertive errors,
  polite outcomes); the scope trigger announces `aria-haspopup`/`aria-expanded`,
  Escape closes and restores focus; `:focus-visible` rings, reduced-motion CSS,
  light/dark contrast fallbacks and 200% zoom resilience ship in the stylesheet.
  New `test/v10-a11y.test.mjs` covers the pure keyboard models and the rendered
  ARIA wiring (no new dependency, no browser CI; manual checklist in ACCEPTANCE).
- **Bilingual render audit** (`test/v10-locale-audit.test.mjs`): major surfaces are
  rendered in EN and ZH and fail on raw locale keys or hardcoded copy; `Intl`
  date/count formatting helpers are used for user-facing timestamps. README/
  README.zh ledger and matrix rows are mirrored and asserted. `/viking` command
  output stays English and is documented as a limitation.
- **Test-enforced performance/request budgets** (`test/v10-performance.test.mjs`):
  one composed `/overview` request (single-flight, 5 s cache, per-part degradation),
  no hidden polling (all recurring requests go through the shared schedulers; a
  hidden document creates no timer at all, asserted with a fake clock), poll
  backoff schedule, bounded fan-outs/caches, and the client's one-fetch overview
  path.
- **Unified degraded-state / error copy**: every host code that can reach a
  surface now has EN+ZH `notice.*`/`wcode.*` copy, enforced by
  `test/v10-degraded.test.mjs` scanning the host vocabulary; recovery actions are
  localized buttons.
- **Release prep**: `VERIFICATION.md` 1.0.0 row + v1.0 manual checklist,
  `RELEASING.md` 1.0.0 path (primary per-version vs current single-tag fallback),
  upgrade-pin rule and no-retag rollback policy; `DECISIONS.md` ships in the
  package (CI tarball/check-package assertions) while `ACCEPTANCE.md` is
  repository-only.

#### Changed

- The READMEs' requirements/matrix wording now reflects the final tested matrix
  and the 1.0.0 release path; the top-of-file `Unreleased` note names v0.8–v1.0.
- Activity detail polling and the health log polling now use one
  visibility-gated interval helper instead of per-component timers.

#### Fixed (PR #8 review round 1)

- **N1 — hidden-tab polling self-loop.** Activity's list poll scheduled
  `setTimeout(load, nextPollDelay({hidden:true}))` where the policy's `0` means
  "do not schedule", so a hidden tab re-armed a zero-delay timer forever. Both the
  Activity list and the commit-status poll now go through a single, testable
  `startScheduledPoll` helper: a hidden document creates **no timer**, `delay <= 0`
  stops the loop until an event resumes it, a resume loads immediately and then
  recomputes the delay from the latest facts. Covered by fake-clock tests
  (hidden → 0 timers; 0 → no schedule; running task → next delay 5 s) and a
  structural guard that only `poll-policy.ts` may own a router timer.
- **N2 — mount-time focus steal.** `ScopeChip`/`ScopeBanner` focused their trigger
  in an effect whenever `open === false`, which ran on mount and stole focus from
  the new roving-tabindex surfaces. Focus is now restored only on a true→false
  transition (pure `shouldRestoreFocus(prev, open)` helper + tests); a mount is a
  no-op.
- **S1 — dangling `aria-controls`.** Only the active panel is rendered, so six of
  seven `aria-controls` IDREFs pointed at nothing. The tabs now rely on
  `aria-labelledby` (panel labelled by a real tab id; component test asserts every
  IDREF resolves and tab ids are unique).
- **S2 — frozen activity cadence.** The "a task is working" fact was captured in
  the effect closure, so the 5 s active cadence never happened. The poll now
  writes the fact to a ref after a successful load and the scheduler reads it when
  scheduling; a fake-clock test proves the next delay switches from idle 30 s to
  active 5 s after a load reports a running task.
- **S3 — behavioural a11y tests.** The scope menu is now rendered with fake state
  and asserted by roles/counts (`role="menu"`, one `menu` per group, one
  `menuitem` per profile row, exactly one `aria-current`), instead of grepping the
  source; the CSS assertions are labelled structural guards and the corresponding
  contrast/zoom/reduced-motion acceptance rows are manual.
- **S4 — menu keyboard reachability.** Opening the scope menu now focuses its
  first enabled `menuitem` (or the dialog root when every row is disabled), so the
  Arrow/Home/End handler on the menu container is reachable; pure
  `firstEnabledIndex`/`nextMenuIndex` helpers are unit-tested.
- **S5 — structural polling guard.** The old test only scanned `setInterval`;
  it now scans both timer APIs with an explicit allow-list of one-shot timers,
  asserts the two polling consumers own no timer, and the fake-clock tests cover
  the recursive `setTimeout` pattern directly.
- **S7/S8 — wording aligned with code.** "No guessing" now also covers the ACL
  state machine (only the server's documented `inherit`/`restricted` modes are
  echoed; a missing mode stays unknown; 401/5xx are distinguished — regression
  tested in the v0.9 base). README/CHANGELOG claims about hidden polling and
  `aria-controls` were corrected to the shipped behaviour.
- **S9 — disclosure semantics.** Host warnings keep their native `<details>`
  disclosure; the polite live region is the summary count instead of a
  `role="status"` on the whole expandable group.
- **Smaller review items**: Activity detail reads are aborted on unmount and never
  overlap; `Intl` formatters are cached per locale; the browse shortcut row is a
  labelled `treeitem` (`role="none"` wrapper); dialog focus falls back to the
  panel container when the opener unmounted; the focus ring now also covers the
  dock slots (scope chip/commit pill); `/viking` placeholders that shipped
  hardcoded filter examples are localized.
- **B0 — base review status.** The rebased v0.9 base (`b64d9cf`) carries the fixes
  for PR #7's five review blockers (B1 client switch chain, B2 peer/read-write
  boundary, B3 session-scope write gating, B4 expired-token purge, B5 activity
  cache reset) and the ACL S2 no-guess fix, with regression tests
  (`test/v09-client-scope.test.mjs`, `test/v09-component.test.mjs`,
  `test/v09-scope-routes.test.mjs` "Review round 1 regression tests",
  `test/v09-scope-units.test.mjs`). `ACCEPTANCE.md`/`VERIFICATION.md` now state
  that status instead of vouching for an unfixed base.

#### Verified

- `pnpm test`: typecheck, build, packaging contract, independence gate, **566**
  unit tests, client smoke and host smoke (live read-only path redacted) all
  green; new v1.0 a11y/locale/degraded/performance suites included.
- `pnpm run verify:install`: 27/27 clean-profile steps; also runs as a CI
  `install-verify` job pinned to DSH 0.2.2-rc.1.
- `test/v10-docs.test.mjs` enforces this ledger/matrix/decisions/acceptance
  documentation and the package-vs-repo file split.
- Limitations recorded, not hidden: user study **externally-unverified**,
  daily-check frequency **unmeasured**, Windows and desktop-write parity **U**,
  real-store writes **fixture-only**, browser/a11y automation absent (manual
  checklist), `/viking` output English.

### v0.9 — Native II: multi-scope, identity overrides and the read-only ACL view (PR #7)

The scope/isolation layer. A **scope** is the active v0.5 server profile plus an
optional in-server identity override (account/user read selectors; peer read
lens); its key is the existing secret-free identity fingerprint. Multiple servers
and identities are now first-class, visibly labelled everywhere, and isolated —
each plugin request carries the scope key, every response is labelled, a switch is
guarded, and stale in-flight reads can never render under the new scope. No new
dependency, no AGPL code, no new shell seat; every mutation path is unchanged
(writes/ops stay identity- and scope-bound).

#### Added

- **Scope model + persistence.** `scope-state.json` (0600, atomic, per DSH home)
  holds the last active profile id and the optional account/user/peer overrides;
  boot precedence is Config override → scope state → `profiles.json` header →
  legacy resolution (corrupt files fall back and are reported through the
  existing config-source health surface). A profile switch persists the new scope
  and resets the overrides; the scope key/fingerprint contains no secrets.
- **Identity switching (F12 completion).** `dev`/`trusted` profiles allow
  account/user header overrides (trusted needs both; the plugin still never sets
  a role header); `api_key` is key-bound with the fields disabled and a stated
  reason; `oidc`/`ldap` are out; unreachable disables switching. The peer selector
  is a **read lens only** (`X-OpenViking-Actor-Peer` on sessionless reads), never a
  write authority; the scope block always shows the effective peer. The
  identity-override mutation is local (`POST /scope/identity`, writes only the
  0600 state file) and rides the authenticated transport.
- **First-class scope switcher.** Cockpit toolbar + Overview scope menu: servers
  grouped by endpoint with label, auth mode, account/user/peer, probed
  health/version/latency, per-scope capability summary, stable warning codes and
  the active row; identity section with disabled fields/reasons; switch, refresh
  health and test connection; profile creation/editing stays in the existing
  Plugins-page editor. New `showScopeSwitcher` switch (default **true**) hides only
  the menu; the persistent banner keeps the existing `showScopeBanner` switch.
- **Guarded switching.** Refused while any curation/ops confirmation, write or
  undo is pending or executing (plus a double-click cooldown); in-flight reads are
  aborted and dropped; the cockpit resets to Overview and plugin right-sidebar
  pages close; the switch is audited with from/to scope keys and labels;
  the write/ops token semantics are unchanged, so previous-identity tokens/undos
  stay visible but refuse with `identity-changed`.
- **Isolation.** `x-dsh-openviking-scope` on every request; the host refuses
  mismatches with `scope-changed` before any work and labels every response;
  composed reads that finish after a switch answer `scope-changed` instead of a
  stale payload; caches are cleared on a switch (the approved clear-all fallback
  for the per-scope policy — no scope cache set is retained) with capability
  matrices and ACL reports per scope; no federated/cross-server search; search
  result URIs are
  validated against the active readable roots and out-of-scope hits are dropped
  with one warning.
- **Session and pipeline guards.** A bounded best-effort local
  `session-scopes.json` (0600, no bodies/keys/endpoints) records which scope last
  observed a DSH session; a mismatch shows a banner on the recall/preview/health/
  activity surfaces and disables that session's recall/write actions until the
  user switches back. An allowlisted, secret-free projection of the official
  memory plugin's connection facts can warn that the conversation pipeline is
  captured elsewhere; it is advisory, read-only and fails open to "unknown" — the
  official plugin is never reconfigured.
- **Read-only ACL / Access view.** The Browse preview gains an **Access** tab for
  `viking://resources/**` only: the ACL report as direct/inherited/effective tables
  when available, plus the four explicit states `available` /
  `denied-no-manage` (the deliberate 403 ambiguity: ACL may be off **or** the
  identity lacks manage — never guessed) / `only-resources` / `unsupported`, the
  visibility classification (account-shared, private user tree, peer, agent,
  session) and an explicit "no sharing/invite API exists in the tested builds"
  statement. No ACL edits, no admin/account/group/key calls (tests assert zero
  `/admin` requests).
- **Docs/tests.** README EN+ZH host-contract additions (scope model, switching,
  identity rules, isolation, session map, official-plugin advisory, ACL/sharing
  limits, remote warning, new 0600 state files, role split), VERIFICATION row
  scaffold, new limits in `src/shared/limits.ts` with the documented parity test;
  new host unit/route suites with **three invented fake servers** (dev A, dev B,
  api_key C) and component render tests for the scope menu/banners/Access tab;
  smoke additions (offline scoped routes, wrong-scope refusal, no key in scope
  payloads).

#### Honest limitations (shipped and documented)

- Auth-mode gates: account/user switching exists only in `dev`/`trusted`;
  `api_key` is key-bound, `oidc`/`ldap` and unreachable servers disable switching.
- **Client-side labels/caches are not a security boundary** against server ACL
  misconfiguration; the server's auth/ACL remains the real boundary. Two profiles
  pointing at the same endpoint+identity are different labels for the same data.
- The session→scope map is best-effort local state: a missing record means
  "unknown", never "matches".
- **The official plugin's pipeline is not rebound** by a cockpit scope switch; the
  compatibility warning is an allowlisted, advisory projection only.
- The ACL view is resources-only and read-only; a 403 is reported as the
  documented ambiguity, not as "ACL disabled".

### v0.9 — review round 1 fixes (PR #7)

The automated review's five blockers and the material suggestions. No API shape
changed for v0.7/v0.8 surfaces; the scope layer's own contract got stricter, and
every claim the docs made is now either implemented or downgraded.

#### Fixed (blockers)

- **B1 — the client switch chain works.** `/scope` and `/scopes` are now
  **discovery routes**: they accept a request that still carries the previous
  scope key (the host may already have moved) and answer with the current scope,
  labelled; every other route keeps refusing stale keys with `scope-changed`.
  Scope-changing mutations reply with the new scope payload and the client adopts
  it instead of rejecting the response as stale: `POST /scope/identity` returns the
  full scope; profile CRUD returns the redacted profile list and the client
  re-reads `/scope` (there is no scope payload in the profile CRUD response). The banner shows "scope unavailable / reload" on a failed
  re-read instead of keeping the previous label. New `test/v09-client-scope`
  integration suite drives the real `scopedFetch` + store (the route tests bypass
  it): identity round-trip, host-side switch discovery, ConfigForm profile
  switch, in-flight-read abort/drop.
- **B2 — the peer read selector no longer leaks into writes.** `readPeer` now
  defaults to `false`; Browse/Preview/Sessions/ACL opt in explicitly as
  sessionless reads. Write preparation (revision/tags/verification reads) and
  every mutation send only the official plugin's session actor peer when one
  exists. A test asserts a sessionless prepare sends no
  `X-OpenViking-Actor-Peer` to its reads.
- **B3 — session-scope mismatch actually stops writes.** The host enforces it in
  `WriteService.prepare`/`execute`/`undo` with the stable
  `session-scope-mismatch` code (no cross-scope write even for a stale button);
  the mismatch comparison is the identity tuple (profile/account/user/peer), not
  the key that embeds the lazily probed auth mode; the observation is recorded
  only after a successful read. The preview Edit/Tags/Delete buttons and the
  commit pill gate on the mismatch; commit-status refetches on every scope
  change and the cached per-session answers reset on switch. Tests: "after
  switch, prepare is refused with `session-scope-mismatch`", the two gating
  predicates and the mismatch guard.
- **B4 — expired tokens no longer block switching.** `WriteService` and
  `OpsService` `unresolvedCount()` purge expired tokens first and count only
  pending (unexpired) / executing records; a fake-clock test advances past the
  TTL and asserts switching is not blocked.
- **B5 — the Activity metrics cache is scope-scoped.** `ActivityService` gained
  `resetCaches()`, called from `applyActiveScope`; a route test proves a switch
  re-fetches and returns the new server's aggregates (111 → 222) instead of the
  cached previous ones.

#### Fixed (suggestions and smaller items)

- **S1** ACL follows the peer read selector (`GET /acl` sends it; route test).
  Recall-content reads are deliberately URI-addressed without a peer (no session
  id on that route) and that is documented.
- **S2** ACL failures are classified honestly: 401/403 → `denied-no-manage`
  (auth vs manage detail), 400 → `only-resources`, 404/5xx/network →
  `unsupported` with distinct details; a missing `acl_mode` stays `null` instead
  of guessing `inherit`.
- **S3** Access tab clears the previous resource's principals before loading,
  passes its `AbortController` to `fetchAcl`, localizes detail codes, and the
  Browse preview tab resets to Preview on a new selection/refresh.
- **S4** the mismatch banner shows the recorded account/user/peer; "switch back"
  restores the full identity tuple in one action when the profile already
  matches (a profile switch still resets overrides — the banner keeps showing the
  tuple to restore manually, documented).
- **S5** session observations are recorded only after a successful read and are
  compared by identity tuple (auth-mode-independent).
- **S6** profile deletion is guarded on the resolved scope (a profile activated
  through `scope-state.json` cannot be deleted) and re-resolves a stale state
  pointer after a deletion.
- **S7** `persistProfile` failures are surfaced (`scopeStatePersistFailed`
  warning) instead of swallowed; a corrupt `scope-state.json` found at boot is
  **not** overwritten and keeps its Doctor/config-source evidence
  (`scopeStateCorrupt` warning; route test).
- **S8** switching requires a known-healthy probe (`scope-health-unprobed`
  reason) while an already-stored override still resolves before the first
  probe — the two concerns are separate.
- **S9** `/scopes` health probes run with bounded concurrency
  (`SCOPE_PROBES_CONCURRENCY = 4`) under one overall deadline
  (`SCOPE_PROBES_DEADLINE_MS = 8000`); the banner no longer probes the scope list
  when the switcher is hidden.
- **S10** `SCOPE_SWITCH_COOLDOWN_MS` and `SCOPE_KEY_MAX_CHARS` are wired
  (host admission rejects an over-long scope header with `invalid-scope`; both
  halves use the documented cooldown constant). `SCOPE_MAX_RETAINED_CACHES` was
  removed together with the docs claim: v0.9 ships the approved clear-all-on-
  switch fallback and retains no per-scope cache set.
- **S11** `/scope` warnings render in the chip/banner (not only in the menu); the
  "key-bound" pill is only shown for `authMode === 'api_key'` (a stored key on a
  `dev` profile is shown as "stored, not bound").
- **S12** switching has a host-side mutex (nested switches refused with
  `switch-in-flight`) and a client-side global flag that disables every switch
  control while a switch is in flight.
- Smaller: the pack download/task evidence attachments carry the scope response
  label (documented binary exception: a stream cannot answer a JSON
  `scope-changed` mid-stream; the pack token is identity-bound and the broker
  closes on switch); `ScopeChip`/`ScopeBanner` no longer nest a `div` inside a
  `span`; the blocked-switch message names the real reason and the cooldown
  clears itself; the session-map comment/sort matches the code and its write
  result is checked; the boot chain is state → profiles header → legacy (a
  deleted state pointer continues to the header instead of skipping to legacy).

### v0.9 — review round 2 fixes (PR #7)

Verdict was approve; these are the three pre-merge items and the cheap follow-ups.

- **N1 evidence label.** The `/task/evidence` attachment now carries
  `x-dsh-openviking-scope` like `/task/export` and `/ops/download`, so the README
  claim holds; an E2E test asserts the header on the attachment response.
- **N2 switch-back under key-bound auth.** The banner's "switch back" now sends
  only the identity fields that actually differ and that the auth-mode rules
  allow (`planSwitchBack`): under `api_key` a peer-only mismatch restores with the
  peer selector alone instead of a request the host refuses; a forbidden field is
  reported as unavailable rather than sent; and a refusal's `error` is shown in
  the banner instead of being swallowed. Component tests cover the peer-only
  `api_key` plan, the forbidden-field case and the offered button.
- **N3 health-probe recovery.** `/scopes` awaits the (cached) capability probe
  before computing the override rules, and the scope menu's "Refresh health"
  refreshes both `/scopes` and `/scope`, so the documented
  `scope-health-unprobed` recovery actually works. "Unprobed" and "unhealthy" are
  now distinct states (`scope-health-unprobed` vs `profile-unhealthy` — the
  latter is a server that answered and is down). E2E covers the first-`/scopes`
  recovery and the down→home recovery.
- **N4 Activity commit gating.** The Activity page's "Commit now" reuses
  `forceCommitEnabled({writesEnabled, transport, scopeMismatch})` like the commit
  pill, so a session observed under another scope shows the action disabled
  instead of relying on the host refusal.
- **N5 endpoint in the mismatch tuple.** The session-scope record now stores the
  observed endpoint (0600 file, no bodies/keys; pre-fix files without it are
  tolerated as unknown), so a legacy-mode (no profile) endpoint change is
  detected as a mismatch — the previous `scopeKey` comparison covered it, the
  S5 tuple did not. E2E: record on server A, switch the legacy endpoint to B,
  mismatch true; unit: endpoint persist + old-file tolerance.
- **N6 host switch mutex made real.** The identity-switch route now holds the
  switching mutex for the whole async handler (resolution + payload composition),
  so a concurrent switch is refused with `scope-switch-blocked` /
  "already in flight", and the claim is released in a `finally`. E2E race test
  (slow `/scopes` probe window) plus unit tests for the mutex primitives.
- **N7 small drift fixed.** Profile CRUD wording corrected (it returns the
  profile list; only the identity route returns a scope payload); the
  `scopeStateCorrupt` warning clears once a deliberate save/switch repairs the
  file; the scope banner keeps its menu button (and an openable menu) in the
  failed-`/scope` state; the dead identity ternary in `resetSessionScopes` is
  removed; and a `/scopes` probe timeout now reports as `probe-timeout`
  ("state unknown") instead of `unreachable`.
- **Also:** the blocked-switch message names the real reason (pending write vs
  switch in flight vs cooldown) instead of always saying a write is pending; the
  host behaviour is unchanged for v0.7/v0.8 surfaces.

### v0.8 — Operate: controlled actions on the native cockpit (PR #6)

The first release that can *change* OpenViking state from DSH — behind one new
`enableOps` switch (default **false**) and the same prepare → confirm → execute →
verify → audit → undo protocol v0.5 established for curation writes. The native
cockpit gains an additive **Operate** group (Snapshots / Compile / Packs / Tasks)
and the Stats view gains an **Observability** segment; no new sidebar/main seat,
no new dependency, no AGPL code. One shared `OpsService` and the extracted
`confirmation-store` (token/TTL/quota + the single mutation gate shared with
`WriteService`) mean curated writes and operational actions can never overlap.

#### Fixed (PR #6 review round 1)

- Restore/commit scope checks are no longer fail-open for an **ancestor of the
  pipeline-owned sessions tree** (`viking://user/<me>` is refused; the sessions
  directory, its descendants and its ancestors all are).
- The restore dialog shows the **real dry-run write/delete counts** even when the
  path rows are display-capped, and the "truncated" line states `shown of total`.
- Pack export has a real **body deadline** (30 s of inactivity, overall export
  deadline): a stalled download no longer holds the shared mutation gate, and the
  partial temp file is deleted. Pack export now requires the **active user**
  (bare `viking://user`/other identities refused) and both READMEs state that a
  pack contains the full session text.
- Every gate (including the action capability/role probe) is re-checked at
  execute; snapshot read-back verification has a bounded retry and passes the
  branch; undo compares **normalized full URIs** instead of basenames and re-runs
  the dry run immediately before applying; a partial writeback now writes a real
  audit row (non-empty `auditId`), and the typed-confirmation button stays
  disabled until the word matches.
- Smaller hardening: undo remains available when `enableOps` is switched off
  after an action, the task-evidence server-log fan-out has an overall deadline,
  the commit-message cap lives in `limits.ts`, read-route `paths` filters are
  capped, transport-error pack probes are no longer cached, download tokens are
  identity-checked on consume, and leftover `downloads/` files are swept at
  startup plus on history reads/client aborts.

#### Fixed (PR #6 review round 2)

- Restore/commit scope classification compares the **canonical** `viking://` form
  in every safety check and returns it downstream, so `viking://user//alice`,
  `viking:///user/alice` and `viking://user///alice` are refused for the
  sessions-ancestor rule and a valid scope comes back canonicalised
  (`viking://user/alice//memories` → `viking://user/alice/memories`).
- Restore/undo plan truncation is now a **per-array** decision, so 40 writes +
  40 deletes is "80 of 80" (not truncated) instead of a contradictory
  "first 80 of 80".
- Snapshot-log verification retries only a successful-but-stale read; a failed
  request returns false immediately, so a read timeout can no longer hold the
  shared mutation gate for up to 24 s.
- One undo dry run now both builds the plan and is the read immediately before
  Apply (one round trip instead of two).
- Pack probe uses the 5 s status budget (not the 120 s stream default); the
  startup sweep is pid-aware so a second plugin instance sharing `DSH_HOME/state`
  never deletes another instance's live/mid-write download; a rejected body read
  rejects the outer promise cleanly.
- Residual cleanups: removed the dead duplicate error branch, the unused import,
  the unconsumed message-cap re-export, and the `void startedAt` workaround;
  pack export copy now states the active-user rule correctly (EN+ZH).

#### Added

- **Snapshots.** Read: bounded commit history, file-at-commit preview (text only),
  one-file diff, changed-path list and per-file versions on 0.5.3+, ignore file.
  Actions: create a snapshot (message + explicit paths, append-only, not undoable)
  and restore a **directory** with a dry-run plan, typed confirmation,
  extra-changes handling, a reindex-task follow-up and an undo that is itself a
  forward restore to the pre-restore parent. Partial writeback is reported
  honestly (`failed-partial`, no automatic retry).
- **Compile.** Read: runtime capability (`configured/can_create/reason`), 0.5.3
  target registry/config, operations/detail/outputs, submissions, per-file
  versions. Action: a confirmed trigger from a configured target or explicit
  manual `to`/`from`/`skill`/`instruction` (excluding `skill:"memory"` and
  arbitrary `args`) with a host-generated non-secret Idempotency-Key and a
  submission-check recovery on timeout; cooperative cancel; "re-run as new
  compile"; compile-output file-version restore (0.5.3, CAS, typed, undoable).
- **OVPack export only.** 64 MiB bounded host temp file (0600 under the plugin
  state dir), one-time-token GET download, metadata-only audit, `include_vectors`
  default off. Backup/import/restore are **deliberately deferred** with their
  reasons visible in the Packs tab and the README N/A matrix.
- **Task centre.** Global Tasks view (all types), events, cooperative cancel,
  `GET /task/evidence` (≤512 KiB attachment with build/identity, ≤20 local audit
  rows and ≤20 on-demand server request-log rows written as correlation), and
  explicit "no task-retry API" honesty — no Retry button anywhere; compile tasks
  offer "re-run as a new compile".
- **Observability.** Read-only on-demand route + Stats segment composing the
  observer cards and the console token/context-commit series, cached 30 s,
  per-card degradation; `/metrics` is never requested.
- **Safety.** One `enableOps` switch; every endpoint runtime capability-probed
  (never a version comparison); identity-bound single-use tokens (120 s, 8
  pending, 2 successful ops/6 prepares per minute); all mutations audited with
  task/operation/idempotency correlation (no bodies, secrets or tokens); typed
  confirmation for restores; EN+ZH parity; limits centralized in
  `src/shared/limits.ts`; fake-server/fake-transport tests only (no real store
  was written).

### v0.7 — Native I: no iframe for reading (PR #5)

The first native read cockpit. The OpenViking sidebar row now opens an internal
multi-view page — **Overview / Browse / Sessions / Commits / Stats** — with the
v0.6 Studio iframe as an explicit fallback view. Core reading tasks work without
the iframe; the server keeps owning capture, commits and the transcript. Still
read-only, still one sidebar row, no new dependencies.

#### Added

- **Native cockpit shell.** The existing `main["openviking"]` page renders the
  native views by default (`showNativeViews`, default true) with an in-memory
  bounded Back/Forward history; off renders the v0.6 Studio page exactly.
- **Overview (composed).** One `GET /overview` request returns config, identity
  scope, health/version, memory totals, capability chips, the Studio
  frameability verdict and the onboarding checklist; each part degrades
  independently, cached 5 s. Quick actions switch views or open the existing
  right-Sidebar tabs (rules/Experience stay in Explore).
- **Browse.** A lazy `viking://` tree from host-resolved identity roots
  (memories, peers, shared/personal resources, personal/agent skills, rules and
  session shortcuts), one paged `fs/ls` request per expanded directory (50 rows,
  160-char abstracts, tags, server cursor), per-page cache (15 s, LRU 100),
  in-flight reads aborted on refresh/unmount/view change, and the personal tree
  pinned to the active identity (another user's `viking://user/<u>/…` is refused;
  shared resources/agent skills stay account-level). The read-only preview pane is the extracted
  v0.4 `PreviewBody`, so L0/L1/L2 paging has one implementation and the native
  pane cannot reach a write path. An explicit "Show subtree" action is the only
  `fs/tree` caller and is capped at 2 levels / 100 nodes.
- **Sessions.** Paginated session-directory listing (50/page, mtime-desc; the
  server's `/sessions` list has no pagination) with kind/id-substring filters
  over loaded pages, and a read-only detail reusing the bounded session log
  (state, pending tokens, tasks, archive timeline, per-archive diff via the
  existing `DiffView`). No transcript/`messages.jsonl` reading.
- **Commits.** Bounded recent-activity browser: newest 8 sessions, pool 4, 10 s
  deadline, 30 s cache, per-row errors and first-class `partial` /
  `limitedBy` / `progress` (v0.6 rule-list pattern). No global-history claim; the
  UI states the cost and never polls.
- **Stats.** The v0.5 `MetricsPayload` rendered through the metric cards
  **extracted** from the Activity tab (one implementation in
  `metrics-view.tsx`), plus category/hotness detail; Prometheus is never probed.
- **Onboarding checklist (F14 start).** A read-only card in Overview and a second
  `plugins.detail.section` Setup card on the plugin's Plugins page: endpoint,
  health, identity, memory plugin, capabilities/Studio and the suggested first
  step. "Run full check" reuses the Doctor and records counts; dismissal and
  completed steps persist in a new 0600 `onboarding.json`, written through the
  same-origin read-only JSON guard and **never** through an OpenViking call. The
  file holds only ids/timestamps/counts; `lastOpenedAt` is written only while
  `showOnboarding` is on, every local action is recorded in the local audit
  trail, and a `forget` action deletes the file completely. New switch
  `showOnboarding` (default true).
- **Studio fallback.** A host-side frameability probe (`GET /studio-status`)
  classifies `X-Frame-Options` (DENY/SAMEORIGIN), CSP `frame-ancestors`
  (`'none'`/`'self'`/wildcard/explicit list), 401/403, other HTTP errors and
  timeouts, cached 60 s. It uses `redirect: 'manual'` (never fetches a redirect
  target) and refuses non-probeable endpoints without a fetch; a probe that
  cannot complete is reported as `probe-failed` instead of leaving a blank
  iframe. The Studio view explains every non-frameable verdict and keeps
  open-in-a-new-tab one click away. No unreliable browser-side iframe
  auto-detection.
- **Deep links.** Explicit "Open in cockpit" actions (Preview tab and the
  native links) use `ctx.layout.selectPanel('openviking')`, capability-detected
  structurally, with an in-memory target store; incidental `viking://` clicks
  keep opening the Preview tab. Older DSH generations without the layout action
  fall back to the Preview tab (the panel says so).
- **Routes/services.** New host modules `browse-service`, `sessions-service`,
  `commits-service`, `overview-service`, `studio-status`, `onboarding`; new
  routes `/overview`, `/browse/roots`, `/browse`, `/browse/subtree`, `/sessions`,
  `/recent-commits`, `/studio-status`, `POST /onboarding/state`; new
  `OpenVikingApi.listDirectoryPage`/`fsTree`; new `src/shared/viking-tree.ts`
  (classification + URI allowlist shared by both halves) and new protocol types.
- **Tests and docs.** Host route tests against a fake server (pagination,
  caching, allowlist, Studio header matrix, partial fan-out, 0600 state file,
  zero OpenViking calls from the state POST, read-only invariant), component
  render tests for the cockpit/onboarding/preview extraction, EN+ZH parity, new
  limits in both README contract tables, smoke additions and a
  `VERIFICATION.md` scenario checklist.

#### Fixed (review round 1, PR #5)

- Native Browse/Sessions render non-empty host `warnings` as a collapsed,
  translated row (`staleDirectory`, unsupported); an unsupported/405 subtree
  answer is split from "the directory is empty" instead of reading as one.
- Browse's URI allowlist is identity-aware (active user only for the personal
  tree); the Studio probe gained `redirect:'manual'` + the non-probeable-endpoint
  gate; failed probes surface as `probe-failed`; denied-Studio rendering is
  covered by a render test.
- Onboarding: no `lastOpenedAt` write while `showOnboarding` is off; new audited
  `forget` action deletes `onboarding.json`; the Setup card exposes it.
- Removed the dead `OverviewPluginFact.peer/peerSource` (the cockpit is
  root-scoped) and the documented-but-unused `SESSION_DETAIL_CACHE_TTL_MS`;
  corrected the README trust-invariant wording for the local-state POST.
- In-flight browse/session requests are now actually aborted on
  refresh/unmount/view change (the claim now matches the code).
- Browse directory counts render `N+ entries (more available)` when the loaded
  page reports `hasMore`, so the number is not mistaken for a total.
- The sessions list cache TTL now has the documented
  `SESSION_LIST_CACHE_TTL_MS` constant (15 s) in `limits.ts` and both README
  limit tables, and the route clamps reuse the exported budget constants instead
  of duplicating their values.
- An unresolved identity now emits only the account-level browse roots instead
  of malformed `viking://user//…` roots that the identity allow-list would then
  refuse, and `subtree()` applies the same identity filter to returned entries
  as the directory listing (the "listing, subtree and returned-entry filtering"
  claim now holds for both).

#### Changed

- The Activity tab's four metric cards now come from the shared
  `metrics-view.tsx` (identical markup, one source of truth).
- The v0.4 preview tab was rebuilt on the extracted `PreviewBody`; its address
  bar, curation action bar and delete tombstone are unchanged, and its chrome
  gains an "Open in cockpit" action where the shell supports it.
- The READMEs document the native views, the new routes/budgets, the 0600
  onboarding file and the older-DSH/Studio fallbacks; the limits contract table
  gains the v0.7 constants.

### v0.6 — Trust and verify (PR #4)

Trust and verify. v0.6 is a trust/verification release: it removes the last
mirrored upstream expression from the MIT build, makes the package's install,
host contract and privacy claims checkable, and adds explicit cost governance for
the server work read actions can trigger. **No new UX surfaces**: the only UI
changes are cost/privacy wording, a "Show more" on large previews and a partial
rules-list notice.

#### Added

- **Independent recall contract (licence).** `src/host/recall-contract.ts` re-expresses
  the coding-purpose quota apportionment, the context-face request body and the
  request-deadline derivation from the documented wire contract, replacing the
  upstream-mirrored implementation. `PROVENANCE.md` records every upstream-coupled
  behaviour and its source of truth, `THIRD_PARTY_NOTICES` carries the bundled MIT
  attributions, and `scripts/check-independence.mjs` (part of `pnpm test` and CI)
  fails on provenance wording, upstream imports or real-server captures.
- **Verifiable installs.** `scripts/verify-install.mjs` and `pnpm run verify:install`
  pack the tarball, install it into a scratch `DSH_HOME` web profile, boot it,
  assert the shell composes and serves this plugin's client half, check the plugin
  host route answers without a secret, reinstall (one row, same version) and
  uninstall (row, route and bundle gone). A CI `install-verify` job runs it on
  every PR (pinned DSH 0.2.2-rc.1; the upgrade leg runs on tags); `VERIFICATION.md`
  is the tracked, dated evidence record and `RELEASING.md` makes a row mandatory
  before tagging.
- **Host contract and compatibility matrix in both READMEs.** Supported DSH/Node/OS/
  OpenViking ranges (including the 0.2.2-rc.1 write floor), correct web-CLI vs
  Desktop install/upgrade/uninstall commands, the process model and inputs/outputs,
  a timeouts/limits table kept in sync with `src/shared/limits.ts` by a test, a
  capability/degradation table, the explicit "owned by the official plugin" N/A
  matrix, privacy/loopback boundary, Studio fallback and known gaps.
- **Privacy and request identity.** The smoke harness is redacted by default
  (`SMOKE_VERBOSE=1` for raw local detail); the legacy `apiKey` config field is
  declared `role('secret')` with credential guidance; every outbound request sends
  a version-only `User-Agent` (`dsh-openviking-enhance/<v> dsh/<v> node/<v> platform/<os>`);
  the Doctor reports its build block and keeps per-probe `x-request-id`s in
  diagnostics only.
- **Configuration-source health in the Doctor.** `ovcli.conf`, `ovcli.conf.local`,
  `profiles.json`, the pending queue and the memo directory are reported as
  ok/missing/malformed/unreadable/wrong-shape (values only), so a corrupt config
  file no longer looks like a fresh machine.

#### Changed

- **Rules listing budget (review S1).** One listing has a 15 s total deadline,
  concurrency 4, a 100-rule/20-scenario cap, and returns `partial`/`limitedBy`/`progress`
  with the rows already read plus a `ruleListTruncated` notice instead of hanging
  for minutes. Hitting a cap is reported instead of silently truncating.
- **Rule-search cost policy (review S2).** Opening the Rules list no longer runs a
  rule search; the capability gate is a validation-only `POST rules/search {}` with
  a 10-minute cache. Explore search defaults to memories/resources/skills, and the
  rules bucket is an explicit **"include rules (server cost)"** opt-in; the Rule
  tester states that Run costs a server-side rule search. Both READMEs and this
  changelog now say that read-only is not the same as free.
- The `engines.dsh` / peer range is now upper-bounded per DSH pre-release line
  (both fields use the same string), so plain semver accepts 0.2.1-rc.3 and the
  0.2.2-rc.1 write floor while a future 1.x is still refused:
  `>=0.2.0-rc.2 <1.0.0-0 || >=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`.
- Explore `RulesSection` aborts its request on unmount (no setState after unmount);
  the `viking://` preview loads L2 as bounded line pages (`offset`/`limit`) with a
  "Show more" control instead of downloading the whole file.

#### Fixed

- Stale "verified against 0.4.22" and mirrored-request comments replaced with the
  tested range and the actual contract; timeouts/limits centralized in
  `src/shared/limits.ts` with a README parity test.
- **Install verification compares real versions.** `verify-install` now reads
  `package/package.json` out of the packed `.tgz` and asserts the installed
  package equals that version (review blocker B1); the reinstall leg compares to
  the same value, the JSON summary records `tarballVersion`/`installedVersion`,
  and the freshly installed profile must refuse a non-loopback `Host` header.
- **The independent-contract argument is auditable from the repo.** The cited
  context-face field table, quota semantics and stage budgets are tracked in
  `CONTRACT.md` (source/date included) and linked from `PROVENANCE.md` and the
  contract module; PROVENANCE states the claim is *consistency with the
  documented contract*, not runtime equality with the official plugin. The
  independence gate exports its marker matcher and has negative-control tests
  (review S6/S8/S9).
- **Privacy sweep covers free text.** Smoke output redacts home paths, inline
  `viking://` URIs and session ids inside error/message/reason strings, and
  account/user URI segments are hidden (review S3/S4).
- **Doctor honesty.** An unprobed (transport-failed/cancelled) rules capability
  is reported as `unknown`, the server version is classified against the tested
  `0.5.1.1–0.5.3` range with a warning outside it, rule-listing warnings are
  emitted in input order, and a worker throw becomes a per-item warning instead
  of failing the section (review S2/S7 + small hardening).

#### Verified

- `pnpm test`: typecheck, build, packaging contract, independence gate,
  **347** unit tests, client smoke and host smoke (live read-only path redacted)
  all green.
- `pnpm run verify:install`: 27/27 clean-profile steps (install → one config row
  → boot → composed client bundle → host route → reinstall → uninstall), also
  running as a CI `install-verify` job pinned to DSH 0.2.2-rc.1 on Linux.
- Independence gate has a demonstrated negative control (fails on a re-introduced
  "copied from" marker); the frozen rule fixtures are generated from the server's
  own PyYAML and the committed corpus contains only invented content.
- Browser evidence (mock fixture, invented data): v0.5 branch-head baseline vs
  this branch in the same scratch DSH 0.2.2-rc.1 web profile, light 1440×900 @2x;
  the four small UI deltas (rules-cost opt-in, preview paging, partial rules
  notice, Doctor config-source health) captured before/after with 0 unexpected
  console/page errors; frozen fixture responses for pre-v0.6 surfaces are
  byte-identical.

### v0.5 — Collaborate (PR #3)

Collaborate. v0.5 adds the first write-capable layer on top of the read-only
cockpit: opt-in curation with typed confirmations and snapshot undo, forced
commits, a fifth Activity tab, named identity profiles with a persistent scope
banner, and `/viking` write commands confirmed in the transcript. Nothing
writes unless `enableWrites` is turned on, and every write path is
confirmed, verified after the write, snapshot-undoable where the server can undo
it, and audited locally.

### Added

- **Opt-in memory curation (F9).** With `enableWrites` on, a curatable preview
  gains an action bar for **Edit**, **Tags** and **Delete**. Allowed targets are
  memory bodies under `viking://user/<u>/memories/{entities,events,preferences}/…`
  (plus visible peer equivalents); sidecars, rules, session archives, resources,
  skills and the root profile/identity/soul files are excluded. Edits show the
  current revision (hash/size/mtime) and an optional diff, take a pre-write
  snapshot, write, verify the read-back and take a post-write snapshot — the
  conflict detection OpenViking 0.5.3 needs because content writes have no
  compare-and-swap. Deletes require typing the file name. Tags replace, append
  or clear. Every snapshot-backed action snapshots and restores the containing
  directory (one scope; file-level restore is unverified on the tested builds).
  Undo runs a snapshot restore dry run filtered to the action's paths and asks
  for a second confirmation when unrelated changes are in the plan **or when the
  target was rewritten after the action**; it fails closed without the pre-write
  snapshot and after an identity switch.
- **Forced commit and honest capture/failure diagnosis (F10).** *Commit now*
  (composer pill, Activity tab, `/viking commit`) reads the session first, is
  single-flight, always confirmed, runs asynchronously and is followable in
  Activity. The capture state from the official memory plugin is displayed;
  pausing/resuming capture is explicitly not shipped (no runtime API upstream —
  `runtime.setCaptureEnabled(session, boolean)` would be needed). Failed
  extractions show the server error, archive URI and an exportable task, with no
  retry button because the tested server builds (0.5.1.1–0.5.3) have no retry
  endpoint.
- **An Activity tab (F11).** A fifth right-sidebar tab: background tasks with
  type/status filters and cursor paging, a detail view with execution events,
  cooperative cancel (no rollback of completed writes), JSON export of safe
  fields, four independently degradable metric cards (dashboard summary, write
  queue, memory stats, session stats) and the recent audited actions. `/metrics`
  is never probed; ACL is shown only as an explicit "not enabled" state.
- **Identity profiles and a persistent scope banner (F12).** Named profiles
  (label, endpoint, auth mode, API key, account, user, peer) live in a
  plugin-owned 0600 `profiles.json` under
  `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/`; the API key is write-only
  and never logged. An active profile wins over the legacy fields/env/`ovcli.conf`
  (which keep working with no profile active). The scope chip shows endpoint,
  auth mode, account, user, peer and an identity fingerprint, and warns for
  remote endpoints; identity headers are only sent in dev/trusted mode (in
  `api_key` mode the key determines the identity). Writes are refused when the
  identity is ambiguous, undo is bound to the writing identity, and switching is
  guarded while a confirmation is pending (the UI blocks it; a racing settings
  save fails closed with `identity-changed`).
- **`/viking` write commands.** `forget`, `tag` and `commit` prepare an action
  and return either a rich `conversation.chat.commandview` card with
  Confirm/Cancel (typed delete, tag chips, commit warning) or, on clients without
  it, a two-line plain fallback naming `--confirm <token>`; the token's action is
  checked host-side **before** any write. `edit` only opens the preview editor
  (its dialog prepares and confirms), `undo <handle>` runs the dry-run plan and
  then applies it immediately (an extra-changes plan still needs the dialog),
  and `audit` is a pure read. Dialog deletions require typing the file name; the
  command path uses the single-use token as its confirmation. Tokens are
  single-use, 120 s, bound to identity/action/target, with 8 pending and 3
  **writes**/minute (only successful executions count), one write in flight; a
  dialog that is dismissed releases its pending token, and denied attempts are
  audited.
- **Four new settings**: `enableWrites` (`false`), `enableActivity` (`true`),
  `showScopeBanner` (`true`), `activeProfile` (`''`), wired end-to-end with
  English and Chinese copy.
- **Local state and audit**, both 0600 under
  `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/`: `profiles.json` and a
  rotating `audit.jsonl` (1 MiB, two old files) carrying time, action, URIs,
  identity fingerprint, request id, result and undo handle — never memory
  bodies, tokens or secrets.
- **Tests**: host unit tests and end-to-end route tests (fake
  `connection.fetch` + fake OpenViking server: edit→verify→post-commit→audit→
  undo, typed delete, tags undo, force commit, task cancel, profile
  save/delete/test, write cancel, 0600 audit, no body leakage, fail-closed
  paths, crossed-token refusal, undo staleness and concurrency), plus client
  render/smoke coverage for the new surfaces; 257 unit tests in total.

### Changed

- **Mutations only on the framework-authenticated transport.** Writes ride
  `ctx.connection.fetch`; the plugin exposes no raw loopback POST write route.
  Where that service is absent (DSH older than 0.2.2-rc.1) writes are disabled
  with an explicit reason while every read surface keeps working.
- Identity headers follow the server's auth mode: only `dev`/`trusted` requests
  carry account/user headers; `api_key` requests do not (the key determines the
  identity), matching the official plugin.
- The manifest/README support wording now distinguishes reads (DSH 0.2.0-rc.2+)
  from writes (DSH 0.2.2-rc.1+).

### Verified

- `pnpm test`: typecheck, build, packaging contract, **257** unit tests, client
  smoke and host smoke all green; the host smoke exercises the read-only live
  server paths plus every fail-closed write path.
- Unit and end-to-end tests never touch a real memory store: the write paths run
  against a fake OpenViking HTTP server and a fake `connection.fetch`.
- The browser evidence is in the PR: released v0.4 baseline (branch head at
  capture time) vs this branch, same scratch DSH 0.2.2-rc.1 web profile, light
  theme 1440×900 @2x, against the stateful stand-in server; invented data only.

### v0.4 — Act I (PR #2)

Act I. v0.4 makes the read-only cockpit *operable*: a URI preview with deep
links, a read-only `/viking` command, and one Explore page for unified search,
rules, skills and Experience. Nothing in this version writes to OpenViking.

### Added

- **A `viking://` preview tab in the right sidebar.** Every URI the plugin
  already shows is a link now — recall-tab rows and their loaded details, the
  recall-explanation entries, the commit diff's archive and change rows, and the
  new Explore rows — and one click opens (or re-targets) the preview page. It
  shows the entry's metadata from `fs/stat` + `fs/attrs` (name, file/directory,
  context and memory type, category, size, modified time, lock, tags) and the
  server's three read tiers: L0 abstract, L1 overview and L2 full text, with
  per-tier availability, "not generated yet" placeholder detection, truncation
  markers, copy-URI and "open in Studio". L0/L1 are labelled as the directory
  sidecars they are; L2 is files-only and says so on a directory; only text is
  rendered, so a memory body never becomes markup. The address bar accepts a
  pasted `viking://` path, and the page takes its target through the framework's
  own tab-navigation parameters (with a store fallback for the older DSH
  generations the manifest still supports).
- **A read-only `/viking` command.** `status` (endpoint, health, server version,
  identity, the mounted memory plugin, the DSH version, and the current
  session's commit state), `doctor` (the Doctor's checks as text), `recall
  <query>` (the same per-session retrieval the recall tab uses, as scored hits),
  `open <uri>` (metadata plus bounded L0/L1, pointing at the preview tab for the
  full view) and `help`. Registration waits for the command service, so a
  composition without it still mounts every surface; the new `enableCommands`
  switch unregisters the command (live where the Loader emits
  `loader/volatile-update`). Command output is deliberately short English plain
  text — the host half has no locale service and the GUI renders result text
  without Markdown.
- **An Explore tab** with four read-only segments. **Search** covers memories,
  resources and skills in one list-mode request, merges a rules bucket from the
  rule-search endpoint, and groups hits by bucket with score, URI, abstract and
  rule facts; each row opens the preview. **Rules** lists the rules the server
  exposes (from the lazy `viking://~/memories/rules` tree, since the server has
  no rule-list API) with status/name/scenario, and a read-only tester runs
  `rules/search` against a task description and shows the matched rules'
  requirement, `applies_when`, exception, probability and body — parsed from the
  Rule Markdown frontmatter the server returns. **Skills** lists the installed
  catalogue. **Experience** discovers Experience files and shows their
  trajectories and outcome distribution. Every segment gets an explicit empty,
  unavailable or unsupported state: rules need OpenViking 0.5.3+ and are
  capability-probed, and Experience is normally empty rather than broken.
- **Six read-only host routes** for the browser half: `GET /preview`,
  `POST /search`, `POST /rules/search`, `GET /rules`, `GET /skills` and
  `GET /experience`. The first three are the only POSTs the plugin has ever
  exposed and they are read-only queries; the trust fence now admits a POST only
  as same-origin loopback JSON with a 64 KiB body cap (checked against the
  streamed bytes, not just the declared length), while every GET route still
  answers 405 to a POST.
- **Three new settings switches**: `showPreview` and `showExplore` (both default
  `true`, applied live like the five existing switches) and `enableCommands`
  (default `true`, read by the host half).
- **`ROADMAP.md`**, the version-by-version plan (v0.4 → v1.0) this change starts,
  with the invariants every version keeps.
- New unit coverage for the preview/search/catalog/command services, the
  read-only POST fence, the rule-frontmatter parser, the new switches and the
  new copy, and expanded browser-smoke checks for the new seats and the
  `enableCommands` switch.

### Changed

- `GET /api/v1/content/abstract` and `/overview` are used as OpenViking defines
  them: L0/L1 are directory sidecars, so a file's tiers describe the directory
  it lives in, and a missing sidecar is a 200 placeholder rather than content —
  both are surfaced as states, not errors.
- Unified search is semantic-only. The live OpenViking 0.5.3 backend rejects
  `search_type: "keywords"` with `INVALID_ARGUMENT`, so the Explore search has no
  toggle and the host degrades a keyword request to semantic with one notice.
- The manifest, package and both README version lines stay at **0.3.0**; the
  release notes above stay under `Unreleased` until `pnpm run release 0.4.0`.

### Verified

- `pnpm test` (typecheck, build, packaging contract, **165** unit tests, client
  smoke, host smoke) passes.
- Host smoke against a live OpenViking **0.5.3**: preview (file, placeholder L0,
  155-char L1, 395-char L2), unified search (3 memory hits), empty rules list,
  complete rule-tester delivery, 1 skill, 0 Experiences, plus the POST-fence
  cases (same-origin JSON 200, cross-origin 403, cross-site fetch marker 403,
  non-JSON 415, oversized 413) and every v0.3 route unchanged.
- The offline path (no server) answers every route with `{ok:false}` JSON and
  keeps the fence assertions.
- The browser check and the before/after captures live in the PR; both were
  taken in the same scratch DSH 0.2.2-rc.1 web profile against the stand-in
  server in `scripts/screenshot-fixture.mjs` (now covering the v0.4 endpoints)
  and a mock model, at 1440x900 @2x in the light theme, with invented content
  only. The live "0 Experiences" check proves an empty state on 0.5.3; the
  experience path itself is asserted from the server source and fixture, not
  from a non-empty live store.


## 0.3.0 — 2026-11-09

Explain. v0.3 turns the dashboard from "what is the memory state" into "why is
the memory in this state", and every new surface is read-only.

### Added

- **A recall explanation under every completed turn.** The conversation gains a
  `Memory sources` trigger whose card replays the turn's prompt against the
  server's context face (`POST /api/v1/search/search` with `mode: "context"`).
  It shows the query, every hit with score/category/URI/read tier/provenance,
  the server's token budget (used/max), quotas, tier counts, exclusion and
  cross-turn de-duplication accounting, provenance, the retrieval plan, the
  assembled injection block, and latency. The card says it is a replay: DSH does
  not retain the memory plugin's injected block, so a historical "exactly what
  was injected" claim would be a lie. Servers without the context face fall back
  to the existing per-target search and say so.
- **A commit diff browser in the commit pill.** Each commit can be filtered by
  added/updated/deleted, every change expands to its before/after text with a
  line diff, deletes show their deleted content, and one click copies a URI or
  exports the commit as JSON. Failed commits show the server error, time and the
  task id when the record has not been pruned yet, with a copy-error control.
- **A Memory health tab in the right sidebar.** It distinguishes the five states
  that matter — nothing captured, captured but not committed, extracting after
  a commit, extraction failed, writes queued locally — plus the normal committed
  state, with message/pending/commit counts, threshold, last commit and last
  auto-commit times, recent tasks, recent commits and a timestamped activity
  timeline. It also reads the official plugin's local pending queue (counts,
  types and times only, never payloads) and labels that state as cross-plugin.
- **A Doctor.** Endpoint, health, version, identity, the mounted memory plugin's
  version and effective recall/capture/commit settings, per-field connection
  sources (profile override, environment, `ovcli.conf`/`.local`, default), and
  live probes for the context face, rule search, skills, `fs/stat` and retrieval
  metrics. It also lists the model-visible `mcp__openviking__*` tools, so "why is
  there no tool?" has an answer: plugin not mounted, tools not exposed, or the
  registry unreachable. Every check names the likely fix, the DSH version is checked against
  the manifest range, and the diagnostic JSON and `curl /health` command are one
  click away. API keys are never included in any report or copied diagnostic.
- **A compact health summary on the plugin's own Plugins page**, so "is it
  working?" has an answer before opening a session.
- **Two more interface switches:** `showRecallExplain` and `showHealthPanel`,
  both default `true`, applied live like the existing three.
- `test/v03-units.test.mjs` pins the context/fallback wire shapes, the request
  mirroring, the five session states, connection sources, the pending-queue
  reader and the text diff. The host smoke harness now exercises
  `/recall/explain`, `/session-log` and `/doctor` against a live server.

### Changed

- **DSH 0.2.2 support, on top of the existing 0.2.0/0.2.1 generations.**
  Development is type-checked and built against `@deepseek-ai/dsh-*@0.2.2-rc.1`
  (including the Chat package that owns `conversation.chat.turnTail`). The old
  generations still carry the seats this release uses: the plugin was mounted and
  exercised in running 0.2.0-rc.2 and 0.2.1-rc.5 web shells, and the manifest's
  range is unchanged apart from adding 0.2.2-rc.1.
- **The recall replay follows the official request more closely.** Its HTTP
  deadline is derived from the memory plugin's expansion/rewrite fuses (15 s /
  45 s, or `recallContextTimeoutMs`), and the request now mirrors
  `recallEventsDecayProtection` and `rewrite=auto`; the card also shows the
  plugin's effective recall settings. The Doctor's context probe is session-free
  and sends `query_expansion: "off"`, so opening the health page cannot trigger
  an expansion LLM call or touch a session's de-duplication bookkeeping.
- **The commit popover is wider and the timeline links into the full diff**;
  the old paths-only list is gone.
- The sidebar tab closing path now handles the recall and health pages
  independently and no longer arms a deferred close when the right column is
  mounted with no tab of ours on screen.

### Verified

- DSH 0.2.2-rc.1, plus the plugin mounted and exercised in running 0.2.0-rc.2 and
  0.2.1-rc.5 web shells (the Memory sources tail, commit pill and Memory health
  tab all render, with no page or console errors). OpenViking 0.5.3 (`/health`,
  context face, rules, skills, observer) and the 0.5.1.1–0.5.3 fallback paths.
  The live host smoke reports the context face available and the Doctor's probes
  available.
- The pending queue was empty on the verification machine; the reader is covered
  by a temp-directory unit test instead.

### 新增

- **每条已完成回复下方的召回解释。** 对话里新增「记忆来源」入口，展开后会用该轮提问
  重放服务端的上下文接口（`POST /api/v1/search/search`，`mode: "context"`），显示
  命中条目的分数、类别、URI、读取层级与来源，以及 token 预算（已用/上限）、配额、
  层级统计、排除与跨轮去重、检索计划、服务端组装的注入块和耗时。卡片明确说明这是
  "重放"：DSH 不保留记忆插件注入的原始文本，因此不会假装展示历史注入。没有上下文
  接口的旧服务端退回逐目标检索，并注明原因。
- **提交胶囊里的 diff 浏览器。** 可按新增/更新/删除筛选，每个变更展开后显示前后文本
  与行级 diff，删除项显示被删内容；可复制 URI 或把本次提交导出为 JSON。失败提交显示
  服务端错误、时间和仍保留的 task id，并可复制错误。
- **右侧边栏的「记忆健康」页。** 区分五种状态——没有消息、已捕获未提交、提交后抽取中、
  抽取失败、本地队列中——以及正常已提交；显示消息数、待提交 token、阈值、提交次数、
  最近提交/自动提交时间、最近任务、归档和活动时间线。它还会读取官方插件本地 pending
  队列的数量、类型与时间（绝不读取 payload），并标注这是跨插件本地状态。
- **Doctor。** 显示地址、健康、版本、身份、已挂载记忆插件的版本与生效的召回/捕获/提交
  设置，以及每个连接字段的来源（profile 覆盖、环境变量、`ovcli.conf`/`.local`、默认）；
  并对上下文接口、规则检索、技能、`fs/stat` 与召回观测做真实探测。它还会列出模型可见的
  `mcp__openviking__*` 工具，让「为什么没有工具」有答案：插件未挂载、工具未暴露，还是
  工具注册表不可读。每项检查给出可能的
  修复方向，DSH 版本会与清单声明区间比对，诊断 JSON 与 `curl /health` 一键复制；API key
  不会出现在任何报告或导出里。
- **插件详情页的健康摘要**，不必先打开会话就能看到"是否正常"。
- **两个新的界面开关：** `showRecallExplain`、`showHealthPanel`，默认都打开，和原有
  三个开关一样保存后立即生效。

### 变更

- **支持 DSH 0.2.2，并保留原有的 0.2.0/0.2.1 世代。** 开发依赖升级到
  `@deepseek-ai/dsh-*@0.2.2-rc.1`（包括拥有 `conversation.chat.turnTail` 的 Chat 包）。
  旧世代同样带有本版本使用的槽位：插件已在实际运行的 0.2.0-rc.2 与 0.2.1-rc.5 web shell
  中挂载并验证，清单范围除新增 0.2.2-rc.1 外保持不变。
- **召回重放更贴近官方请求。** HTTP 超时按官方插件查询扩展 / 重写的熔断时间推导
  （15 秒 / 45 秒，或 `recallContextTimeoutMs`），请求也会带上
  `recallEventsDecayProtection` 与 `rewrite=auto`；卡片同时显示记忆插件的生效召回设置。
  Doctor 的上下文探测不再携带 session，并显式 `query_expansion: "off"`，打开健康页
  不会触发扩展 LLM 调用，也不会碰会话的跨轮去重状态。
- **提交弹窗加宽**，时间线直接进入完整 diff，不再只列路径。
- 右侧边栏的关闭逻辑按召回页与健康页分别处理；右栏已挂载但当前页不是本插件页面时
  不再安排无意义的延迟关闭。

### 验证

- DSH 0.2.2-rc.1，并已在实际运行的 0.2.0-rc.2 与 0.2.1-rc.5 web shell 中挂载验证
  （「记忆来源」、提交胶囊与「记忆健康」页均正常渲染，无页面或控制台错误）。
  OpenViking 0.5.3（`/health`、上下文接口、规则、技能、观测）以及 0.5.1.1–0.5.3 的
  回退路径。真实宿主 smoke 显示上下文接口与 Doctor 探测均可用。
- 验证机器上的 pending 队列为空；读取逻辑由临时目录单测覆盖。


## 0.2.3 — 2026-11-04

### Fixed

- **The commit pill no longer lets a pruned task or an old failure decide the
  current state.** OpenViking keeps `session_commit` task records for about 24
  hours (`completed`/`cancelled`) and 7 days (`failed`). Once a later success's
  task aged out, an older failed task became the newest remaining one and the
  pill flipped back to "extraction failed"; after 7 days a real failure vanished
  from the UI while its archive still recorded it. The host now reads the
  durable per-archive markers (`.done` / `.failed.json`) and derives the phase
  from the newest archive: a failure after a newer successful commit stays only
  in the popover, a partial `memory_diff.json` no longer masks a failure, and a
  cancelled commit reads as "cancelled" rather than "failed". Servers without
  markers fall back to a failed task only when no later `last_commit_at`
  supersedes it.
- **Polling no longer runs at a fixed 5 seconds.** The pill polls at 5 s only
  while a commit is being extracted, at 30 s when idle and visible, pauses in a
  hidden tab, and backs off exponentially (5→60 s) after failures. Opening the
  popover, refocusing the window or switching sessions refreshes immediately.
  Requests are aborted on session change/unmount and guarded against overlap;
  the host coalesces concurrent status reads. Idle traffic drops from 36 to
  about 6 upstream requests per minute per tab.

### 修复

- **提交状态胶囊不再被已清理的 task 或旧失败 "复活"。** OpenViking 对
  `session_commit` task 的保留是：`completed`/`cancelled` 约 24 小时、`failed` 约 7 天。
  后续成功提交的 task 先过期后，更早的失败 task 会重新变成"最新"，胶囊又翻回
  "抽取失败"；7 天后真实失败又会从界面消失，而归档里的标记还在。现在宿主读取归档目录
  的持久标记（`.done` / `.failed.json`），用**最新一个归档**的终态判定阶段：后续成功提交
  之后的旧失败只留在弹窗里，部分写出的 `memory_diff.json` 不再掩盖失败，手动取消显示为
  "已取消"而非"失败"。没有标记的旧服务端则回退到 task，但只在失败未被更晚的
  `last_commit_at` 覆盖时才生效。
- **轮询不再固定 5 秒。** 只有抽取进行中才 5 秒一次；空闲且可见时 30 秒；标签页隐藏时暂停；
  请求失败按 5→60 秒指数退避。打开弹窗、窗口重新获得焦点、切换 session 都立即刷新。
  切换/卸载会取消旧请求并防止重叠；宿主对同一 session 的并发状态读取做单飞。
  空闲时的上游请求从 36 次/分钟降到约 6 次/分钟。

## 0.2.2 — 2026-10-27

### Added

- **Three interface switches on the plugin's settings form.** `showSidebarEntry`,
  `showCommitStatus` and `showRecallPanel` (all default `true`) independently hide
  the Studio entry in the left sidebar, the per-session commit pill under the
  composer, and the Memory recall tab in the right sidebar. They are persisted by
  the same **Configure** form and applied live through `ctx.configForms` — saving
  mounts or unmounts the surface with no reload or restart. The form itself is
  never hidden: a switched-off surface can always be switched back on there.
  Hiding the sidebar entry unmounts the Studio page (it loads fresh when shown
  again); hiding the recall tab closes an open recall page once the conversation
  is back on screen (a page open in a background pane has to be closed by hand,
  because the harness exposes no tab enumeration). A deployment
  without the settings client keeps every surface visible, exactly as before the
  switches existed. The release was exercised in the running desktop GUI: the host
  Config was hot-reloaded without an app restart, each surface disappeared and
  returned on save, and switching the recall tab off closed an already-open recall
  page once the conversation came back; the test-written overrides were then
  removed, so the defaults are in force.

### 新增

- **插件设置里新增三个界面开关。** `showSidebarEntry`、`showCommitStatus`、
  `showRecallPanel`（默认都是 `true`）分别控制左侧边栏的 Studio 入口、输入框下方的
  提交状态胶囊、右侧边栏的「记忆召回」tab。开关与连接参数在同一个 **Configure** 表单里
  保存，客户端通过 `ctx.configForms` 实时生效——保存即挂载或卸载对应界面，不需要重载
  窗口或重启应用。配置表单本身永远可见，关掉的入口随时能在这里开回来。隐藏左侧入口会
  一并卸载 Studio 页面（重新打开后重新加载）；隐藏召回 tab 后不再提供该页，已打开的召回页
  会在回到对话时自动收起（若它在后台分屏里、不是激活页，则需手动关闭——框架没有提供枚举
  标签页的接口）。没有 settings 客户端的部署保持三个入口全部显示，与加开关之前完全一致。
  本版本在运行中的桌面 GUI 里实测过：宿主 Config 无需重启 App 即热重载，三个入口在保存后
  当场消失/恢复，关掉召回开关后已打开的召回页会在回到对话时自动关闭；随后清除了测试写入的
  覆盖值，默认值（全开）生效。

### Changed

- **Verified against DSH 0.2.1-rc.3.** The desktop app moved one prerelease
  forward on the 0.2.1 line. No plugin code changed: the same sources type-check
  against the 0.2.1-rc.3 type packages and the whole suite passes on rc.3 — 88
  unit/component tests, 160 client-smoke checks, 24 packaging-contract checks, the
  live OpenViking smoke (status, commits, timeline, probe, recall, diff) and the
  six-request route fence. The development dependencies now pin 0.2.1-rc.3; the
  peer range and both `engines.dsh` entries already admitted that release (same
  0.2.1 tuple), so no new range branch was needed. The running app confirms it:
  the sidebar row, Studio panel, commit pill and recall tab all mount on the rc.3
  GUI, and the host routes answer `ok: true` / `healthy: true`. The requirements
  table now names OpenViking 0.5.1.1, the server the live smoke ran against.

### 变更

- **已在 DSH 0.2.1-rc.3 上验证。** 桌面端在 0.2.1 线上又前进一个预发布版本。
  插件代码没有改动：同一份源码对 0.2.1-rc.3 类型包通过类型检查，整套测试也在
  rc.3 上全绿——88 项单测/组件测试、160 项客户端冒烟、24 项打包契约、真实
  OpenViking 在线冒烟（状态、提交、时间线、探测、召回、差异）与 6 项路由 fence。
  开发依赖现在钉到 `0.2.1-rc.3`；peer 范围与两处 `engines.dsh` 本就覆盖该版本
  （同为 0.2.1 元组），无需新增范围分支。运行中的 app 也确认：左侧栏行、
  Studio 面板、提交状态胶囊与召回 tab 都在 rc.3 界面上正常挂载，宿主路由返回
  `ok: true` / `healthy: true`。前置条件表里的 OpenViking 实测版本更新为
  0.5.1.1（本次在线冒烟所用服务端）。

## 0.2.1 — 2026-10-18

### Changed

- **Declared compatibility with DSH 0.2.1-rc.2.** The development dependencies
  now track the 0.2.1 line (`0.2.1-rc.2`, `@deepseek-ai/cordis` 4.0.5,
  `@deepseek-ai/schemastery` 3.18.5), and both the peer range and `engines.dsh`
  name that prerelease line as well as 0.2.0's. No plugin code changed: the same
  sources type-check against both versions, and the full suite — including the
  live OpenViking smoke — passes on 0.2.1-rc.2.

### 变更

- **声明支持 DSH 0.2.1-rc.2。** 开发依赖升到 0.2.1 线（`0.2.1-rc.2`、
  `@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/schemastery` 3.18.5），peer 范围与
  `engines.dsh` 同时标出 0.2.1 预发布线与 0.2.0 线。插件代码没有改动：同一份
  源码在两套类型下都通过类型检查，并在 0.2.1-rc.2 上跑完整套测试（含真实
  OpenViking 在线冒烟）。

## 0.2.0 — 2026-10-02

### Added

- **Recall detail in the right sidebar** — a per-session *记忆召回* tab showing what
  OpenViking retrieves for the session in view: the query it searched with (the
  session's own most recent user turn, or one you type), every hit in each of the
  three sources with its score (graded red through green), file name, kind and
  abstract, the server's own retrieval plan, and one entry's full text on click. It asks the same
  session-aware route the memory plugin calls, so the ranking is the server's
  rather than a second implementation of it. Reached through the right sidebar's
  guide; nothing is written.
- Two routes behind the same trust fence: `/recall` and `/recall/content` (the
  latter refuses anything that is not a `viking://` path, and truncates).

### Changed

- **The interface is bilingual.** Every string this plugin renders — the panel,
  the pill and its popover, the recall tab, the configuration form — now follows
  the language DSH is set to, with Chinese and English dictionaries and English as
  the fallback. Host-side messages became codes plus parameters, so the half that
  has no language no longer decides the wording.
- **The plugin's settings are editable in the GUI.** Its row on the **Plugins**
  page now has a **Configure** form — endpoint, key, identity, Studio path and the
  two cache lifetimes — with a *check* button that probes the address before
  saving, and a per-field reset that clears the override instead of writing an
  empty value. The same values can still be written by hand in the profile patch.
- The host half is self-contained: `@deepseek-ai/schemastery` is bundled instead
  of being imported at runtime, so the plugin no longer assumes a harness hands it
  a schema library the profile may not have.
- The package is publishable: `private` removed, `LICENSE` added, and the official
  `@deepseek-ai/*` dependency replaced by an explicit `@deepseek-ai/dsh` peer.

### 变更

- **界面中英双语**：本插件渲染的每一处文字（面板、胶囊及其弹窗、召回面板、配置表单）现在都跟随
  DSH 的语言设置，内置中英两套字典，其他语言退回英文。宿主侧消息改成"码 + 参数"，
  不再由那个没有语言概念的半部分决定措辞。
- **插件设置可以在界面里改了**：**Plugins** 页里本插件那一行多了 **Configure** 表单
  （地址、Key、身份、Studio 路径、两个缓存时长），地址旁有 **检测** 按钮可在保存前试连，
  每个字段的 **默认** 按钮是清除覆盖、恢复继承，而不是写入空值。同样的值仍可手写在 profile patch 里。
- 宿主半部分自包含：`@deepseek-ai/schemastery` 改为打进 bundle，不再假设 harness 会提供它。
- 包已可发布：移除 `private`、补 `LICENSE`、把官方 `@deepseek-ai/*` 依赖换成显式的
  `@deepseek-ai/dsh` peer。

### 新增

- **右侧边栏的记忆召回面板**：按会话显示 OpenViking 为当前会话召回了什么——检索用的那句话
  （默认本会话最近一次提问，也可自己输入）、三个来源里每条命中的分数与 `viking://` 路径及摘要、
  服务端自己的检索计划，以及点开任意一条看全文。它调用的是记忆插件本身所用的那条会话感知接口，
  所以看到的是服务端的真实排序，而不是另写一套检索。从右侧边栏的引导页进入，全程不写入。
- 新增两个走同一道信任围栏的接口：`/recall` 与 `/recall/content`（后者只接受 `viking://`
  路径，并做长度截断）。

## 0.1.0 — 2026-10-02

First release. Read-only throughout: the plugin never commits, writes or deletes
anything in OpenViking.

### Added

- **OpenViking Studio panel** — a new row at the end of the left sidebar that
  loads the OpenViking server's own Studio UI in the main area (`/studio/` by
  default), with a reload button when the frame goes stale.
- **Per-session commit pill** under the message box, matching the built-in pills
  in type and colour: `未提交`, `12.3k/20k`, `抽取中…`, `N 次提交`, `抽取失败`,
  `不可用`. It carries the sidebar's OpenViking glyph and an `OV ·` prefix so it
  cannot be mistaken for a git commit.
- **Commit timeline** in the pill's popover — the newest 3 commits with their time
  and added/updated/deleted counts; *show all* expands the rest (up to 50).
- **Per-commit memory diff** — clicking a commit lists the exact `viking://`
  paths it changed, read from that archive's own `memory_diff.json`.
- **Failed extraction reporting** — time, duration and the server's own error.
  The commit counter alone cannot show this, because the archive is written even
  when extraction fails.
- **Four loopback-only routes** (`/config`, `/status`, `/commits`, `/diff`) behind
  a trust fence: loopback socket *and* loopback `Host` *and* same-origin
  `Sec-Fetch-Site`/`Origin`. `X-Forwarded-For` is never trusted; non-GET is `405`.
- **Configuration** — `endpoint`, `apiKey`, `account`, `user`, `studioPath`,
  `cacheTtlMs`, all defaulted and readable from `~/.openviking/ovcli.conf`, so a
  standard local setup needs none.
- **Tests** — 22 unit tests against the host logic (including a stub-server wire
  test that pins the session-history URL), a client bundle smoke harness with 26
  invariants, and a host smoke harness that prints the live timeline.

### Known limitations

- The plugin's own interface text is Chinese only; it does not follow the DSH
  locale setting yet.
- OpenViking prunes its commit task records, so the failure list covers recent
  commits only. The archives themselves are permanent.
- Extraction failures undercount `memories_extracted`; the interface trusts each
  commit's own diff summary instead.

---

## 0.1.0 — 2026-10-02（中文）

首个版本。全程只读：本插件不会向 OpenViking 提交、写入或删除任何东西。

### 新增

- **OpenViking Studio 面板**：左侧边栏最后一行，主区域加载 OpenViking 服务自带的
  Studio 界面（默认 `/studio/`），并提供重新加载按钮。
- **会话 commit 状态胶囊**：输入框下方，字体字号与内置胶囊一致，显示
  `未提交` / `12.3k/20k` / `抽取中…` / `N 次提交` / `抽取失败` / `不可用`；
  使用侧边栏同款 OpenViking 图标并带 `OV ·` 前缀，不会与 git commit 混淆。
- **提交时间线**：点开胶囊可见最近 3 次提交的时间与新增/更新/删除条数，
  「显示全部」可展开至 50 条。
- **单次提交的记忆明细**：点某次提交列出它改动的具体 `viking://` 路径，
  数据来自该次归档自己的 `memory_diff.json`。
- **抽取失败可见**：显示失败时间、耗时与服务端原始错误。仅看提交次数无法发现
  这类失败——抽取失败时归档同样会写入。
- **四个仅本机可达的内部接口**（`/config`、`/status`、`/commits`、`/diff`），
  同时校验 loopback 套接字、loopback `Host` 与同源 `Sec-Fetch-Site`/`Origin`；
  不信任 `X-Forwarded-For`，非 GET 返回 `405`。
- **配置项**：`endpoint`、`apiKey`、`account`、`user`、`studioPath`、
  `cacheTtlMs`，均有默认值并可读取 `~/.openviking/ovcli.conf`，标准本地环境无需配置。
- **测试**：22 个宿主逻辑单测（含固定会话历史 URL 的桩服务端联调测试）、
  26 项客户端产物冒烟断言、以及可打印实时时间线的宿主冒烟脚本。

### 已知限制

- 插件自身界面文字目前只有中文，尚未跟随 DSH 的语言设置。
- OpenViking 会定期清理 commit 任务记录，失败列表只覆盖最近的提交；归档文件本身永久。
- 抽取失败时 `memories_extracted` 会少计，界面以每次提交自己的 diff 摘要为准。
