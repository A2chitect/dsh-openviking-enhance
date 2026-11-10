# Acceptance — v1.0 "Native — complete"

This file is the release acceptance record for the final roadmap version. It maps
the roadmap goal and exit criteria to evidence, labels every claim with a verdict,
and ends with the human sign-off block that gates the `v1.0.0` tag. **It is a
repository document, not a shipped package file** (the package ships
`DECISIONS.md`, `PROVENANCE.md`, `CONTRACT.md` and `THIRD_PARTY_NOTICES`).

Status at drafting: **prepared, awaiting human review/sign-off** (the sign-off
block at the bottom is intentionally empty). No claim below is marked `Verified`
unless the linked evidence exists in this tree.

## 1. Verdict taxonomy

| Verdict | Meaning |
| --- | --- |
| **Verified** | Automated evidence in this repository proves the claim (tests/gates); runnable by anyone. |
| **CI-verified** | Verified by the CI jobs on the PR (unit/smoke + install-verify); link recorded by the maintainer at tag time. |
| **Design-verified** | The mechanism exists and is tested, but the human-facing claim is click-count/observation-based rather than instrumented. |
| **Fixture-only** | Exercised against the deterministic fake server/fixture UI; **no live data or live write** was touched by automation. |
| **Checklist-verified (frequency-unmeasured)** | The 12 daily checks are native (each has a shipped surface + evidence), but real-usage *frequency* was never measured — no telemetry by design. |
| **Externally-unverified** | Not performed by this project. A protocol exists; results must be filled in by the maintainer if run. |
| **U / D** | Compatibility matrix labels: U = unverified (never claimed), D = documented/probed in code, not live-verified here. |
| **Not shipped / non-goal** | Deliberately out of scope, with the dependency/reason recorded. |
| **Documented limitation** | A known limit of the shipped evidence or product; stated rather than hidden. |

## 2. Hard gates (release blocked if red) and advisory evidence

Hard gates: `pnpm test` (typecheck, build, packaging contract, independence gate,
unit/contract/route/component suites, client + host smoke), `pnpm run
verify:install` (clean-profile install → boot → bundle/route → reinstall →
uninstall; CI `install-verify`), tarball contents, README/matrix parity tests,
and this file's human sign-off. **Advisory**: browser evidence set (before = v0.9
build, after = v1.0 build), manual a11y/bilingual checklists, user study.

## 3. Roadmap goal and expected outcome

ROADMAP goal: *"Explain, operate and trust OpenViking from inside DSH; core tasks
run without Studio; a person reviews and merges."*

| Expected outcome | Evidence | Verdict |
| --- | --- | --- |
| Explain, operate and trust are all available inside DSH | F1–F14 ledger (README EN+ZH) + the component/route suites behind each surface | Verified (mechanism) |
| Core tasks run without opening Studio | Studio-off walkthrough (§7) + native cockpit tests + v1.0 performance test (single composed Overview request) | Design-verified (click count) |
| A person reviews and merges the final PR | The PR itself + the sign-off block below | Pending human action |

## 4. Roadmap invariants

| Invariant | Evidence | Verdict |
| --- | --- | --- |
| Read-only by default (`enableWrites`/`enableOps` default false, gates fail closed, no unauthenticated write route) | v0.5/v0.8 write-gate and fence tests, host smoke fence cases | Verified |
| Official plugin owns the pipeline (no hooks/MCP/tools/pending-queue writes); this plugin explains/operates on top | README N/A matrix; no tool registrations; queue is read-only | Verified (code+tests) |
| Additive, switchable surfaces; old/partial servers degrade to a stated state | Feature-toggle tests, capability-gate tests, v0.7+ render suites | Verified |
| No AGPL code; independently implemented contract | `check-independence.mjs` in `pnpm test`, `PROVENANCE.md`, `CONTRACT.md`, `DECISIONS.md` D1 | Verified |
| Every version verifiable (tests, clean-profile install, compatibility matrix, evidence rows) | `VERIFICATION.md` rows + CI `install-verify`; v1.0 row records this release | CI-verified |
| Nothing private leaves the machine (no telemetry; redacted evidence; local-only) | redacted smoke default, privacy tests, `PROVENANCE.md`/README privacy boundary | Verified |

## 5. Version exit criteria (final)

| Version | Roadmap criterion | Evidence | Verdict |
| --- | --- | --- | --- |
| v0.3 | Recall/commit explained within 2 clicks; read-only | F1/F2 entry points; click-count walkthrough §7; read-only gates | Design-verified (clicks) / Verified (read-only) |
| v0.4 | 80% of daily checks inside DSH; commands work on web+desktop; read-only | 12-item checklist §8 = 12/12 native; command presence in web-profile install-verify; desktop commands labelled **M**, desktop **U** | Checklist-verified (frequency-unmeasured) |
| v0.5 | Writes only when asked, undoable; failures exportable; scope switching never mixes data | write protocol/token/undo tests, task export, v0.9 isolation tests | Verified |
| v0.6 | No AGPL-derived code; tarball verified clean; matrix documented | independence gate, `verify:install`, README final matrix, `VERIFICATION.md` | Verified |
| v0.7 | Core read tasks without the iframe; fallback documented | native cockpit tests + Studio-off walkthrough + README fallback text | Design-verified |
| v0.8 | Operational tasks possible with confirmations and exportable evidence | fake-server ops E2E, audit/evidence tests, fixture screenshots | Fixture-only (no real-store writes by design) |
| v0.9 | Multiple servers/scopes isolated and visibly labelled | fake two-server E2E, scope header refusal, banner inventory, switch walkthrough; PR #7 review blockers B1–B5 + ACL S2 fixed in the fixed base `b64d9cf` with regression tests (see §13) | Verified (guards) + Fixture-only (second scope) |
| v1.0 | Expected goals met; core tasks without Studio; human review/merge | §3–§8 + sign-off | Design-verified + CI-verified; **human merge pending** |

## 6. Original report success criteria (honest handling)

| Goal | Evidence | Status at 1.0 |
| --- | --- | --- |
| "Any recall/commit explained within 2 clicks" | Click-count walkthrough (§7): recall explanation ≤2 actions from a message; commit diff ≤2 from the composer; entry points also component-tested | Design-verified; real usage not instrumented |
| "Read-only throughout" | D1: defaults/gates/tests | Verified |
| "5 real users can independently locate a recall-empty and a commit-failure cause" | **Not performed.** Protocol in §9; no fabricated study | **Externally-unverified** |
| "80% of daily checks happen inside DSH" | 12-item checklist (§8): all 12 are DSH-native; actual frequency not measured (no telemetry, by design) | Checklist-verified (frequency-unmeasured) |
| Bilingual parity | locale parity + render audit + mirrored docs tables (tests) | Verified (automated); zh walkthrough manual |
| Accessible widgets (WCAG 2.2 AA-aligned) | DOM/component structure + keyboard-model tests, plus manual checklist §10; stylesheet assertions are structural guards, not rendered contrast/zoom evidence | Design-verified; no automated conformance claim; Windows/NVDA **U** |

## 7. Studio-off core-flow walkthrough (reproducible)

Preconditions: clean DSH profile with the release tarball installed, OpenViking
reachable (read-only is enough; writes only on a disposable profile), native
views on, Studio never opened. Steps and expected click counts are in the README
section "Studio-off core-flow walkthrough" (12 steps). Evidence: browser capture
set (before v0.9 / after v1.0, fixture-labelled where data is invented) linked by
the maintainer in `VERIFICATION.md`; each step's route is exercised by the host
smoke/tests. Verdict: **Design-verified (click count/observation)**; the
screenshots are the human evidence, not an automated assertion.

## 8. Daily-check checklist (12 items) — all native, frequency-unmeasured

| # | Daily check | Native surface | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Explain a recall | Recall tab + per-turn memory sources | v0.3/v0.4 route+unit tests | native |
| 2 | Review a commit | Commit pill/timeline/diff | v0.3 tests, host smoke | native |
| 3 | Session memory state | Health tab session log | v0.3 tests | native |
| 4 | Diagnose why memory is not working | Doctor (health tab + Plugins summary) | v0.3/v0.6 tests | native |
| 5 | Inspect a `viking://` URI | Preview tab + Browse | v0.4/v0.7 tests | native |
| 6 | Quick status via command | `/viking status` | v0.3 command tests | native |
| 7 | Search everything | Explore search | v0.4/v0.6 tests | native |
| 8 | Rules list/test | Explore Rules | v0.4/v0.6 tests | native |
| 9 | Skills / Experience | Explore Skills/Experience | v0.4 tests | native |
| 10 | Tasks / failures / usage | Activity + cockpit Tasks/Stats | v0.5/v0.7/v0.8 tests | native |
| 11 | Stats / observability | Stats / Observability | v0.7/v0.8 tests | native |
| 12 | Switch scope/identity safely | Scope chip/menu/guards | v0.9 tests | native |

Result: **12/12 checks are DSH-native** after the v0.4–v1.0 stack. The roadmap's
"80% happen inside DSH" criterion is therefore met *for capability*; the actual
**frequency remains unmeasured** — this release adds no telemetry and no
instrumentation of real usage. Verdict: **Checklist-verified
(frequency-unmeasured)**.

## 9. 5-real-users user-study protocol (externally-unverified)

Status: **not run by this release**; do not claim it. The maintainer may run it as
external evidence and paste results here.

1. **Recruit** 5 people who use DSH + OpenViking, at least 2 unfamiliar with this
   plugin. Consent: they agree that anonymized task outcomes/time may be recorded;
   no memory bodies, prompts or account identifiers are captured.
2. **Setup** a clean test profile with the release tarball and a disposable
   OpenViking state containing: an empty-recall session and a failed-commit
   session (fixture data; never the participant's real memory).
3. **Instruction**: "Find out why this conversation's memory recall is empty" and
   "Find out why this commit failed", with no documentation, no hints, 10 min cap
   per task; think-aloud optional; observe without helping.
4. **Metrics** per participant: unaided success (yes/no), time to cause, number
   of dead ends, severity of blockers, subjective confidence (1–5).
5. **Pass threshold**: ≥4/5 participants identify each cause unaided. Record
   failures and quotes (anonymized) as improvement input.
6. **Record** results in an appendix here with date/participant count; owner:
   maintainer. Until then this item stays **Externally-unverified**.

## 10. Manual accessibility checklist (not automated)

Keyboard-only: all plugin controls reachable and operable with Tab/Shift+Tab,
Enter/Space, arrows/Home/End (tree, tabs, scope menu); dialogs trap Tab and
restore focus; Escape closes dialogs/menu. Screen reader (macOS VoiceOver; Windows
NVDA = **U**): tree rows announce name/level/selected/expanded; tab changes
announce the selected tab and panel; toasts are announced once; dialog title and
error text are announced. Zoom 200%: no clipped controls; toolbars wrap; dialogs
scroll. Both themes (light/dark): status is never colour-only; contrast checked
against the shell tokens; focus ring visible. Reduced motion: OS setting removes
transitions/animations. Verdict: **Design-verified**; Windows/NVDA **U**.

## 11. Bilingual manual checklist

EN and ZH: switch the app language and walk the same 12 steps; no raw locale keys;
dates/counts formatted for the language; README/README.zh and this release's
ledger/matrix mirrored row for row (automated); `/viking` command output remains
**English** (documented limitation: host has no app locale; DSH renders plain
text). Verdict: **Verified (automated parity) + manual walkthrough required
before tag**.

## 12. Degraded-state matrix

Every failure mode in the design's matrix is covered by the unified copy layer
(server unreachable, older server route missing, partial data/deadlines,
unsupported capability, disabled switch, identity/scope problem, config-source
health, empty state) and enforced by `test/v10-degraded.test.mjs` over the host
code vocabulary. Verdict: **Verified (automated copy coverage)**; rendered-state
appearance is manual evidence.

## 13. Review status (fixed v0.9 base + this PR's round)

The acceptance record must not vouch for an unfixed base. At this revision v1.0
is rebased onto the **fixed v0.9 head `b64d9cf`**, which carries the fixes for
PR #7's review round 1 — **B1** client scope switch chain (discovery reads +
adopt-the-reply), **B2** peer read lens never becomes write authority, **B3**
session-scope mismatch gates preview/force-commit and is enforced host-side,
**B4** expired tokens are purged so they cannot block a switch, **B5** the
Activity metrics cache resets on a scope switch — plus the ACL **S2** no-guess
fix (only documented `inherit`/`restricted` modes are echoed; a missing mode stays
unknown; 401 and 5xx are distinguished). Regression evidence:
`test/v09-client-scope.test.mjs` (B1 end-to-end), `test/v09-component.test.mjs`
(B1/B3/S4/S11 component regressions), `test/v09-scope-routes.test.mjs`
("Review round 1 regression tests (B2/B3/B5/S1/S2/S6/S7)") and
`test/v09-scope-units.test.mjs` (B4 purge). Verdict for the v0.9 guards above:
**Verified against the fixed base** with those regression tests; the two-server
scenario itself stays **Fixture-only**.

This PR (v1.0) review round 1 raised **N1** (hidden-tab zero-delay polling
self-loop), **N2** (mount-time focus steal in the scope chips) and suggestions
S1–S9. All are addressed in this revision; what changed and the tests that pin it
are listed in the CHANGELOG "Fixed (PR #8 review round 1)" entry. Two evidence
gaps are stated rather than papered over: N2's effect wiring is covered by the
pure `shouldRestoreFocus` helper plus a DOM-free component contract (no jsdom in
this repository, so the rendered focus move itself is manual), and the hidden
zero-schedule property is proven with a fake-clock scheduler test plus a
structural timer-ownership guard (both automated).

## 14. Known limitations / not verified

- No browser/accessibility automation and no jsdom: rendered focus movement,
  screen-reader output, contrast, zoom and reduced-motion are manual (§10);
  the automated suite covers ARIA structure, IDREF integrity and the pure
  keyboard/focus-decision helpers. **Windows U**.
- Desktop write parity **U**; desktop read-only behaviour **M**.
- OpenViking 0.5.2 **U**, 0.5.4 **U**; non-`dev` live auth modes **D**.
- Real-store writes: fixture-only (by design — no live write path in automation).
- First-paint timing not instrumented; performance budgets are request/cache
  assertions, not benchmarks. Hidden-tab scheduling is fake-clock tested, not
  browser-throttling tested.
- `/viking` output English (documented).
- Transcripts, OVPack backup/import/restore, compile config, rules compile,
  ACL/admin, resource upload/edit: **not shipped** (upstream dependency table in
  the READMEs).
- 5-real-users study and daily-check frequency: **externally-unverified /
  unmeasured** (§8–§9).
- CI URL and browser capture links: filled in by the maintainer at tag time
  (`VERIFICATION.md`).

## 15. Human sign-off block

Required before the `v1.0.0` tag (all PRs in the stack merged in order
`#2 → #3 → #4 → #5 → #6 → #7 → #8`, or the documented single-1.0.0 fallback):

- [ ] I have run `pnpm test` and `pnpm run verify:install` on the release commit.
- [ ] I have reviewed the README/README.zh final ledger, compatibility matrix and
      release path; the claims match the shipped code.
- [ ] I have reviewed `DECISIONS.md`, `PROVENANCE.md`, `CONTRACT.md`,
      `THIRD_PARTY_NOTICES` and `VERIFICATION.md` for this release.
- [ ] I have re-run or accepted the manual a11y/bilingual checklists (§10, §11).
- [ ] I accept that the user study and daily-check frequency remain
      unmeasured/externally-unverified and will not be claimed elsewhere.
- [ ] I have linked the CI run id and the browser evidence set in
      `VERIFICATION.md` (1.0.0 row).
- [ ] I confirm the fixed v0.9 base (`b64d9cf`) carries PR #7's review fixes with
      regression tests, and that PR #8's review round-1 items are addressed
      (§13 / CHANGELOG "Fixed (PR #8 review round 1)").
- [ ] I confirm this diff adds no dependency, no new write path and touches no live
      server store (the v1.0 changes are presentation/docs/tests only).

Maintainer: ______________________  Date: ____________  Release tag: `v1.0.0`

Decision: **ACCEPT / REJECT** (circle one). If accepted, the tag is created by a
human after merge; publishing to npm is a separate human 2FA step.
