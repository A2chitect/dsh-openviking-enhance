# Provenance

Why this MIT package can ship the behaviour it ships.

`dsh-openviking-enhance` is the read-only/opt-in cockpit **on top of**
OpenViking and the official DSH memory plugin. It talks to both over documented
interfaces: HTTP requests the server accepts, files the official plugin keeps on
disk, DSH framework services and slots. None of that interface material is
another project's source expression copied into this repository, and no
third-party implementation was transcribed to produce this release.

## What v0.6 changed

Earlier versions mirrored one upstream implementation's expression: the
coding-purpose quota apportionment, the context-face request builder and the
request-deadline derivation in `src/host/recall-service.ts`. v0.6 replaces all
three with `src/host/recall-contract.ts`, written from the contract documented
below, and removes every "copied/mirrored from" comment from `src/`.
`scripts/check-independence.mjs` (part of `pnpm test`) fails the build if that
expression or wording comes back.

The cited contract passages are version-controlled in [`CONTRACT.md`](CONTRACT.md)
(context-face field table, quota semantics, stage budgets) with their source and
date, because the working notes under `docs/` are gitignored and never ship.

**What this record verifies is consistency with the documented contract
(`CONTRACT.md`), not runtime equality with the official plugin's
implementation.** The recall plan reproduces the documented request shape; it
does not claim to produce byte-identical requests to another client on every
configuration.

## Licence evidence (recorded, not resolved by this repository)

- The OpenViking server repository root `LICENSE` is **AGPL-3.0**.
- The installed official DSH memory plugin package
  (`@openviking/dsh-memory-plugin@0.5.32`) declares **`"license": "Apache-2.0"`**
  in its `package.json`; the `examples/dsh-memory-plugin` and
  `examples/memory-plugin-shared` directories carry no separate `LICENSE` file,
  and their generated shared files begin with a "GENERATED FROM
  examples/memory-plugin-shared/lib" banner.
- **The licence status of that shared implementation is therefore ambiguous from
  this machine.** This is a maintainer/legal question, tracked separately; it is
  not a blocker for this release because v0.6 contains no expression copied from
  it, and nothing in this repository redistributes it.

This file is an engineering record, not a legal opinion.

## Upstream-coupled behaviour

| Behaviour | Source of truth used | Where re-expressed | Evidence | Classification |
| --- | --- | --- | --- | --- |
| Coding-purpose quota apportionment (weights, guaranteed seats, unmet-proportional-demand allocation, category tie-break order) | `CONTRACT.md` §2 (version-controlled excerpt); the field is an integer map the server accepts | `src/host/recall-contract.ts` → `allocateRecallQuotas` | `test/v06-recall-contract.test.mjs`; hand-derived fixture matrix `test/fixtures/recall-wire/context-requests.json` | Independent re-implementation |
| Context-face request body (which optional fields are sent, and the value each carries) | `CONTRACT.md` §1 (version-controlled excerpt of the server request schema); the mounted memory plugin's *effective configuration* (its own "configured" flags are interface facts) | `src/host/recall-contract.ts` → `buildRecallContextBody` | Fixture matrix + `test/v03-units.test.mjs`; mock-server cross-check allowed, never committed as a capture | Interface fact (request schema) |
| Context request deadline (explicit override wins; expansion/rewrite stage budgets raise the configured timeout) | `CONTRACT.md` §3 (version-controlled excerpt of the observed stage budgets), recorded as constants in `recall-contract.ts` | `src/host/recall-contract.ts` → `recallContextTimeoutMs` | `test/v06-recall-contract.test.mjs` timeout matrix | Interface fact (HTTP stage budget) |
| Connection resolution (files/layers and precedence) | The documented OpenViking CLI/memory-plugin configuration layers: `~/.openviking/ovcli.conf`, `ovcli.conf.local`, `OPENVIKING_*` environment variables, plugin config | `src/host/config.ts` | `test/v03-units.test.mjs`, `test/host-units.test.mjs`; documented differences in both READMEs' host-contract chapter | Interface fact (configuration contract) |
| Official memory plugin's runtime/config objects read in-process | The plugin's exposed `openvikingMemory` runtime shape and its session config keys (`enabled`, `autoRecall`, `autoCapture`, `recallLimit`, `commitTokenThreshold`, …) | `src/host/commit-service.ts`, `src/host/session-control.ts` | Fake-runtime unit tests; the shape is not a published stable contract (listed under known gaps in both READMEs) | Interface fact (cross-plugin object, read-only) |
| Pending queue and capability memos on disk (`~/.openviking/pending`, `~/.openviking/state/*.json`) | The files the official plugin writes; this plugin only reads names/ages and two memo keys | `src/host/local-state.ts` | `test/host-units.test.mjs`, `test/v03-units.test.mjs` | Interface fact (on-disk data at rest; never written) |
| Commit archive layout and artifacts (`messages.jsonl`, `memory_diff.json`, history directories) | Server-produced archive layout as documented for the commit APIs | `src/host/session-log.ts`, `src/host/commit-service.ts` | `test/host-units.test.mjs`, `test/v03-units.test.mjs` | Interface fact (server artifact) |
| OpenViking auth-mode names and identity headers (`dev`, `trusted`, `api_key`; `X-OpenViking-Account`/`-User`/`-Actor-Peer`) | Documented HTTP auth contract | `src/host/config.ts`, `src/host/openviking-api.ts` | `test/host-units.test.mjs`, `test/v05-units.test.mjs` | Interface fact (HTTP protocol) |
| DSH framework services, slots, commands, routes, connection transport | The pinned `@deepseek-ai/dsh-*` devDependency type definitions and their documented contract | `src/host/index.ts`, `src/client/*` (type-checked against them) | `tsc --noEmit`; client smoke harness; feature-toggle render tests | Documented host API (MIT packages; see `THIRD_PARTY_NOTICES`) |
| CSS values matched to the DSH shell's shipped panels | The shell's rendered styling (MIT-licensed DSH client packages, copyright DeepSeek) | `src/client/styles.ts` (values only; no source copied) | client smoke style checks | Third-party MIT (attributed) |
| OpenViking HTTP endpoint paths and response envelopes (`/api/v1/…`) | The server's OpenAPI/HTTP contract, verified against the tested range | `src/host/openviking-api.ts` and services | Unit tests with stub servers; live smoke (optional, read-only) | Interface fact (HTTP protocol) |

## Fixture provenance

`test/fixtures/recall-wire/context-requests.json` was **hand-authored from the
contract recorded in `src/host/recall-contract.ts`**. It contains invented
inputs (a fictional session id, a release-checklist query) and expected request
bodies derived by applying the documented weights/optional-field rules; it is
not a capture of any real OpenViking server and contains no memory content,
credentials or session data. Cross-checking a hand-authored body against a mock
server is allowed; committing a real-server capture is not.

## Research notes

`docs/` is gitignored: the design briefs and API research notes are working
material, are not part of the published package and never ship in the npm
tarball or the git tree. User-facing documentation lives in `README.md`,
`README.zh.md`, `VERIFICATION.md`, `PROVENANCE.md` and `THIRD_PARTY_NOTICES`.

## Keeping this record true

- **Contract refresh rule:** `CONTRACT.md` is the tracked excerpt of the
  documented contract. Re-read the server documentation/OpenAPI, update the
  excerpt with a source and date, re-derive the fixtures, and only then change
  `src/host/recall-contract.ts`.
- **Review rule:** if you cannot name the behaviour contract (the server field,
  the documented rule, the interface fact) that justifies a piece of logic, do
  not code it — go back to the documented source of truth first.
- **Fixture refresh rule:** the wire fixtures pin the request shape at a tested
  server/memory-plugin generation. When OpenViking or the official plugin's
  request shape changes (observed by a version bump), re-derive the fixtures and
  re-read the contract before changing the implementation.
- **Adding a row:** a new upstream-coupled behaviour gets one row in the table
  above before it gets code. `scripts/check-independence.mjs` prints this table's
  row count so a reviewer can see the record is maintained.
