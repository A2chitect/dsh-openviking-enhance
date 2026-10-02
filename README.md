# dsh-openviking-enhance

A DeepSeek Harness (DSH) bundle that puts the local **OpenViking** memory system
inside the Web GUI:

1. **OpenViking Studio in the left sidebar** — a new sidebar row opens the
   server's own Studio SPA in the centre column.
2. **Per-session commit status** — a pill under the composer shows how close the
   current session is to an OpenViking commit, and clicking it lists the
   memories that each commit actually added, updated or deleted. It renders as
   the last item of that row, after the shell's own stats pills, and is styled
   from them (same font metrics, colour tokens, capsule shape, icon size and
   tabular figures), so the row reads as one family. It carries the same glyph as
   the sidebar row and leads its label with **OV**, so it cannot be mistaken for a
   git commit. When the newest commit's memory extraction failed, the pill turns
   amber and reads `OV · 抽取失败` — see below.

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
| `src/host/commit-service.ts` | Commit status (incl. the archive-vs-counter phase probe) + memory-diff assembly |
| `src/host/config.ts` | Connection resolution from env / `~/.openviking` |
| `src/client/index.tsx` | Client entry: three slot registrations |
| `src/client/studio-panel.tsx` | Sidebar icon + Studio iframe page |
| `src/client/commit-status.tsx` | Status pill + spacer + affected-memory popover |
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

The two halves reload differently, which matters while developing:

- the **client half** is served from `lib/client.js` by revision, so a rebuild plus
  a page reload picks it up;
- the **host half** is a Node module already imported into the running process.
  HMR does not follow the profile's `link:` symlink back into this repository, so
  a rebuild needs an app restart before the host changes take effect.

`pnpm test` runs type check, build, unit tests and both smoke harnesses. The host
smoke needs a running OpenViking; the fence cases are the part that is worth
watching in CI-friendly runs.

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

## Security

Plugin routes are **not** covered by the DSH web authentication gate: `GET /`
answers 401 without the launch token, while `GET /api/openviking-enhance/config`
answers 200 to a bare `curl`. On loopback that adds no exposure worth worrying
about — anything on the machine can read `~/.openviking` directly — but these
routes return memory metadata and `/diff` returns memory bodies, so a UI bound to
a non-loopback interface, a tunnel, or a reverse proxy would turn them into an
unauthenticated read API over a personal memory store.

Every route therefore requires the request to be what it claims to be
([`src/host/trust-fence.ts`](src/host/trust-fence.ts)):

| Check | Blocks |
| --- | --- |
| socket address is loopback | any off-machine connection, including via a proxy elsewhere |
| `Host` names a loopback authority | a proxy or tunnel reaching us over loopback but fronting a public name |
| `sec-fetch-site` is not `cross-site` | a page on another site targeting a loopback port |
| `Origin`, when present, equals `Host` | a same-machine different-port caller, and `Origin: null` |

`X-Forwarded-For` is never consulted — a client-settable header must not be able
to assert its own trustworthiness. A reverse proxy that needs these routes has to
be allowlisted in code, which is a deliberate change rather than a config toggle.
Non-`GET` methods answer 405.

The plugin performs **no writes** to OpenViking: it never commits, writes or
deletes anything.

## Verification

`pnpm test` runs everything below; the smoke tests are the ones that prove the
data path.

| Check | What it proves |
| --- | --- |
| `tsc --noEmit` | Host and client compile against DSH `0.2.0-rc.2` types |
| `node --test` | 15 unit tests over the pure logic: trust fence, phase derivation, diff normalization, session-URI resolution, the archive-URI guard, double-encoded JSON |
| `scripts/smoke-host.mjs` (fence) | Live route fence: forged `Host`, cross-origin `Origin` and `POST` are refused (403/405), plain loopback still 200 |
| `node build.mjs` | Both bundles emit, client wrapped in the loader contract |
| `scripts/smoke-client.mjs` | The built `lib/client.js` registers `apply`/`inject`, keeps React external, and registers all three slots without throwing |
| `scripts/smoke-host.mjs` | The built `lib/index.js` answers all four routes against the **live** OpenViking server and reads a real `memory_diff.json` |

The host smoke test exercises the real route handlers under a minimal fake Cordis
context — no DSH profile is touched.

## Failed extractions are surfaced, not swallowed

A commit is two-phase: the archive is written inline, memory extraction runs in
the background. When extraction **fails**, OpenViking still writes the archive and
still advances `commit_count`, so every other signal looks exactly like success —
the count matches the archive count, the archive exists, and only
`memory_diff.json` is missing. The third-party memory plugin also discards the
task, and logs at a level the desktop app filters out.

This plugin reads the `session_commit` task records, so the failure is visible:

- the pill switches to `OV · 抽取失败` (amber, same geometry as the other pills);
- the popover lists each failure with its time, duration and the provider's own
  message, and says plainly that those commits' memories were never extracted.

This is not hypothetical: on the machine this was built for, the first run of the
feature reported **6 failed extractions in the current session, every one of them
`400 Thinking mode does not support this tool_choice`** from the extraction model
configured in `~/.openviking/ov.conf`.

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
