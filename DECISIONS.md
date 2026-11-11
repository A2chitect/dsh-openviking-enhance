# Decisions

The decisions that shape v1.0 and the post-1.0 promise. Each entry records the
decision, the reasons, the evidence that keeps it true, and what would trigger a
revisit. Engineering records here — not legal advice; the licence entry says the
same thing more carefully.

## D1 — Licence: MIT package, independently implemented contract

**Decision.** `dsh-openviking-enhance` stays **MIT** (`LICENSE`). Every
behaviour that resembles an upstream implementation — the coding-purpose quota
apportionment, the context-face request body, the request-deadline derivation,
connection resolution, the official plugin's local state reads — is treated as an
**interface fact** written down in this repository (`CONTRACT.md`,
`PROVENANCE.md`) and implemented independently. No expression from an AGPL-3.0 or
otherwise incompatible upstream implementation is copied into this package.

**Reasons.** The ROADMAP invariant is "No AGPL code"; the project's posture is
MIT; the upstream shared implementation's licence is ambiguous from this machine
(the server repository root is AGPL-3.0 while the installed memory-plugin package
declares Apache-2.0 and its example directories carry no separate licence — see
`PROVENANCE.md`). Rewriting the small mirrored surface (v0.6) removed the
conflict without changing observable behaviour.

**Evidence / controls.**
- `scripts/check-independence.mjs` is part of `pnpm test` and CI: fails on
  provenance wording ("copied from"), upstream imports/paths, AGPL text, and on
  real-server captures in committed fixtures; it also asserts that
  `CONTRACT.md`/`PROVENANCE.md`/`THIRD_PARTY_NOTICES` exist and ship.
- `CONTRACT.md` holds the cited contract excerpts (source + date); `PROVENANCE.md`
  holds the behaviour audit table and states the claim is **consistency with the
  documented contract, not runtime equality** with any upstream implementation.
- `THIRD_PARTY_NOTICES` carries the bundled MIT attributions and ships in the
  tarball; the packaged files are checked in CI.

**Escalation trigger.** If the maintainer/legal ever determines that a behaviour
here still constitutes a derivative of AGPL code, the fallback is to re-implement
that behaviour from the documented wire contract (as v0.6 did for quotas) or to
drop request parity and let server defaults apply. Relicensing this package as
AGPL is a last resort and a breaking change; it is not planned.

## D2 — API stability: tested range + probes + graceful degradation

**Decision.** "Stable API" means the plugin's **own** surface (configuration
keys, host routes, `/viking` command verbs, payload shapes, slot/tab ids) follows
semver. Upstream compatibility is a **tested range plus runtime capability
probes**, never an assertion that every upstream version behaves identically.

| Interface | Classification | Promise |
| --- | --- | --- |
| Plugin config keys, host routes, command verbs, payload fields, slot ids | Own public contract | semver: added = minor, removed/changed = major; v1.x is additive |
| DSH framework services (`ctx.webServer`, `ctx.commands`, `ctx.connection.fetch`, slots) | Host API, pinned range `engines.dsh` / peer | built and type-checked against one generation; older generations keep reads and disable writes with a stated reason; a DSH major is not accepted by the manifest |
| OpenViking HTTP API | Tested range (currently 0.5.1.1–0.5.3) + capability probes | degrade to a stated "not available on this server" state; no guessing — an absent ACL mode stays unknown (never inferred as "inherit") and 401/5xx are distinct states, regression-tested; the matrix labels untested versions U |
| Official memory plugin in-process runtime state | **Not a stable upstream contract** | read defensively; missing/moved fields degrade to unknown/skipped, never crash the host; a major change may reduce the explanation surface |
| Files read at rest (pending queue, capability memos, commit archives) | Observed on-disk interface fact | read-only; names/ages only; corrupt files are reported in config-source health, never written |
| Studio iframe headers/URLs | Server-owned UI | framing probe + open-in-new-tab/browser fallback; no proxy |

**Post-1.0 semver policy.** 1.x releases stay additive: no route/payload/command
removal without a major; deprecations are announced for at least one minor and
shipped behind the compatibility layer while the tested upstream range allows.
The tested OpenViking/DSH matrix moves only with a deliberate contract update
(`CONTRACT.md` refresh rule) and the README matrix plus `VERIFICATION.md` record
the new evidence.

**Evidence.** `test/v06-docs.test.mjs` (engines/peer semantics + matrix parity),
`test/v10-docs.test.mjs` (final matrix + ledger), capability/degradation route
tests, and the install-verification gate.

## D3 — Native completeness: core flow is Studio-free; Studio stays the fallback

**Decision.** The core explain/operate/trust flow is native (see the F1–F14 ledger
in the READMEs and `ACCEPTANCE.md`). The Studio iframe remains registered as an
explicit view because it is the server's own complete UI; it is never required
for the core flow. Two deliberate non-goals are recorded: **conversation
transcript reading** and the Studio-only advanced admin operations listed in the
READMEs' "What remains Studio/CLI-only" table.

**Evidence.** `test/v10-docs.test.mjs` (ledger completeness/row parity),
`test/v10-performance.test.mjs` (one composed Overview request, visibility-gated
polling), the v0.7 cockpit tests, and the Studio-off walkthrough in
`ACCEPTANCE.md`.

## D4 — Accessibility evidence: AA-aligned widgets, manual conformance checklist

**Decision.** The plugin's own widgets align with WCAG 2.2 AA expectations for
keyboard, semantics, focus, live regions, reduced motion, contrast and zoom
(README section "Accessibility"). Automated evidence is DOM/component and pure
keyboard-model testing; **no automated conformance claim** is made. The manual
checklist (keyboard-only, VoiceOver, both themes, 200% zoom) lives in
`ACCEPTANCE.md`; Windows/NVDA remains unverified and labelled **U**.

**Reasons.** No browser automation or accessibility dependency is allowed in
v1.0; the design records this limitation explicitly, and honest labelling is a
release requirement.

## D5 — Release path and upgrade pin

**Decision.** The primary path is one release per merged version PR (v0.4.0 …
v1.0.0). At this PR's drafting the stack is **unreleased** (`package.json` still
0.3.0), so the documented fallback applies unless the maintainer cuts the
intermediate tags: promote the whole `## Unreleased` block into a single **1.0.0**
section, move the README version lines to `v1.0.0`, and keep the tag-CI
`--upgrade-from` pin at the newest *published* version (0.3.0 for this tag, then
1.0.0 for the next release). `RELEASING.md` owns the step list, the upgrade-pin
rule, and the rollback policy (never move/retag a release; cut a patch release).

## D6 — Evidence honesty: unmeasured and unverified stays labelled

**Decision.** No synthetic user study, no fabricated live evidence, no claimed
compatibility beyond what was exercised. Specifically: the roadmap's
"5 real users" goal is recorded as **externally-unverified** with a ready-to-run
protocol; daily-check *frequency* is **unmeasured** (no telemetry); real-store
write evidence is **fixture-only** (fake server/fake transport — no live write
path is ever exercised by automation); Windows, desktop-write parity and
non-`dev` auth modes are **U/D** in the matrix. `ACCEPTANCE.md` defines the
verdict taxonomy and the human sign-off block.
