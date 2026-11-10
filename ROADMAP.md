# Roadmap

This project is the OpenViking memory cockpit for the DeepSeek Harness (DSH) Web
GUI: it explains, diagnoses and (only when a person asks) curates the memory an
OpenViking server already holds. This roadmap turns the 2026-11-09 direction
report into shippable versions; each version ships as one pull request and keeps
the invariants below.

The report itself is the reference, not scripture: scope and ordering are
optimised as the server and DSH evolve. Every version states what actually
shipped.

## Invariants

- **Read-only by default.** A surface that changes OpenViking data is opt-in,
  requires an explicit confirmation, offers a dry run, is undoable (snapshot) and
  is recorded in an audit view. No hidden writes, no automatic curation.
- **The official memory plugin owns the pipeline.** Auto recall, capture, commit
  and the model-visible MCP tools stay with `@openviking/dsh-memory-plugin`; this
  plugin explains and operates on top of them, it does not replace them.
- **Additive, switchable surfaces.** New UI uses additive DSH slots, every surface
  has its own live switch, and an old or partially capable OpenViking server
  degrades to a clear "not available on this server" state instead of an error.
- **No AGPL code.** `@openviking/react` and OpenViking's AGPL-licensed shared
  implementation are not copied into this MIT package; behaviour is treated as an
  interface fact and re-implemented independently.
- **Every version is verifiable.** Unit tests, a browser check in a scratch DSH
  profile, before/after screenshots in the PR for the surfaces it changes, and a
  compatibility matrix (DSH generation, OpenViking version) in the release notes.
- **Nothing private leaves the machine.** No telemetry, no conversation bodies in
  logs, no API keys in diagnostics or screenshots.

## Versions

| Version | Theme | Scope | Exit criteria |
| --- | --- | --- | --- |
| **v0.3** | Explain | F1 recall explanation, F2 commit diff, F3 session log, F4 Doctor; DSH 0.2.2 support; OpenViking 0.5.3 capability probes. *(shipped as PR #1)* | Any recall or commit can be explained within two clicks; read-only throughout. |
| **v0.4** | Act I — read operations | F5 `viking://` preview and deep links, F6 `/viking` read commands (`status`, `doctor`, `recall`, `open`), F7 unified search, F8 rules / skills / experience centre. | Daily inspection needs no browser tab: 80% of checks happen inside DSH; commands work in web and desktop profiles; still read-only. |
| **v0.5** | Act II — curation and control | F9 memory curation (edit / delete / pin, dry run, confirmation, snapshot undo, audit), F10 capture and session control (forced commit, pause/resume where the server supports it), F11 task centre and metrics, F12 identity and scope switcher with a read-only ACL view; write commands open (confirm + audit). | Writes never happen unasked and are undoable; failures are exportable; switching account/user/peer never silently mixes data. |
| **v0.6** | Trust and verify | Independent re-implementation of the quota maths currently mirrored from upstream; clean-profile install / upgrade / reinstall / uninstall verification; host contract and compatibility matrix in the READMEs; privacy hardening (redacted smoke output, credential guidance); request `User-Agent`/version/`traceId`; configuration-source health in the Doctor. | No AGPL-derived code in the MIT build; the published tarball is verified in a clean profile; the compatibility matrix is documented. |
| **v0.7** | Native I — no iframe for reading | Native memory / resource / skill tree, content preview, sessions and commits browser, memory stats — enough to read the server without Studio; Studio keeps working as an optional fallback; first-run onboarding wizard (F14 start). | Core read tasks work without the iframe; the fallback is documented. |
| **v0.8** | Operate | F13 read and controlled-action surfaces: compile status and trigger, snapshot log/diff/restore (confirmation + undo), OVPack export/backup; task centre retry and export; observability (metrics / observer) view. | Operational tasks are possible from DSH with confirmations and exportable evidence. |
| **v0.9** | Native II — multi-scope | Multiple server endpoints with per-server identity, account/user/peer switching with an explicit scope banner everywhere (F12 complete), sharing and ACL views; cross-scope search guards. | Multiple servers and scopes stay isolated and visibly labelled. |
| **v1.0** | Native — complete | Core tasks fully native (no iframe needed anywhere in the core flow), polished degraded paths, accessibility and bilingual parity, final compatibility matrix, and the recorded licence / API-stability decision. | The original roadmap's expected goals are met: explain, operate and trust inside DSH; core tasks run without Studio; a person reviews and merges the final PR. |

Versions may be split or reordered when the upstream server makes a planned
surface impossible; a version's pull request always explains the deviation.

## Sources

- Direction report (gist): https://gist.github.com/a2chitect-superagent/ba8733622682b36843d53b17d7200989
- OpenViking documentation: https://docs.openviking.ai
- DSH integration: https://docs.openviking.ai/en/agent-integrations/17-dsh
