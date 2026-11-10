# Contract excerpts for the session-aware recall request

This file is the **version-controlled source of truth** for the three recall
behaviours v0.6 re-implemented in `src/host/recall-contract.ts`. It exists
because the independence argument must be auditable from the repository: the
working notes under `docs/` (including `docs/api-v05.md`) are intentionally
gitignored, so the passages this plugin's code and `PROVENANCE.md` cite are
reproduced here as excerpts, with the source and date recorded.

**Source:** OpenViking's HTTP request schema and context-face response behaviour,
observed read-only against the tested server range `0.5.1.1 – 0.5.3` on
**2026-11-10**, cross-checked against the server's OpenAPI document. The
quota/body/deadline facts were captured in the untracked research note
`docs/api-v05.md`; the excerpts below are the portions this plugin's contract
rests on, not a copy of any implementation.

**Scope of the claim:** these excerpts describe what the server accepts and
returns. They do **not** re-state, quote or paraphrase any implementation
expression from an upstream plugin, and this repository verifies only
*consistency with this documented contract*, not runtime equality with the
official plugin's output. See `PROVENANCE.md`.

## 1. Context-face request fields

`POST /api/v1/search/search`, body `mode: "context"`:

| Field | Type | When the contract sends it | Meaning |
| --- | --- | --- | --- |
| `query` | string | always | the turn's prompt, capped by the plugin before sending |
| `mode` | `"context"` | always | ask for one assembled block plus accounting instead of per-bucket lists |
| `purpose` | `"coding"` | always | selects the coding-purpose retrieval profile |
| `score_threshold` | number | always (configured value, else `0.35`) | minimum relevance the server keeps |
| `session_id` | string | always | the session whose de-duplication/peer state applies |
| `quotas` | map<string, integer> | only when the mounted plugin reports the recall limit as explicitly configured | per-category token/slot share; omitted lets the server policy apply |
| `max_tokens` | integer | only when the token cap is explicitly configured; floor 64, default 1600 | context budget for the assembled block |
| `dedup_turns` | integer | default 5 when absent; omitted at 0 | cross-turn de-duplication window |
| `query_expansion` | `"auto" \| "off"` | only when explicitly configured | whether the server expands the query first |
| `peer_scope` | `"actor"` | only for actor scope | scope retrieval to the calling peer |
| `events_time_decay_protection` | string | when non-empty | protects matching events from time decay |
| `exclude_uris` | string[] | when non-empty, capped at 200 | URIs the server must not return |
| `rewrite` | `true \| "auto"` | `true` for server rewrite, `"auto"` for auto | asks for the server-side rewrite stage |
| `rewrite_max_bullets` | integer | only when a rewrite is requested and the bullet cap is configured | rewrite output bound |

The optional fields are sent **only** when the mounted plugin's effective
configuration says so: the plugin reports `recallLimitConfigured` /
`recallMaxTokensConfigured` / `recallQueryExpansionConfigured` /
`recallCompressMaxBulletsConfigured` flags, and a default install must leave the
server's own policy in charge of the ranking the explanation describes.

## 2. Coding-purpose quota semantics

Six categories participate, in this tie-break order:

| Category | Weight |
| --- | --- |
| `events` | 1 |
| `entities` | 2 |
| `preferences` | 1 |
| `experiences` | 1 |
| `resources` | 3 |
| `skills` | 2 |

The observed allocation rule for a requested recall limit `L`:

1. when `L ≥ 6`, every category receives one guaranteed slot;
2. the remaining `L − 6` slots go, one at a time, to the category with the
   largest **unmet proportional demand**, where a category's ideal share is
   `L × weight / Σweights` and its remaining demand is that ideal minus its
   current allocation;
3. ties are broken by the category order above (earlier wins);
4. when `L < 6` every category still receives one slot, so the total intentionally
   exceeds `L` — the edge is part of the contract, not a bug.

The allocation is an integer map (`{events, entities, …}`) sent inside `quotas`
only in the explicitly-configured case described in §1.

## 3. Request deadline and stage budgets

The context pipeline is serial, and two optional stages have their own server
fuses; a client deadline shorter than the longest requested stage would report a
healthy but slow server as unreachable. The observed derivation:

| Rule | Value |
| --- | --- |
| explicit `recallContextTimeoutMs` wins | clamped to at least 1 000 ms |
| no rewrite and no expansion requested | no special deadline (`undefined`) |
| query expansion requested (a `session_id` is present and expansion is not `"off"`) | at least 15 000 ms |
| rewrite requested | at least 45 000 ms |
| configured request timeout (`timeoutMs`) | raises the floor, never lowers it |

The 45 s / 15 s values are **server stage budgets observed through the client
request deadline**, recorded as constants in `src/host/recall-contract.ts`; a
change to either is a deliberate contract change, not a tuning tweak.

## Refresh rule

These excerpts pin the request shape at a tested server generation. When
OpenViking's request contract changes (observed by a version bump, a new required
field, or a different option set), re-read the server documentation/OpenAPI,
update this file with the excerpt and date, re-derive
`test/fixtures/recall-wire/context-requests.json`, and only then change
`src/host/recall-contract.ts`. `PROVENANCE.md` records the same rule for the
behaviour table.
