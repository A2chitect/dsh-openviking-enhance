# dsh-openviking-enhance

A DeepSeek Harness (DSH) bundle that puts the local **OpenViking** memory system
inside the Web GUI:

1. **OpenViking Studio in the left sidebar** — a new sidebar row opens the
   server's own Studio SPA in the centre column.
2. **Per-session commit status** — a pill under the composer shows how close the
   current session is to an OpenViking commit, and clicking it lists the
   memories that each commit actually added, updated or deleted.

Status: **scaffold + verified data path**. Both halves build, typecheck and pass
their smoke tests against a live OpenViking 0.4.22 server; see
[Verification](#verification). It has not yet been mounted in a running GUI
profile — that is the first step of the plan in
[`docs/03-实施计划.md`](docs/03-实施计划.md).

## Why this plugin exists

`@openviking/dsh-memory-plugin` owns capture and commit, and it deliberately has
no UI: its `client.mjs` is a *host-side* HTTP client, not a browser half, and
`package.json` declares no `dsh.client`. It also exposes no commit state — the
service it provides (`openvikingMemory`) has no commit fields, and the commit
response's `task_id`/`archive_uri` are discarded while its log lines are emitted
at `debug`, which the desktop app filters out.

Everything in this bundle is therefore read from the OpenViking server, which
also makes it survive upgrades of that third-party package.

## Architecture

```
┌─ host process ──────────────────────────────┐   ┌─ browser (Web GUI) ──────────────┐
│ lib/index.js  (Cordis plugin)               │   │ lib/client.js                    │
│                                             │   │                                  │
│  /api/openviking-enhance/config   ──────────┼──▶│  sidebar.panellist  → Studio icon│
│  /api/openviking-enhance/status   ──────────┼──▶│  main (key=openviking) → <iframe>│
│  /api/openviking-enhance/commits  ──────────┼──▶│  conversation.composer.dock      │
│  /api/openviking-enhance/diff     ──────────┼──▶│      → commit status pill        │
│                                             │   │                                  │
│  reads: ~/.openviking/ovcli.conf            │   │  fetches document-relative       │
│  optional: ctx.get('openvikingMemory')      │   │  (never root-absolute)           │
└─────────────────────────────────────────────┘   └──────────────────────────────────┘
                    │
                    ▼
        OpenViking 127.0.0.1:1933
        /api/v1/sessions/{id}          commit state
        /api/v1/fs/ls?uri=…            history/archive_00N
        /api/v1/content/read?uri=…     memory_diff.json
        /studio/                       Studio SPA
```

Full reasoning, evidence and rejected alternatives: [`docs/`](docs/).

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/host/index.ts` | Cordis plugin: config, routes, lifecycle |
| `src/host/openviking-api.ts` | OpenViking HTTP client (no dependencies, never throws) |
| `src/host/commit-service.ts` | Commit status + memory-diff assembly |
| `src/host/config.ts` | Connection resolution from env / `~/.openviking` |
| `src/client/index.tsx` | Client entry: three slot registrations |
| `src/client/studio-panel.tsx` | Sidebar icon + Studio iframe page |
| `src/client/commit-status.tsx` | Status pill + affected-memory popover |
| `src/shared/protocol.ts` | Wire contract shared by both halves |
| `build.mjs` | esbuild build for both faces |
| `scripts/smoke-*.mjs` | Verification harnesses (see below) |
| `docs/` | Feasibility analysis, design, plan, evidence |

## Build

```bash
pnpm install          # store/cache are kept in-repo, see .npmrc
pnpm run build        # lib/index.js + lib/client.js
pnpm run typecheck
pnpm test             # typecheck + build + both smoke tests
```

`pnpm run watch` rebuilds on change.

Two build details are load-bearing:

- The client half **must** be prebuilt. The shell serves `lib/client.js` as-is;
  there is no source-build path, and a missing bundle fails activation loudly.
- The client bundle is wrapped as a lazy-CJS factory
  (`window.__ModuleLoader__.load({id, factory})`) and React is left **external**.
  The shell seeds a frozen module table and passes `require` into the factory;
  bundling React would give the plugin a second copy and break hooks.

## Install into a profile

Installing writes to the profile outside this repository, so run it yourself:

```bash
dsh plugin --profile desktop add link:/Users/a2chitect/AIplayground/DeepseekHarness/dsh-openviking-enhance
```

Then restart the app (or reload the profile). The bundle patch inserts one row,
`openviking-enhance`, which carries both halves.

To remove it:

```bash
dsh plugin --profile desktop remove dsh-openviking-enhance
```

## Configuration

Every field is optional; the defaults read the same files the OpenViking CLI
reads, so the panel always shows the memory space the sessions write to.

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | `~/.openviking/ovcli.conf` → `url`, else `http://127.0.0.1:1933` | OpenViking base URL |
| `apiKey` | `ovcli.conf` → `api_key`, else `OPENVIKING_API_KEY` | Bearer token (unused while `auth_mode: dev`) |
| `account` / `user` | `ovcli.conf.local`, else `default`/`default` | Identity the panel reads under |
| `studioPath` | `/studio/` | Studio SPA path on that origin |
| `cacheTtlMs` | `2500` | Status cache TTL |

Precedence is plugin config → `OPENVIKING_*` environment → `~/.openviking` conf
files → built-in defaults.

## Verification

`pnpm test` runs everything below; the smoke tests are the ones that prove the
data path.

| Check | What it proves |
| --- | --- |
| `tsc --noEmit` | Host and client compile against DSH `0.2.0-rc.2` types |
| `node build.mjs` | Both bundles emit, client wrapped in the loader contract |
| `scripts/smoke-client.mjs` | The built `lib/client.js` registers `apply`/`inject`, keeps React external, and registers all three slots without throwing |
| `scripts/smoke-host.mjs` | The built `lib/index.js` answers all four routes against the **live** OpenViking server and reads a real `memory_diff.json` |

The host smoke test exercises the real route handlers under a minimal fake Cordis
context — no DSH profile is touched.

## Known limitations

- **Not yet mounted in the GUI.** Slot names and props are verified against the
  `0.2.0-rc.2` type declarations and the published bundles of two working
  third-party plugins, but the live slot tree has not been observed (the Web GUI
  requires an authenticated session for the client Inspect bridge).
- **The status pill polls** (5 s) rather than subscribing; there is no push
  channel for commits.
- **`memories_extracted` on the session object undercounts**: when an extraction
  task fails, its operations are still written to the archive's
  `memory_diff.json` but never counted. The panel trusts the diff, not the
  counter.
- **Task records are pruned**, so commit history comes from archive directories.
- `deletes[]` entries carry `deleted_content` instead of before/after; that path
  is schema-verified but has never been observed populated.
- The plugin only reads. It never commits, writes or deletes anything in
  OpenViking.

## License

MIT.
