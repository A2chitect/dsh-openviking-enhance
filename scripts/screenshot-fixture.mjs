// A stand-in OpenViking server for screenshots: same endpoints and envelopes the
// real one answers, with invented content. Nothing here comes from a real memory
// store, which is the point — the screenshots show the plugin, not somebody's data.
//
// It backs the screenshots in `assets/`: boot a scratch profile, point this
// plugin at this server, and capture the surfaces without a real memory space
// anywhere in the picture. Nothing it serves is real content.
//
//   node scripts/screenshot-fixture.mjs [port]
//
// ## v0.4 additions (all invented, all additive)
//
// The plugin's v0.4 release reads a wider slice of the OpenViking API
// (`docs/api-v04.md`). The same fixture process now also answers, from the same
// demo identity:
//
//   GET /api/v1/content/abstract|overview   L0/L1 directory sidecars (plain text)
//   GET /api/v1/fs/attrs                    context face + tags + memory metadata
//   GET /api/v1/fs/ls|tree                  the rules and experiences trees
//   GET /api/v1/skills?node_limit=N>1       enriched catalogue (roots, SKILL.md, tags)
//   POST /api/v1/search/search (list, no session/target)
//                                           the Explore search's three buckets
//   POST /api/v1/rules/search (task context) a matched Rule with YAML frontmatter
//   GET /api/v1/agent-evolution/experiences/trajectories|outcomes
//
// Invariant: every response a v0.3 surface consumes stays byte-identical. The
// v0.4 responses therefore switch on the *request shape* the two plugin
// generations send, not on the fixture's version:
//
//   - `mode:"context"` search and list-mode searches that carry a
//     `session_id`/`target_uri` (the v0.3 recall panel / explain) keep the old
//     body exactly; a session-less list-mode search (Explore) gets the enriched
//     body.
//   - `rules/search` keeps answering the Doctor's capability probe with the old
//     empty-library body; a real task context gets the matched rules.
//   - `GET /skills` keeps the old body for `node_limit=1` (the v0.3 Doctor count
//     and the v0.4 Doctor count); the catalogue's `node_limit=1000` gets the
//     enriched body.
//   - `content/read` still answers only commit archives (`memory_diff.json`,
//     `.done`, ...) and 404s every other v0.3-era file; the v0.4-only families
//     (`memories/rules/…`, `memories/experiences/…`, `memories/trajectories/…`,
//     `…/SKILL.md`) are readable. `fs/ls … /history` keeps the old archive body.
//   - `fs/stat uri=viking://~` keeps the old demo-root body (the Doctor probe);
//     the v0.4 catalogue/preview URIs get exact stat records.
//
// The compatibility replay lives in `.scratch/v04/verify-fixture-compat.mjs`
// and `.scratch/v04/fixtures/screenshot-fixture-v03-baseline.mjs` (the exact
// released tarball's fixture, sha256 0a5fff32…6c73ff1) so the invariant is
// checked, not assumed.
//
//   OV_FIXTURE_EMPTY_EXPERIENCES=1 node scripts/screenshot-fixture.mjs 1999
//       → the experiences root answers 404 NOT_FOUND so the AFTER capture can
//         screenshot the Explore tab's "no Experience records yet" state.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.argv[2] ?? 1999)
/** Test switch for the Experience tab's empty state (see `.scratch/v04`). */
const EMPTY_EXPERIENCES = process.env.OV_FIXTURE_EMPTY_EXPERIENCES === '1'
/**
 * v0.6 evidence modes. Off by default so every pre-existing response (and the
 * compat gate) is byte-identical; they are only set for the v0.6 screenshot
 * pass that exercises L2 paging and the Rules partial/truncated state.
 */
const LONG_L2 = process.env.OV_FIXTURE_LONG_L2 === '1'
const RULES_STALL = process.env.OV_FIXTURE_RULES_STALL === '1'
/**
 * v0.7 evidence modes. `OV_FIXTURE_NATIVE=1` seeds the native cockpit's read
 * data (session directories for Sessions/Commits, peer/personal browse roots);
 * `OV_FIXTURE_STUDIO_BLOCKED=1` makes the mock Studio advertise an iframe
 * refusal so the Studio-fallback view can be captured deterministically.
 */
const NATIVE = process.env.OV_FIXTURE_NATIVE === '1'
const STUDIO_BLOCKED = process.env.OV_FIXTURE_STUDIO_BLOCKED === '1'
/**
 * v0.8 evidence mode: snapshot history, compile targets/operations, pack export,
 * console analytics and observer cards for the Operate group. Environment-gated
 * so the pre-v0.8 fixtures stay byte-identical by default.
 */
const OPS_MODE = process.env.OV_FIXTURE_OPS === '1'
/** A compile-managed output file whose version history the Operate view reads. */
const COMPILE_OUTPUT_URI = 'viking://resources/compiled/dsh-plugin.mdc'
/** Poll counter so one operation first reads `running`, then `completed`. */
const COMPILE_POLLS = new Map()
const COMPILE_TARGETS = [
  {
    status: 'active',
    to: 'viking://user/demo/memories',
    initialized: true,
    running: false,
    auto_update: false,
    update_schedule: null,
    next_run_at: null,
    content_updated_at: 1762218000,
    compile_type: 'memory',
    conflicts_num: 0,
  },
  {
    status: 'paused',
    to: 'viking://user/demo/resources',
    initialized: true,
    running: false,
    auto_update: true,
    update_schedule: '0 3 * * *',
    next_run_at: '2026-11-11T03:00:00Z',
    content_updated_at: 1762131600,
    compile_type: 'resource',
    conflicts_num: 1,
  },
]
/** DSH-shaped session keys whose first entry matches the seeded DSH session. */
const NATIVE_DSH_SESSIONS = [
  'session-47a8cdea-8bbd-42c5-8150-b8676f8b86e7',
  '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
  '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
  '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
  '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d',
  '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e',
]
/** The long body is paged by the v0.6 preview; 400 lines must fit the host's
 *  PREVIEW_MAX_CHARS cap, so every line stays short. */
const longL2Uri = () => `${USER}/memories/entities/project/release-history.md`
const longL2Body = () => {
  const lines = [
    '# Release history (long fixture document)',
    '',
    'Invented release log used by the v0.6 visual evidence to exercise the paged',
    'L2 preview. Every line is short so one 400-line page fits the preview cap.',
    '',
  ]
  for (let index = 1; index <= 920; index += 1) {
    lines.push(`- build ${String(index).padStart(4, '0')}: promote the changelog.`)
  }
  return lines.join('\n')
}

/** v0.6 Rules evidence: extra rule files so the two-phase listing needs at
 *  least two different pages of the bounded (concurrency-4) pool. */
function extraStallRules() {
  const rules = []
  for (let index = 1; index <= 40; index += 1) {
    const slug = `stall-rule-${index}`
    rules.push({
      uri: `${SCENARIO_SIDEBAR}/${slug}.md`,
      text: [
        '---',
        'schema: openviking.rule/v1',
        `atomic_id: ${slug}`,
        'revision: 1',
        'status: active',
        'scenario_id: sidebar-contract',
        'source_uris: []',
        'evidence: []',
        'updated_at: 2026-11-08T09:30:00+00:00',
        `name: Stall rule ${index}`,
        'confidence: user',
        `description: Fixture-only rule ${index} that fills the v0.6 rule-list budget.`,
        `content: Fixture rule ${index} exists only to make the partial listing deterministic.`,
        'applies_when: The v0.6 partial rules fixture is exercised.',
        "exception: ''",
        'probability: 0.6',
        '---',
        '',
        `# Stall rule ${index}`,
        '',
        'This rule exists only in the v0.6 evidence fixture.',
      ].join('\n'),
      modTime: '2026-11-08T09:30:00Z',
    })
  }
  return rules
}

const USER = 'viking://user/demo'
const SESSION_URI = `${USER}/sessions/2026-10-02/demo-session`
const ARCHIVE = (stamp) => `${SESSION_URI}/history/${stamp}`

const MEMORY = (slug) => `${USER}/memories/entities/project/${slug}.md`
const RESOURCE = (slug) => `viking://resources/dsh/${slug}.md`
const SKILL = (slug) => `viking://agent/skills/${slug}.md`

const diff = (stamp, adds, updates, deletes) => ({
  archive_uri: ARCHIVE(stamp),
  extracted_at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:00Z`,
  operations: {
    adds: adds.map(([slug, type, text]) => ({ uri: MEMORY(slug), memory_type: type, after: text })),
    updates: updates.map(([slug, type, before, after]) => ({ uri: MEMORY(slug), memory_type: type, before, after })),
    deletes: deletes.map(([slug, type, text]) => ({ uri: MEMORY(slug), memory_type: type, deleted_content: text })),
  },
  summary: {
    total_adds: adds.length,
    total_updates: updates.length,
    total_deletes: deletes.length,
    total_skipped: 0,
  },
})

const DIFFS = {
  '20261002T075500Z': diff(
    '20261002T075500Z',
    [
      ['release-checklist', 'entity', 'Release checklist for the plugin: bump the version, promote the changelog section, tag, then publish the tarball.'],
      ['plugin-icon-rules', 'entity', 'Icons ship as a 32x32 SVG with a single accent colour; the shell renders them at 20px.'],
    ],
    [
      ['sidebar-row-order', 'entity', 'Rows sort by `order`, ties by load order.', 'Rows sort by `order` ascending; ties fall back to registration order, which differs between boots — always set an explicit order.'],
    ],
    [],
  ),
  '20261002T073000Z': diff(
    '20261002T073000Z',
    [['bilingual-copy', 'entity', 'User-facing strings live in one dictionary per language with English as the fallback; parity between the two is asserted.']],
    [],
    [['obsolete-notes', 'event', 'Scratch note about an older sidebar layout that no longer exists.']],
  ),
  '20261002T071000Z': diff(
    '20261002T071000Z',
    [
      ['workspace-conventions', 'entity', 'TypeScript strict, unit tests through `node --test`, one commit per finished piece of work.'],
      ['review-notes-0930', 'event', 'Reviewed the sidebar layout with the team; the status pill moved under the composer.'],
    ],
    [],
    [],
  ),
}

/**
 * The archive directory names: the host's diff guard only accepts
 * `…/history/archive_00N`, so the fixture must use the server's real naming even
 * though its `memory_diff.json` bodies are keyed by timestamp.
 */
const ARCHIVES = [
  { id: 'archive_001', stamp: '20261002T071000Z', modTime: '2026-10-02T07:10:00Z' },
  { id: 'archive_002', stamp: '20261002T073000Z', modTime: '2026-10-02T07:30:00Z' },
  { id: 'archive_003', stamp: '20261002T075500Z', modTime: '2026-10-02T07:55:00Z' },
]

const search = (query) => ({
  memories: [
    { uri: MEMORY('release-checklist'), score: 0.91, context_type: 'memory', level: 2, abstract: 'Bump the version, promote the changelog section, tag, publish.' },
    { uri: MEMORY('workspace-conventions'), score: 0.78, context_type: 'memory', level: 1, abstract: 'TypeScript strict, node --test, one commit per finished piece.' },
    { uri: MEMORY('review-notes-0930'), score: 0.66, context_type: 'memory', level: 1, abstract: 'Sidebar review: the status pill moved under the composer.' },
  ],
  resources: [
    { uri: RESOURCE('plugin-manifest'), score: 0.84, context_type: 'resource', level: 1, abstract: 'What `dsh.bundle`, `dsh.client` and the patch layer mean.' },
    { uri: RESOURCE('openviking-api'), score: 0.71, context_type: 'resource', level: 1, abstract: 'Endpoints for sessions, history archives and retrieval.' },
  ],
  skills: [
    { uri: SKILL('screenshot-a-plugin'), score: 0.88, context_type: 'skill', level: 1, abstract: 'Boot a scratch profile and capture the surfaces without leaking a real workspace.' },
    { uri: SKILL('write-a-changelog'), score: 0.69, context_type: 'skill', level: 1, abstract: 'Keep a changelog: one section per release, newest first.' },
  ],
  total: 7,
  query_plan: {
    reasoning: `Recalled ${query ? `“${query}”` : 'the latest turn'} against the session's own space first, then widened to the shared resources and the skill playbooks.`,
  },
})

/** The v0.3 context face: one assembled block plus the server's accounting. */
const contextAnswer = (query) => ({
  entries: [
    { uri: MEMORY('release-checklist'), category: 'entities', score: 0.912, detail: 'overview', origin: 'self', text: 'Release checklist for the plugin: bump the version, promote the changelog section, tag, then publish the tarball.' },
    { uri: MEMORY('workspace-conventions'), category: 'entities', score: 0.781, detail: 'full', origin: 'self', text: 'TypeScript strict, node --test, one commit per finished piece of work.' },
    { uri: MEMORY('review-notes-0930'), category: 'events', score: 0.664, detail: 'abstract', origin: 'self', text: 'Sidebar review: the status pill moved under the composer.' },
    { uri: RESOURCE('plugin-manifest'), category: 'resources', score: 0.841, detail: 'overview', origin: 'self', text: 'What `dsh.bundle`, `dsh.client` and the patch layer mean.' },
    { uri: RESOURCE('openviking-api'), category: 'resources', score: 0.712, detail: 'full', origin: 'self', text: 'Endpoints for sessions, history archives and retrieval.' },
    { uri: SKILL('screenshot-a-plugin'), category: 'skills', score: 0.883, detail: 'overview', origin: 'actor_peer', text: 'Boot a scratch profile and capture the surfaces without leaking a real workspace.' },
    { uri: SKILL('write-a-changelog'), category: 'skills', score: 0.691, detail: 'uri', origin: 'actor_peer', text: 'Keep a changelog: one section per release, newest first.' },
  ],
  rendered: [
    '<openviking-context>',
    'Relevant memory from OpenViking. It is this user\'s own saved history.',
    `<memory uri="${MEMORY('release-checklist')}" type="entities" score="0.91" detail="overview">`,
    'Release checklist for the plugin: bump the version, promote the changelog section, tag, then publish the tarball.',
    '</memory>',
    `<memory uri="${MEMORY('workspace-conventions')}" type="entities" score="0.78" detail="full">`,
    'TypeScript strict, node --test, one commit per finished piece of work.',
    '</memory>',
    '</openviking-context>',
  ].join('\n'),
  digest: '',
  stats: {
    searched: { events: 18, entities: 12, preferences: 10, experiences: 0, resources: 9, skills: 1 },
    candidates: 12,
    returned: 7,
    dropped: 0,
    deduped: 2,
    excluded: 1,
    max_tokens: 1600,
    used_tokens: 1466,
    quotas: { events: 1, entities: 2, preferences: 1, experiences: 1, resources: 3, skills: 2 },
    tier_counts: { overview: 4, full: 2, abstract: 1 },
    origins: { self: 6, actor_peer: 1, other_peer: 0 },
    peer_scope: 'actor',
    planned_queries: [query || 'the latest turn', 'release process for this plugin'],
    query_expansion: 'auto',
    rewrite: 'off',
    score_threshold: 0.35,
    dedup: { turns: 5, status: 'on', cooled: 1, turn: 12 },
    fill: { floor_tokens: 1257, overview_upgrades: 0, full_upgrades: 1, spare_upgrades: 0 },
  },
})

const STUDIO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenViking Studio</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0f1115; color: #e6e8ee; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #23262e; }
  header b { font-size: 14px; font-weight: 600; }
  header span { color: #98a2b3; }
  .wrap { display: grid; grid-template-columns: 1fr 260px; height: calc(100vh - 45px); }
  .graph { position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; }
  aside { border-left: 1px solid #23262e; padding: 14px 16px; }
  aside h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #98a2b3; }
  aside li { list-style: none; margin: 0 0 6px; color: #cfd5e1; }
  aside ul { margin: 0 0 16px; padding: 0; }
  .pill { padding: 2px 8px; border-radius: 999px; background: #1b1f27; color: #b9c0cf; font-size: 11px; }
</style></head>
<body>
<header><b>OpenViking</b><span>Studio · demo space</span><span class="pill">read-only</span></header>
<div class="wrap">
  <div class="graph">
    <svg viewBox="0 0 720 480" role="img" aria-label="Knowledge graph">
      <g stroke="#2b3140" stroke-width="1.5">
        <line x1="360" y1="240" x2="180" y2="130"/><line x1="360" y1="240" x2="540" y2="140"/>
        <line x1="360" y1="240" x2="200" y2="360"/><line x1="360" y1="240" x2="520" y2="350"/>
        <line x1="180" y1="130" x2="540" y2="140"/><line x1="200" y1="360" x2="520" y2="350"/>
      </g>
      <g fill="#4c8dff"><circle cx="360" cy="240" r="16"/></g>
      <g fill="#6ea8ff"><circle cx="180" cy="130" r="11"/><circle cx="540" cy="140" r="11"/>
        <circle cx="200" cy="360" r="11"/><circle cx="520" cy="350" r="11"/></g>
      <g fill="#cfd5e1" font-size="12" text-anchor="middle">
        <text x="360" y="278">demo-session</text>
        <text x="180" y="110">release-checklist</text><text x="540" y="120">workspace-conventions</text>
        <text x="200" y="388">plugin-manifest</text><text x="520" y="378">screenshot-a-plugin</text>
      </g>
    </svg>
  </div>
  <aside>
    <h4>Entities</h4><ul><li>release-checklist</li><li>workspace-conventions</li><li>plugin-icon-rules</li><li>bilingual-copy</li></ul>
    <h4>Events</h4><ul><li>review-notes-0930</li></ul>
    <h4>Resources</h4><ul><li>plugin-manifest</li><li>openviking-api</li></ul>
    <h4>Skills</h4><ul><li>screenshot-a-plugin</li><li>write-a-changelog</li></ul>
  </aside>
</div>
</body></html>`

/* ========================================================================
 * v0.4 catalogue — invented demo content for the preview/explore surfaces.
 * ===================================================================== */

/** The server's caller-home alias; expanded to the canonical demo user. */
const HOME_ALIAS = 'viking://~'
const MEM = `${USER}/memories`
const ENTITIES = `${MEM}/entities`
const PROJECT = `${ENTITIES}/project`
const RULES_ROOT = `${MEM}/rules`
const SCENARIO_LICENSE = `${RULES_ROOT}/repository-license`
const SCENARIO_SIDEBAR = `${RULES_ROOT}/sidebar-contract`
const EXPERIENCES_ROOT = `${MEM}/experiences`
const TRAJECTORIES_ROOT = `${MEM}/trajectories`
const PREFERENCES = `${MEM}/preferences`
const RESOURCES_DSH = 'viking://resources/dsh'
const SKILLS_AGENT = 'viking://agent/skills'
const SKILL_SCREENSHOT = `${SKILLS_AGENT}/screenshot-a-plugin`
const SKILL_CHANGELOG = `${SKILLS_AGENT}/write-a-changelog`

/** Canonical form of a URI: `viking://~` → `viking://user/demo`, no trailing slash. */
function canonical(raw) {
  let uri = (raw ?? '').trim()
  if (uri.length === 0) return uri
  if (uri === HOME_ALIAS) uri = USER
  else if (uri.startsWith(`${HOME_ALIAS}/`)) uri = `${USER}${uri.slice(HOME_ALIAS.length)}`
  return uri.length > USER.length ? uri.replace(/\/+$/, '') : uri
}

const RULE_LICENSE_ACTIVE = `---
schema: openviking.rule/v1
atomic_id: project-license
revision: 1
status: active
scenario_id: repository-license
source_uris: []
evidence: []
updated_at: 2026-11-08T09:20:00+00:00
name: Project license
confidence: high
description: When a repository declares itself open source, ship the complete license text.
content: When a repository declares itself open source, it must provide the complete project license text.
applies_when: The repository README or package metadata declares an open-source license.
exception: ''
---

# Project license

Check that \`LICENSE\` contains the full text and that the README links it. A
copyright line alone is not a license text.`

const RULE_TRANSFER_PAUSED = `---
schema: openviking.rule/v1
atomic_id: transfer-license
revision: 1
status: paused
scenario_id: repository-license
source_uris: []
evidence: []
updated_at: 2026-11-08T09:24:00+00:00
name: Transfer license
confidence: medium
description: Cite the license in the transfer notice when a project changes ownership.
content: When ownership of a project transfers, restate the license in the transfer notice.
applies_when: A repository transfer or maintainer handover is announced.
exception: Internal transfers inside the same organization do not restate it.
---

# Transfer license

Restate the license verbatim in the transfer notice.`

const RULE_SIDEBAR_ACTIVE = `---
schema: openviking.rule/v1
atomic_id: sidebar-row-order
revision: 2
status: active
scenario_id: sidebar-contract
source_uris: []
evidence: []
updated_at: 2026-11-08T09:30:00+00:00
name: Sidebar row order
confidence: user
description: Always set an explicit order on sidebar rows.
content: Sidebar rows sort by an explicit order; ties fall back to registration order.
applies_when: A new row is contributed to the left or right sidebar.
exception: ''
---

# Sidebar row order

Set \`order\` when registering a row; never rely on load order.`

const SCENARIO_LICENSE_META = `---
schema: openviking.rule.scenario/v1
scenario_id: repository-license
name: Repository license
description: License compliance checks for open-source repositories.
updated_at: 2026-11-08T09:20:00+00:00
---

# Repository license

Constraints about shipping and restating project license text.`

const SCENARIO_SIDEBAR_META = `---
schema: openviking.rule.scenario/v1
scenario_id: sidebar-contract
name: Sidebar contract
description: How plugin rows register into the DSH sidebars.
updated_at: 2026-11-08T09:30:00+00:00
---

# Sidebar contract

Constraints about explicit ordering for contributed sidebar rows.`

const SKILL_SCREENSHOT_TEXT = `---
name: screenshot-a-plugin
description: Boot a scratch profile and capture the surfaces without leaking a real workspace.
allowed-tools: [read, write, bash]
---

# Screenshot a plugin

1. Install the released tarball into a throwaway \`DSH_HOME\`.
2. Point the profile at the stand-in model and the stand-in memory server.
3. Capture one scenario set at 1440x900 with a light theme, then tear the
   servers down.`

const SKILL_CHANGELOG_TEXT = `---
name: write-a-changelog
description: Keep a changelog with one section per release.
allowed-tools: [read, write]
---

# Write a changelog

One section per release, newest first; promote the unreleased section when the
version is bumped.`

const EXPERIENCE_LICENSE_TEXT = `---
schema: openviking.experience/v1
name: license-review
description: Review open-source license compliance for this repository.
created_at: 2026-10-02T07:20:00Z
updated_at: 2026-10-02T07:20:00Z
---

# License review

Apply the repository-license scenario when preparing a release: confirm the
license text, then check the README link.`

const EXPERIENCE_SIDEBAR_TEXT = `---
schema: openviking.experience/v1
name: sidebar-review
description: Keep contributed sidebar rows ordered and visible after reloads.
created_at: 2026-10-02T07:40:00Z
updated_at: 2026-10-02T07:40:00Z
---

# Sidebar review

Set an explicit order on every contributed row; verify the tab is still offered
after a window reload.`

const TRAJECTORY_LICENSE_TEXT = `---
schema: openviking.trajectory/v1
name: license_review_20261002T071500
description: Handle a release that declares the repository open source.
created_at: 2026-10-02T07:15:00Z
updated_at: 2026-10-02T07:15:00Z
---

# License review trajectory

Read README, then LICENSE; record whether the full text is present.`

const TRAJECTORY_SIDEBAR_TEXT = `---
schema: openviking.trajectory/v1
name: sidebar_review_20261002T073000
description: Move the status pill under the composer and re-register the row.
created_at: 2026-10-02T07:30:00Z
updated_at: 2026-10-02T07:30:00Z
---

# Sidebar review trajectory

The row order was implicit, so the row moved between boots; set it explicitly.`

/** Directory sidecars: L0 `abstract` and L1 `overview` per directory. */
const SIDECARS = new Map([
  [USER, {
    abstract: "The demo identity's home in this stand-in OpenViking space: memories, resources and skills.",
    overview: '# Demo home\n\n- memories/: the user\'s long-term memory\n- resources/: shared reference material\n- skills agent-scope playbooks',
  }],
  [MEM, {
    abstract: "User's long-term memory storage. Contains memory types like preferences, entities, events, managed hierarchically by type.",
    overview: "Use this directory to access the user's personalized memories. Contains three main categories: 1) preferences, 2) entities, 3) events.",
  }],
  [ENTITIES, {
    abstract: 'Durable facts about the demo project: release notes, conventions and events.',
    overview: '# Entities\n\n- project/: release checklist, workspace conventions and review notes',
  }],
  [PROJECT, {
    abstract: 'Release process notes for the plugin: versioning, changelog promotion, packing and publishing.',
    overview: '# Project overview\n\n- release-checklist.md\n- workspace-conventions.md\n- review-notes-0930.md',
  }],
  [RULES_ROOT, {
    abstract: 'Compiled read-only Rules for this identity, one scenario directory per rule group.',
    overview: '# Rules\n\n- repository-license/: license compliance\n- sidebar-contract/: contributed row ordering',
  }],
  [SCENARIO_LICENSE, {
    abstract: 'License compliance constraints: ship and restate the complete project license text.',
    overview: '# Repository license\n\n- project-license.md (active)\n- transfer-license.md (paused)',
  }],
  [SCENARIO_SIDEBAR, {
    abstract: 'Constraints for contributed DSH sidebar rows: always register an explicit order.',
    overview: '# Sidebar contract\n\n- sidebar-row-order.md (active)',
  }],
  [EXPERIENCES_ROOT, {
    abstract: 'Experiences distilled from reviewed commits: what worked and what failed.',
    overview: '# Experiences\n\n- license-review.md\n- sidebar-review.md',
  }],
  [TRAJECTORIES_ROOT, {
    abstract: 'Trajectories produced by commits that referenced an Experience file.',
    overview: '# Trajectories\n\n- license_review_20261002T071500.md\n- sidebar_review_20261002T073000.md',
  }],
  [RESOURCES_DSH, {
    abstract: 'Reference material for the DSH plugin: manifest fields and OpenViking HTTP endpoints.',
    overview: '# DSH references\n\n- plugin-manifest.md\n- openviking-api.md',
  }],
  [SKILLS_AGENT, {
    abstract: 'Installed skill playbooks available to this identity.',
    overview: '# Skills\n\n- screenshot-a-plugin/\n- write-a-changelog/',
  }],
  [SKILL_SCREENSHOT, {
    abstract: 'Boot a scratch profile and capture the plugin surfaces without leaking a real workspace.',
    overview: '# Screenshot a plugin\n\nScratch home, stand-in model, stand-in memory server, one capture set.',
  }],
  [SKILL_CHANGELOG, {
    abstract: 'Keep a changelog with one section per release, newest first.',
    overview: '# Write a changelog\n\nOne section per release; promote the unreleased section on bump.',
  }],
])

/** The directory whose sidecars were never generated (preview "not ready" path). */
const NOT_GENERATED_DIR = PREFERENCES

/**
 * One known entry: its metadata, context face and — for the v0.4-only readable
 * families — its text body. v0.3-era file URIs deliberately carry no `text` so
 * `content/read` keeps answering exactly what the released build saw (404).
 */
const STAT = new Map()
const addFile = (uri, { size, modTime, contextType = 'memory', tags = [], memory = {}, text, abstract }) => {
  STAT.set(uri, {
    uri,
    name: uri.slice(uri.lastIndexOf('/') + 1),
    size,
    mode: 420,
    modTime,
    isDir: false,
    contextType,
    tags,
    memory,
    text,
    abstract,
  })
}
const addDir = (uri, { modTime, count, contextType = 'memory', tags = [] }) => {
  STAT.set(uri, {
    uri,
    name: uri.slice(uri.lastIndexOf('/') + 1) || 'demo',
    size: 0,
    mode: 493,
    modTime,
    isDir: true,
    count,
    contextType,
    tags,
    memory: {},
  })
}

addDir(USER, { modTime: '2026-10-02T07:00:00Z', count: 108 })
addDir(MEM, { modTime: '2026-10-02T07:00:00Z', count: 108 })
addDir(ENTITIES, { modTime: '2026-10-02T07:00:00Z', count: 3 })
addDir(PROJECT, { modTime: '2026-10-02T07:10:00Z', count: 3 })
addDir(PREFERENCES, { modTime: '2026-10-02T07:00:00Z', count: 2 })
addDir(RULES_ROOT, { modTime: '2026-11-08T09:30:00Z', count: 2 })
addDir(SCENARIO_LICENSE, { modTime: '2026-11-08T09:24:00Z', count: 3 })
addDir(SCENARIO_SIDEBAR, { modTime: '2026-11-08T09:30:00Z', count: 2 })
addDir(EXPERIENCES_ROOT, { modTime: '2026-10-02T07:40:00Z', count: 2 })
addDir(TRAJECTORIES_ROOT, { modTime: '2026-10-02T07:30:00Z', count: 2 })
addDir(RESOURCES_DSH, { modTime: '2026-10-01T09:05:00Z', count: 2, contextType: 'resource', tags: ['topic=dsh'] })
addDir(SKILLS_AGENT, { modTime: '2026-10-01T08:05:00Z', count: 2, contextType: 'skill' })
addDir(SKILL_SCREENSHOT, { modTime: '2026-10-01T08:00:00Z', count: 1, contextType: 'skill' })
addDir(SKILL_CHANGELOG, { modTime: '2026-10-01T08:05:00Z', count: 1, contextType: 'skill' })

addFile(MEMORY('release-checklist'), {
  size: 148,
  modTime: '2026-10-02T07:10:00Z',
  tags: ['team=demo', 'project=release'],
  memory: { memory_type: 'entity', category: 'release' },
  text: [
    'Release checklist for the plugin.',
    '',
    '1. Bump the version and promote the changelog section.',
    '2. Rebuild the bundled client half, then pack the tarball.',
    '3. Tag the release and push the tag with the commit.',
    '4. Publish the artifact and verify it installs into a clean profile.',
  ].join('\n'),
})
addFile(MEMORY('workspace-conventions'), {
  size: 112,
  modTime: '2026-10-02T07:12:00Z',
  tags: ['team=demo'],
  memory: { memory_type: 'entity', category: 'conventions' },
  text: [
    'Workspace conventions',
    '',
    '- TypeScript strict everywhere.',
    '- Unit tests through `node --test`.',
    '- One commit per finished piece of work.',
  ].join('\n'),
})
addFile(MEMORY('review-notes-0930'), {
  size: 96,
  modTime: '2026-10-02T07:14:00Z',
  tags: ['team=demo', 'kind=review'],
  memory: { memory_type: 'event', category: 'review' },
  text: [
    'Reviewed the sidebar layout with the team.',
    'The status pill moved under the composer; the right sidebar rows kept',
    'their explicit order after a window reload.',
  ].join('\n'),
})
addFile(RESOURCE('plugin-manifest'), {
  size: 204,
  modTime: '2026-10-01T09:00:00Z',
  contextType: 'resource',
  tags: ['topic=dsh'],
  memory: { memory_type: 'resource' },
  text: [
    '# The plugin manifest',
    '',
    '- `dsh.bundle.patch` inserts this plugin into the profile roster.',
    '- `dsh.client` declares the browser half and the seats it fills.',
    '- The host half exports the read-only OpenViking HTTP routes.',
  ].join('\n'),
})
addFile(RESOURCE('openviking-api'), {
  size: 258,
  modTime: '2026-10-01T09:05:00Z',
  contextType: 'resource',
  tags: ['topic=dsh'],
  memory: { memory_type: 'resource' },
  text: [
    '# OpenViking HTTP endpoints used by this plugin',
    '',
    '- `/api/v1/sessions/<id>` — session metadata and commit accounting.',
    '- `/api/v1/fs/ls`, `/fs/stat`, `/content/read` — the diff/history reads.',
    '- `/api/v1/search/search` — session-aware retrieval (and the Explore search).',
    '- `/api/v1/fs/attrs`, `/content/abstract`, `/content/overview` — the preview facets.',
  ].join('\n'),
})
// v0.3-era skill hit URIs: known metadata, but not readable (parity with the
// released build's 404 on content/read).
addFile(SKILL('screenshot-a-plugin'), {
  size: 512,
  modTime: '2026-10-01T08:00:00Z',
  contextType: 'skill',
  memory: { memory_type: 'skill' },
  text: SKILL_SCREENSHOT_TEXT,
})
addFile(SKILL('write-a-changelog'), {
  size: 344,
  modTime: '2026-10-01T08:05:00Z',
  contextType: 'skill',
  memory: { memory_type: 'skill' },
  text: SKILL_CHANGELOG_TEXT,
})
addFile(`${SKILL_SCREENSHOT}/SKILL.md`, {
  size: 512,
  modTime: '2026-10-01T08:00:00Z',
  contextType: 'skill',
  tags: ['capture'],
  memory: { memory_type: 'skill' },
  text: SKILL_SCREENSHOT_TEXT,
})
addFile(`${SKILL_CHANGELOG}/SKILL.md`, {
  size: 344,
  modTime: '2026-10-01T08:05:00Z',
  contextType: 'skill',
  tags: ['release'],
  memory: { memory_type: 'skill' },
  text: SKILL_CHANGELOG_TEXT,
})
addFile(`${SCENARIO_LICENSE}/abstract.md`, {
  size: 320,
  modTime: '2026-11-08T09:20:00Z',
  tags: ['scenario=repository-license'],
  memory: { memory_type: 'rule-scenario' },
  text: SCENARIO_LICENSE_META,
})
addFile(`${SCENARIO_LICENSE}/project-license.md`, {
  size: 780,
  modTime: '2026-11-08T09:20:00Z',
  tags: ['rule=project-license'],
  memory: { memory_type: 'rule' },
  text: RULE_LICENSE_ACTIVE,
})
addFile(`${SCENARIO_LICENSE}/transfer-license.md`, {
  size: 620,
  modTime: '2026-11-08T09:24:00Z',
  tags: ['rule=transfer-license'],
  memory: { memory_type: 'rule' },
  text: RULE_TRANSFER_PAUSED,
})
addFile(`${SCENARIO_SIDEBAR}/abstract.md`, {
  size: 260,
  modTime: '2026-11-08T09:30:00Z',
  tags: ['scenario=sidebar-contract'],
  memory: { memory_type: 'rule-scenario' },
  text: SCENARIO_SIDEBAR_META,
})
addFile(`${SCENARIO_SIDEBAR}/sidebar-row-order.md`, {
  size: 700,
  modTime: '2026-11-08T09:30:00Z',
  tags: ['rule=sidebar-row-order'],
  memory: { memory_type: 'rule' },
  text: RULE_SIDEBAR_ACTIVE,
})
addFile(`${EXPERIENCES_ROOT}/license-review.md`, {
  size: 420,
  modTime: '2026-10-02T07:20:00Z',
  tags: ['experience=license-review'],
  memory: { memory_type: 'experience' },
  text: EXPERIENCE_LICENSE_TEXT,
  abstract: 'Review open-source license compliance for this repository.',
})
addFile(`${EXPERIENCES_ROOT}/sidebar-review.md`, {
  size: 380,
  modTime: '2026-10-02T07:40:00Z',
  tags: ['experience=sidebar-review'],
  memory: { memory_type: 'experience' },
  text: EXPERIENCE_SIDEBAR_TEXT,
  abstract: 'Keep contributed sidebar rows ordered and visible after reloads.',
})
addFile(`${TRAJECTORIES_ROOT}/license_review_20261002T071500.md`, {
  size: 360,
  modTime: '2026-10-02T07:15:00Z',
  tags: ['experience=license-review'],
  memory: { memory_type: 'trajectory' },
  text: TRAJECTORY_LICENSE_TEXT,
})
addFile(`${TRAJECTORIES_ROOT}/sidebar_review_20261002T073000.md`, {
  size: 340,
  modTime: '2026-10-02T07:30:00Z',
  tags: ['experience=sidebar-review'],
  memory: { memory_type: 'trajectory' },
  text: TRAJECTORY_SIDEBAR_TEXT,
})

/** Children of every known directory, derived from the entries above. */
const CHILDREN = new Map()
const parentOf = (uri) => {
  const cut = uri.lastIndexOf('/')
  return cut === -1 ? '' : uri.slice(0, cut)
}
for (const uri of STAT.keys()) {
  const parent = parentOf(uri)
  if (!CHILDREN.has(parent)) CHILDREN.set(parent, [])
  CHILDREN.get(parent).push(uri)
}
for (const children of CHILDREN.values()) children.sort()

/* ========================================================================
 * v0.5 stateful mock — the F9/F10/F11/F12 write and control endpoints.
 *
 * The store is an in-memory copy of the invented catalogue above: writes mutate
 * it, snapshots capture it, and restore really undoes the mutations. Nothing
 * here ever touches a real store; the process is the whole persistence layer.
 * ===================================================================== */

/** Live entries. Initialised from the v0.4 catalogue so reads stay identical. */
const STORE = new Map()
for (const [uri, entry] of STAT) {
  STORE.set(uri, {
    ...entry,
    tags: [...entry.tags],
    memory: { ...entry.memory },
  })
}

// v0.6 evidence-only entries (behind the env flags above). They are added after
// the store is copied, so the default (flags-off) responses are byte-identical
// to the frozen v0.5 fixture.
if (LONG_L2) {
  const text = longL2Body()
  const LONG_L2_URI = longL2Uri()
  STORE.set(LONG_L2_URI, {
    uri: LONG_L2_URI,
    name: 'release-history.md',
    size: Buffer.byteLength(text),
    mode: 420,
    modTime: '2026-11-08T10:00:00Z',
    isDir: false,
    contextType: 'memory',
    tags: ['team=demo', 'kind=history'],
    memory: { memory_type: 'entity', category: 'release' },
    text,
    abstract: 'A long invented release log used to exercise the paged L2 preview.',
  })
}
if (RULES_STALL) {
  for (const rule of extraStallRules()) {
    STORE.set(rule.uri, {
      uri: rule.uri,
      name: rule.uri.slice(rule.uri.lastIndexOf('/') + 1),
      size: Buffer.byteLength(rule.text),
      mode: 420,
      modTime: rule.modTime,
      isDir: false,
      contextType: 'memory',
      tags: ['rule=stall'],
      memory: { memory_type: 'rule' },
      text: rule.text,
    })
  }
}

// v0.7 evidence-only data (behind OV_FIXTURE_NATIVE). New directories only:
// no pre-v0.7 response changes, and the compat gate runs with the flag unset.
if (NATIVE) {
  const root = (uri, modTime) =>
    STORE.set(uri, {
      uri,
      name: uri.slice(uri.lastIndexOf('/') + 1),
      size: 0,
      mode: 493,
      modTime,
      isDir: true,
      count: 0,
      contextType: 'memory',
      tags: [],
      memory: {},
    })
  const file = (uri, text, modTime, extra = {}) =>
    STORE.set(uri, {
      uri,
      name: uri.slice(uri.lastIndexOf('/') + 1),
      size: Buffer.byteLength(text),
      mode: 420,
      modTime,
      isDir: false,
      contextType: 'memory',
      tags: extra.tags ?? [],
      memory: extra.memory ?? { memory_type: 'entity' },
      text,
      abstract: extra.abstract ?? '',
    })
  const setOnce = (uri, modTime) => {
    if (!STORE.has(uri)) root(uri, modTime)
  }
  // The sessions directory: 9 DSH sessions (newest first), one local-harness
  // session and one unknown session, plus the released v0.3 dated directory.
  setOnce(`${USER}/sessions`, '2026-11-10T09:00:00Z')
  NATIVE_DSH_SESSIONS.forEach((sessionId, index) => {
    const stamp = new Date(Date.UTC(2026, 10, 10, 9, 30 - index, 0)).toISOString().replace('.000Z', 'Z')
    setOnce(`${USER}/sessions/dsh-${sessionId}`, stamp)
  })
  setOnce(`${USER}/sessions/local-studio-archived-9c8b7a`, '2026-11-10T08:10:00Z')
  setOnce(`${USER}/sessions/peer-feedface-session`, '2026-11-10T08:05:00Z')
  // Browse roots that the released fixture had no data for: peers and the
  // personal resource/skill scopes.
  setOnce(`${USER}/peers`, '2026-11-10T08:00:00Z')
  setOnce(`${USER}/peers/demo-peer`, '2026-11-09T17:00:00Z')
  if (!STORE.has(`${USER}/peers/demo-peer/peer-note.md`)) {
    file(
      `${USER}/peers/demo-peer/peer-note.md`,
      '# Peer note\n\nShared memory read from a peer scope: the demo peer keeps its release notes here.',
      '2026-11-09T17:00:00Z',
      { tags: ['peer=demo', 'kind=note'], memory: { memory_type: 'entity', category: 'peers' }, abstract: 'Peer-scope note used by the v0.7 Browse evidence.' },
    )
  }
  setOnce(`${USER}/resources`, '2026-11-10T08:00:00Z')
  if (!STORE.has(`${USER}/resources/personal-checklist.md`)) {
    file(
      `${USER}/resources/personal-checklist.md`,
      '# Personal resource\n\nA personal resource entry used by the v0.7 Browse evidence.',
      '2026-11-08T12:00:00Z',
      { tags: ['scope=personal'], memory: { memory_type: 'resource' }, abstract: 'Personal resource used by the v0.7 Browse evidence.' },
    )
  }
  setOnce(`${USER}/skills`, '2026-11-10T08:00:00Z')
  if (!STORE.has(`${USER}/skills/personal-skill.md`)) {
    file(
      `${USER}/skills/personal-skill.md`,
      '# Personal skill\n\nA personal skill entry used by the v0.7 Browse evidence.',
      '2026-11-08T11:00:00Z',
      { tags: ['scope=personal'], memory: { memory_type: 'skill' }, abstract: 'Personal skill used by the v0.7 Browse evidence.' },
    )
  }
}

/** Direct children of a store directory, sorted (recomputed on every read). */
function childrenOf(dirUri) {
  const out = []
  for (const uri of STORE.keys()) if (parentOf(uri) === dirUri) out.push(uri)
  return out.sort()
}

/** Touch one entry: length + mtime follow the body. */
function touched(entry) {
  entry.size = Buffer.byteLength(entry.text ?? '')
  entry.modTime = new Date().toISOString()
  return entry
}

/** Create any missing directory ancestors of a URI (writes create parents). */
function ensureParents(uri) {
  let dir = parentOf(uri)
  while (dir.length > USER.length && !STORE.has(dir)) {
    STORE.set(dir, {
      uri: dir,
      name: dir.slice(dir.lastIndexOf('/') + 1),
      size: 0,
      mode: 493,
      modTime: new Date().toISOString(),
      isDir: true,
      count: 0,
      contextType: 'memory',
      tags: [],
      memory: {},
    })
    dir = parentOf(dir)
  }
}

/** One placeholder failure body, envelope-style. */
const failure = (code, messageText, details) => ({ status: 'error', result: null, error: details === undefined ? { code, message: messageText } : { code, message: messageText, details } })

/** Normalise a snapshot path (accepts a file or directory URI). */
function snapshotPath(raw) {
  const uri = canonical(raw)
  return uri.length > 1 ? uri.replace(/\/+$/, '') : uri
}

/** Whether a store URI is inside the given snapshot paths (prefix match). */
function underPaths(uri, paths) {
  return paths.some((raw) => {
    const prefix = snapshotPath(raw)
    return uri === prefix || uri.startsWith(`${prefix}/`)
  })
}

/** Deep copy of the store (the snapshot tree). */
const snapshotTree = () =>
  new Map(
    [...STORE.entries()].map(([uri, entry]) => [
      uri,
      { ...entry, tags: [...entry.tags], memory: { ...entry.memory } },
    ]),
  )

/** Newest-first snapshot commits; the mock never prunes them. */
const SNAPSHOTS = []
let HEAD_OID = null

const hexOid = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)

function sameStoreEntry(a, b) {
  if (a === undefined || b === undefined) return false
  return (
    a.isDir === b.isDir &&
    (a.text ?? null) === (b.text ?? null) &&
    (a.size ?? 0) === (b.size ?? 0) &&
    a.contextType === b.contextType &&
    JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? [])
  )
}

/** Commit the current store (optionally scoped to paths) as a snapshot. */
function commitSnapshot(message, paths) {
  const scope = Array.isArray(paths) && paths.length > 0 ? paths.map(snapshotPath) : null
  const inScope = (uri) => (scope === null ? true : underPaths(uri, scope))
  const headTree = HEAD_OID === null ? new Map() : SNAPSHOTS.find((snap) => snap.oid === HEAD_OID).tree
  let changed = 0
  for (const [uri, entry] of STORE) {
    if (!inScope(uri)) continue
    if (!sameStoreEntry(entry, headTree.get(uri))) changed += 1
  }
  for (const uri of headTree.keys()) if (inScope(uri) && !STORE.has(uri)) changed += 1
  if (changed === 0 && HEAD_OID !== null) return { result: 'noop', commit_oid: HEAD_OID, changed: 0, ignored: 0 }
  const oid = hexOid()
  SNAPSHOTS.unshift({
    oid,
    tree: snapshotTree(),
    message: message || 'mock snapshot',
    time: Math.floor(Date.now() / 1000),
    parent: HEAD_OID,
  })
  HEAD_OID = oid
  return { result: 'created', commit_oid: oid, changed, ignored: 0 }
}

/** Restore a directory scope from a snapshot (dry-run and applied modes). */
function restoreSnapshot(projectDir, sourceCommit, dryRun) {
  const dir = snapshotPath(projectDir)
  const source = SNAPSHOTS.find((snap) => snap.oid === sourceCommit)
  if (source === undefined) return { error: failure('NOT_FOUND', `Commit not found: ${sourceCommit}`, { type: 'git_commit', resource: sourceCommit }) }
  const headTree = HEAD_OID === null ? new Map() : SNAPSHOTS.find((snap) => snap.oid === HEAD_OID).tree
  const toWrite = []
  const toDelete = []
  let unchanged = 0
  for (const [uri, entry] of source.tree) {
    if (!underPaths(uri, [dir])) continue
    if (sameStoreEntry(entry, headTree.get(uri))) unchanged += 1
    else toWrite.push({ path: uri, oid: hexOid() })
  }
  for (const uri of headTree.keys()) {
    if (!underPaths(uri, [dir])) continue
    if (!source.tree.has(uri)) toDelete.push({ path: uri, oid: hexOid() })
  }
  if (dryRun) {
    return {
      status: 'ok',
      result: { result: 'dry_run', head: HEAD_OID, source: sourceCommit, diff: { to_write: toWrite, to_delete: toDelete, unchanged } },
    }
  }
  const parentCommit = HEAD_OID
  for (const item of toDelete) STORE.delete(item.path)
  for (const item of toWrite) {
    const sourceEntry = source.tree.get(item.path)
    STORE.set(item.path, { ...sourceEntry, tags: [...sourceEntry.tags], memory: { ...sourceEntry.memory } })
  }
  const commit = commitSnapshot(`restore ${dir} to ${sourceCommit}`, [dir])
  const task = createTask({
    taskType: 'snapshot_restore_reindex',
    resourceId: dir,
    status: 'running',
    stage: 'reindex',
    settleMs: 2500,
    result: { reindexed: toWrite.length + toDelete.length, restored_paths: toWrite.map((item) => item.path) },
  })
  return {
    status: 'ok',
    result: {
      result: 'applied',
      new_commit_oid: commit.commit_oid,
      parent_commit: parentCommit,
      source_commit: sourceCommit,
      written: toWrite.length,
      deleted: toDelete.length,
      unchanged,
      written_paths: toWrite.map((item) => item.path),
      deleted_paths: toDelete.map((item) => item.path),
      task_id: task.task_id,
    },
  }
}

/* ---------------------------- task mock -------------------------------- */

const TASKS = new Map()
const nowSeconds = () => Date.now() / 1000

/** Register a task; `settleMs` later it reads as completed (for polling shots). */
function createTask({ taskId, taskType, resourceId, status = 'completed', stage = 'done', settleMs = 0, result = null, error = null, events = [] }) {
  const id = taskId ?? `task_${randomUUID().slice(0, 8)}`
  const createdAt = nowSeconds()
  const task = {
    task_id: id,
    task_type: taskType,
    status,
    stage,
    created_at: createdAt,
    updated_at: createdAt,
    processing_seconds: status === 'completed' ? 2 : undefined,
    resource_id: resourceId ?? '',
    meta: {},
    result: result ?? undefined,
    error: error ?? null,
    settle_at: settleMs > 0 ? Date.now() + settleMs : 0,
    events,
  }
  TASKS.set(id, task)
  return task
}

/** A task's live status: a running task settles to completed after its delay. */
function taskView(task) {
  if (task.status === 'running' && task.settle_at > 0 && Date.now() >= task.settle_at) {
    task.status = 'completed'
    task.stage = 'done'
    task.updated_at = nowSeconds()
    task.processing_seconds = Math.max(1, Math.round((Date.now() - task.created_at * 1000) / 1000))
  }
  const view = {
    task_id: task.task_id,
    task_type: task.task_type,
    status: task.status,
    stage: task.stage,
    created_at: task.created_at,
    updated_at: task.updated_at,
    processing_seconds: task.processing_seconds,
    resource_id: task.resource_id,
    meta: task.meta,
    result: task.result,
    error: task.error,
  }
  return view
}

/** Execution events for the detail view (capped like the real server). */
function taskEvents(task) {
  const seed = task.events.length > 0 ? task.events : [{ kind: 'created', status: 'pending', stage: 'queued' }]
  return {
    items: seed.map((event, index) => ({
      seq: index + 1,
      recorded_at: task.created_at + index,
      kind: event.kind,
      status: event.status ?? task.status,
      stage: event.stage ?? task.stage,
      operation: event.operation ?? null,
      error: event.error ?? null,
    })),
    dropped_count: 0,
    started_mid_task: false,
  }
}

// Seed the Activity tab with a realistic mix: a completed session commit, a
// failed compile, a cancellable resource import and a finished reindex.
createTask({
  taskId: 'task_demo_003',
  taskType: 'session_commit',
  status: 'completed',
  stage: 'extract',
  resourceId: 'dsh-session-47a8cdea-8bbd-42c5-8150-b8676f8b86e7',
  result: {
    session_id: 'dsh-session-47a8cdea-8bbd-42c5-8150-b8676f8b86e7',
    archive_uri: `${USER}/sessions/2026-10-02/demo-session/history/archive_003`,
    memories_extracted: { memory_write: 7, memory_edit: 2 },
    token_usage: { total: { input: 1843, output: 96 } },
  },
  events: [
    { kind: 'created', status: 'pending', stage: 'queued' },
    { kind: 'status_changed', status: 'running', stage: 'archive' },
    { kind: 'stage_changed', status: 'running', stage: 'extract' },
    { kind: 'status_changed', status: 'completed', stage: 'extract' },
  ],
})
createTask({
  taskId: 'task_compile_002',
  taskType: 'compile',
  status: 'failed',
  stage: 'extract',
  resourceId: 'viking://resources/dsh',
  error: { code: 'MODEL_UNAVAILABLE', message: 'The configured summary model was unavailable; the compile batch was not retried.', details: {} },
  events: [
    { kind: 'created', status: 'pending', stage: 'queued' },
    { kind: 'status_changed', status: 'running', stage: 'extract' },
    { kind: 'error_recorded', status: 'failed', stage: 'extract', operation: 'compile_batch' },
  ],
})
createTask({
  taskId: 'task_resource_004',
  taskType: 'add_resource',
  status: 'running',
  stage: 'index',
  resourceId: 'viking://resources/dsh/openviking-api.md',
  settleMs: 86_400_000,
  events: [
    { kind: 'created', status: 'pending', stage: 'queued' },
    { kind: 'status_changed', status: 'running', stage: 'index' },
  ],
})
createTask({
  taskId: 'task_reindex_001',
  taskType: 'snapshot_restore_reindex',
  status: 'completed',
  stage: 'reindex',
  resourceId: `${USER}/memories/entities/project`,
  result: { reindexed: 2 },
})

/** A JSON listing entry as `fs/ls` returns it (`output=agent` shape). */
function listingEntry(uri) {
  const entry = STORE.get(uri)
  return {
    uri: entry.uri,
    size: entry.isDir ? 0 : entry.size,
    isDir: entry.isDir,
    modTime: entry.modTime,
    abstract: entry.isDir
      ? (SIDECARS.get(entry.uri)?.abstract ?? '')
      : (entry.abstract ?? ''),
  }
}

/** The L0/L1 sidecar for a file (its directory's) or a directory (its own). */
function sidecarFor(uri) {
  const canonicalUri = canonical(uri)
  const entry = STORE.get(canonicalUri)
  if (entry === undefined) return null
  const dir = entry.isDir ? canonicalUri : parentOf(canonicalUri)
  if (dir === NOT_GENERATED_DIR) {
    return {
      abstract: `# ${dir} [Directory abstract is not ready]`,
      overview: `# ${dir}\n\n[Directory overview is not ready]`,
      notGenerated: true,
    }
  }
  const sidecar = SIDECARS.get(dir)
  if (sidecar === undefined) return null
  return { abstract: sidecar.abstract, overview: sidecar.overview, notGenerated: false }
}

/** The Explore list-mode body: three buckets with tags, no session scoping. */
const searchList = () => ({
  memories: [
    { uri: MEMORY('release-checklist'), score: 0.91, context_type: 'memory', level: 2, abstract: 'Bump the version, promote the changelog section, tag, publish.', tags: ['team=demo', 'project=release'] },
    { uri: MEMORY('workspace-conventions'), score: 0.78, context_type: 'memory', level: 1, abstract: 'TypeScript strict, node --test, one commit per finished piece.', tags: ['team=demo'] },
    { uri: MEMORY('review-notes-0930'), score: 0.66, context_type: 'memory', level: 1, abstract: 'Sidebar review: the status pill moved under the composer.', tags: ['kind=review'] },
  ],
  resources: [
    { uri: RESOURCE('plugin-manifest'), score: 0.84, context_type: 'resource', level: 1, abstract: 'What `dsh.bundle`, `dsh.client` and the patch layer mean.', tags: ['topic=dsh'] },
    { uri: RESOURCE('openviking-api'), score: 0.71, context_type: 'resource', level: 1, abstract: 'Endpoints for sessions, history archives and retrieval.', tags: ['topic=dsh'] },
  ],
  skills: [
    { uri: `${SKILL_SCREENSHOT}/SKILL.md`, score: 0.88, context_type: 'skill', level: 1, abstract: 'Boot a scratch profile and capture the surfaces without leaking a real workspace.', tags: ['capture'] },
    { uri: `${SKILL_CHANGELOG}/SKILL.md`, score: 0.69, context_type: 'skill', level: 1, abstract: 'Keep a changelog: one section per release, newest first.', tags: ['release'] },
  ],
  total: 7,
})

/** The Doctor probe's task context: keep the released build's empty-library body. */
const DOCTOR_RULE_PROBE = 'OpenViking plugin doctor: check whether the Rule search capability is available.'
const emptyRuleSearch = () => ({
  rules: [],
  scenarios: [],
  rendered: '# Applicable OpenViking Rules\n\nMatched 0 active Rule(s).',
  delivery: { complete: true, rule_count: 0 },
  warning: 'rule library is empty',
})

/** A matched-rule reply for the F8 tester / Explore rules bucket. */
const matchedRuleSearch = () => ({
  rules: [
    {
      atomic_id: 'project-license',
      revision: 1,
      scenario_id: 'repository-license',
      probability: 0.93,
      uri: `${SCENARIO_LICENSE}/project-license.md`,
      content: RULE_LICENSE_ACTIVE,
    },
    {
      atomic_id: 'sidebar-row-order',
      revision: 2,
      scenario_id: 'sidebar-contract',
      probability: 0.71,
      uri: `${SCENARIO_SIDEBAR}/sidebar-row-order.md`,
      content: RULE_SIDEBAR_ACTIVE,
    },
  ],
  scenarios: ['repository-license', 'sidebar-contract'],
  rendered: [
    '# Applicable OpenViking Rules',
    '',
    'These Rules are behavioral constraints.',
    '',
    'Matched 2 active Rule(s).',
    '',
    '## [project-license] Project license',
    '',
    'Constraint: When a repository declares itself open source, it must provide the complete project license text.',
    'Applies when: The repository README or package metadata declares an open-source license.',
  ].join('\n'),
  delivery: { complete: true, rule_count: 2, rendered_chars: 412 },
})

/** The old v0.3 skills body: exactly what the released surfaces consumed. */
const legacySkills = () => ({
  root_uris: [`${USER}/skills`, 'viking://agent/skills'],
  skills: [
    { type: 'skill', name: 'screenshot-a-plugin', uri: `${USER}/skills/screenshot-a-plugin`, description: 'Capture a plugin without leaking a real workspace.' },
    { type: 'skill', name: 'write-a-changelog', uri: `${USER}/skills/write-a-changelog`, description: 'Keep a changelog with one section per release.' },
  ],
})

/** The v0.4 skill catalogue body (only asked for when node_limit > 1). */
const enrichedSkills = () => ({
  root_uris: [`${USER}/skills`, 'viking://agent/skills'],
  skills: [
    {
      type: 'skill',
      name: 'screenshot-a-plugin',
      uri: SKILL_SCREENSHOT,
      root_uri: SKILL_SCREENSHOT,
      skill_md_uri: `${SKILL_SCREENSHOT}/SKILL.md`,
      description: 'Boot a scratch profile and capture the surfaces without leaking a real workspace.',
      tags: ['capture'],
      allowed_tools: ['read', 'write', 'bash'],
    },
    {
      type: 'skill',
      name: 'write-a-changelog',
      uri: SKILL_CHANGELOG,
      root_uri: SKILL_CHANGELOG,
      skill_md_uri: `${SKILL_CHANGELOG}/SKILL.md`,
      description: 'Keep a changelog: one section per release, newest first.',
      tags: ['release'],
      allowed_tools: ['read', 'write'],
    },
  ],
  total: 2,
})

const TRAJECTORIES = new Map([
  [`${EXPERIENCES_ROOT}/license-review.md`, [
    {
      uri: `${TRAJECTORIES_ROOT}/license_review_20261002T071500.md`,
      name: 'license_review_20261002T071500.md',
      description: 'Handle a release that declares the repository open source.',
      created_at: '2026-10-02T07:15:00Z',
      updated_at: '2026-10-02T07:15:00Z',
    },
  ]],
  [`${EXPERIENCES_ROOT}/sidebar-review.md`, [
    {
      uri: `${TRAJECTORIES_ROOT}/sidebar_review_20261002T073000.md`,
      name: 'sidebar_review_20261002T073000.md',
      description: 'Move the status pill under the composer and re-register the row.',
      created_at: '2026-10-02T07:30:00Z',
      updated_at: '2026-10-02T07:30:00Z',
    },
  ]],
])

const OUTCOMES = new Map([
  [`${EXPERIENCES_ROOT}/license-review.md`, [
    { outcome: 'success', count: 4 },
    { outcome: 'failure', count: 1 },
    { outcome: 'partial', count: 0 },
    { outcome: 'unknown', count: 0 },
    { outcome: 'unfinished', count: 0 },
  ]],
  [`${EXPERIENCES_ROOT}/sidebar-review.md`, [
    { outcome: 'success', count: 3 },
    { outcome: 'failure', count: 0 },
    { outcome: 'partial', count: 1 },
    { outcome: 'unknown', count: 0 },
    { outcome: 'unfinished', count: 0 },
  ]],
])

/**
 * Read one JSON request body. The write endpoints come back through
 * `res` themselves; a malformed body is the caller's problem (400), never a
 * process exception.
 */
function withJsonBody(req, res, handle) {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 256 * 1024) req.destroy()
  })
  req.on('end', () => {
    let parsed = null
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object') {
      return json(res, failure('INVALID_ARGUMENT', 'request body must be a JSON object'), 400)
    }
    handle(parsed)
  })
}

/** Newest-first human timestamp helper for mock commit metadata. */
const commitAuthor = (time) => ({ name: 'OpenViking demo', email: 'demo@example.invalid', time_seconds: time, tz_offset_seconds: 0 })

/** A naive unified diff for the snapshot diff endpoint (mock fidelity only). */
function mockUnifiedDiff(path, fromText, toText) {
  const from = (fromText ?? '').split('\n')
  const to = (toText ?? '').split('\n')
  let prefix = 0
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = from.slice(prefix, from.length - suffix)
  const added = to.slice(prefix, to.length - suffix)
  const header = `--- a/${path}\n+++ b/${path}\n@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@\n`
  return header + removed.map((line) => `-${line}`).join('\n') + (removed.length > 0 && added.length > 0 ? '\n' : '') + added.map((line) => `+${line}`).join('\n')
}

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // Present on every real OpenViking response; the plugin correlates audit
    // entries with it. Adding the header does not change any response body.
    'x-request-id': randomUUID(),
  })
  res.end(payload)
}

/** The server's own failure envelope, with the `error.details` the host keys on. */
const jsonError = (res, status, code, messageText, details) =>
  json(res, { status: 'error', result: null, error: details === undefined ? { code, message: messageText } : { code, message: messageText, details } }, status)

/** Slice stored text by the documented line-wise `offset`/`limit` parameters. */
function pageText(text, offsetRaw, limitRaw) {
  const offset = Number(offsetRaw ?? '0')
  const limit = Number(limitRaw ?? '-1')
  if (!Number.isFinite(offset) || offset <= 0) {
    if (!Number.isFinite(limit) || limit < 0) return text
  }
  const lines = text.split('\n')
  const from = Number.isFinite(offset) && offset > 0 ? offset : 0
  const count = Number.isFinite(limit) && limit >= 0 ? limit : lines.length - from
  return lines.slice(from, from + count).join('\n')
}

// v0.8 evidence-only data (behind OV_FIXTURE_OPS). Seeded after the store copy
// so default (flags-off) responses stay byte-identical.
if (OPS_MODE) {
  // One compile-managed output file with version history, plus a stable memory
  // body we can revise between commits so the snapshot list has a real diff.
  STORE.set(COMPILE_OUTPUT_URI, {
    uri: COMPILE_OUTPUT_URI,
    name: 'dsh-plugin.mdc',
    size: 96,
    mode: 420,
    modTime: '2026-11-08T10:00:00Z',
    isDir: false,
    contextType: 'resource',
    tags: ['compile=managed'],
    memory: { memory_type: 'resource' },
    text: '# Compiled plugin contract\n\nGenerated by the OpenViking compile pipeline for the v0.8 evidence fixture.',
    abstract: 'Compile-managed output used by the v0.8 version-history evidence.',
  })
  // Baseline history: three commits so the Snapshots view has rows, parents and
  // a restorable source commit.
  commitSnapshot('Seed the account snapshot history', null)
  const checklistUri = MEMORY('release-checklist')
  const checklist = STORE.get(checklistUri)
  if (checklist !== undefined && typeof checklist.text === 'string') {
    STORE.set(
      checklistUri,
      touched({
        ...checklist,
        text: `${checklist.text}\n\n- 2026-11-10: evidence revision for the v0.8 snapshot history.`,
      }),
    )
  }
  commitSnapshot('Record the release checklist revision', null)
  const projectUri = `${USER}/memories/entities/project`
  const conventions = STORE.get(MEMORY('workspace-conventions'))
  if (conventions !== undefined && typeof conventions.text === 'string') {
    STORE.set(
      MEMORY('workspace-conventions'),
      touched({ ...conventions, text: `${conventions.text}\n\n- 2026-11-10: project snapshot source.` }),
    )
  }
  commitSnapshot('Snapshot the project directory before restore', [projectUri])
  // Tasks the global Tasks view and evidence export can show.
  createTask({
    taskId: 'task_compile_demo_001',
    taskType: 'compile',
    resourceId: COMPILE_OUTPUT_URI,
    status: 'completed',
    stage: 'done',
    result: { outputs: 2, target: 'viking://user/demo/memories' },
    events: [
      { kind: 'created', status: 'pending', stage: 'queued', at: 1762218000 },
      { kind: 'status_changed', status: 'running', stage: 'compile', at: 1762218010 },
      { kind: 'completed', status: 'completed', stage: 'done', at: 1762218030 },
    ],
  })
  createTask({
    taskId: 'task_snapshot_demo_002',
    taskType: 'snapshot_restore_reindex',
    resourceId: projectUri,
    status: 'running',
    stage: 'reindex',
    settleMs: 600000,
    events: [{ kind: 'created', status: 'pending', stage: 'queued', at: 1762218040 }],
  })
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  /* ==================================================================
   * v0.5 write / control endpoints — stateful mock ONLY.
   *
   * These never reach a real memory store: the process's STORE map is the
   * whole persistence layer, and snapshot restore really rolls it back.
   * ================================================================== */

  // DELETE /api/v1/fs?uri=&recursive= — idempotent, permanent in the mock.
  if (req.method === 'DELETE' && path === '/api/v1/fs') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    const recursive = url.searchParams.get('recursive') === 'true'
    if (!uri.startsWith('viking://') || uri === USER) {
      return json(res, failure('INVALID_ARGUMENT', `Cannot delete: ${uri}`), 400)
    }
    if (STORE.has(uri)) {
      const entry = STORE.get(uri)
      if (entry.isDir && !recursive) {
        return json(res, failure('INVALID_ARGUMENT', `Cannot delete directory without recursive=true: ${uri}`, { type: 'directory', resource: uri }), 400)
      }
      let deleted = 0
      const victims = entry.isDir ? [...STORE.keys()].filter((key) => key === uri || key.startsWith(`${uri}/`)) : [uri]
      for (const victim of victims) {
        STORE.delete(victim)
        deleted += 1
      }
      return json(res, {
        status: 'ok',
        result: { uri, ...(entry.isDir ? { estimated_deleted_count: deleted } : {}) },
      })
    }
    // The real server is idempotent for a valid but absent URI.
    return json(res, { status: 'ok', result: { uri } })
  }

  // POST /api/v1/content/write — replace/append a memory file body.
  if (path === '/api/v1/content/write') {
    return withJsonBody(req, res, (body) => {
      if (typeof body.uri !== 'string' || body.uri.trim().length === 0) {
        return json(res, failure('INVALID_ARGUMENT', 'uri is required'), 400)
      }
      const uri = canonical(body.uri)
      if (!/^viking:\/\/user\/demo\/memories\/[^/]/.test(uri) || !/\.(md|txt|json|yaml|yml|toml)$/i.test(uri)) {
        return json(res, failure('INVALID_ARGUMENT', `write target is not a curatable memory file: ${uri}`, { type: 'file', resource: uri }), 400)
      }
      const existing = STORE.get(uri)
      if (existing !== undefined && existing.isDir) {
        return json(res, failure('INVALID_ARGUMENT', `Cannot read directory as file: ${uri}`, { expected: 'file', actual: 'directory' }), 400)
      }
      const content = typeof body.content === 'string' ? body.content : ''
      const mode = body.mode === 'append' ? 'append' : 'replace'
      ensureParents(uri)
      const base =
        existing ?? {
          uri,
          name: uri.slice(uri.lastIndexOf('/') + 1),
          mode: 420,
          modTime: new Date().toISOString(),
          isDir: false,
          contextType: 'memory',
          tags: [],
          memory: { memory_type: 'entity' },
        }
      const text = mode === 'append' ? `${existing?.text ?? ''}${content}` : content
      STORE.set(uri, touched({ ...base, uri, isDir: false, text }))
      return json(res, {
        status: 'ok',
        result: {
          uri,
          root_uri: parentOf(uri),
          context_type: 'memory',
          mode,
          written_bytes: Buffer.byteLength(content),
          content_updated: true,
          semantic_status: 'complete',
          vector_status: 'complete',
          queue_status: { Semantic: { processed: 1, error_count: 0, errors: [] } },
        },
      })
    })
  }

  // POST /api/v1/content/set_tags — replace/append/clear the tag list.
  if (path === '/api/v1/content/set_tags' || path === '/api/v1/fs/attrs/set_tags') {
    return withJsonBody(req, res, (body) => {
      const uri = canonical(typeof body.uri === 'string' ? body.uri : '')
      const entry = STORE.get(uri)
      if (entry === undefined) {
        return json(res, failure('NOT_FOUND', `Resource not found: ${uri}`, { type: 'resource', resource: uri }), 404)
      }
      const mode = body.mode === 'clear' ? 'clear' : body.mode === 'append' ? 'append' : 'replace'
      const tags = Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string') : []
      if (mode === 'clear') entry.tags = []
      else if (mode === 'append') entry.tags = [...new Set([...entry.tags, ...tags])]
      else if (tags.length > 0) entry.tags = [...tags]
      entry.modTime = new Date().toISOString()
      return json(res, {
        status: 'ok',
        result: {
          uri,
          updated_uris: [uri],
          root_uri: parentOf(uri),
          context_type: entry.contextType,
          tags: entry.tags,
          mode,
          success_count: 1,
          skipped_count: 0,
          failed_count: 0,
          tags_updated: true,
        },
      })
    })
  }

  // POST /api/v1/snapshot/commit — a real commit into the mock's history.
  if (path === '/api/v1/snapshot/commit') {
    return withJsonBody(req, res, (body) => {
      if (typeof body.message !== 'string' || body.message.trim().length === 0) {
        return json(res, failure('INVALID_ARGUMENT', 'message is required'), 400)
      }
      if (body.paths !== undefined && body.paths !== null && !Array.isArray(body.paths)) {
        return json(res, failure('INVALID_ARGUMENT', 'paths must be an array'), 400)
      }
      return json(res, { status: 'ok', result: commitSnapshot(body.message, body.paths ?? null) })
    })
  }

  // POST /api/v1/snapshot/restore — dry-run plan or applied restore.
  if (path === '/api/v1/snapshot/restore') {
    return withJsonBody(req, res, (body) => {
      if (typeof body.project_dir !== 'string' || typeof body.source_commit !== 'string') {
        return json(res, failure('INVALID_ARGUMENT', 'project_dir and source_commit are required'), 400)
      }
      const out = restoreSnapshot(body.project_dir, body.source_commit, body.dry_run === true)
      if (out.error !== undefined) return json(res, out.error, 404)
      return json(res, out)
    })
  }

  // GET /api/v1/snapshot/log — commit list; an empty branch is 404 git_ref.
  if (path === '/api/v1/snapshot/log') {
    if (SNAPSHOTS.length === 0) {
      return jsonError(res, 404, 'NOT_FOUND', 'Git_ref not found: main', { type: 'git_ref', resource: 'main' })
    }
    const limit = Number(url.searchParams.get('limit') ?? '20')
    const rows = SNAPSHOTS.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20).map((snap) => ({
      oid: snap.oid,
      tree: snap.oid,
      parents: snap.parent === null ? [] : [snap.parent],
      author: commitAuthor(snap.time),
      committer: commitAuthor(snap.time),
      message: snap.message,
    }))
    return json(res, { status: 'ok', result: rows })
  }

  // GET /api/v1/snapshot/show — commit metadata or one historical blob.
  if (path === '/api/v1/snapshot/show') {
    const ref = url.searchParams.get('target_ref') ?? ''
    const snap = SNAPSHOTS.find((candidate) => candidate.oid === ref) ?? SNAPSHOTS[0]
    if (snap === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Commit not found: ${ref}`, { type: 'git_commit', resource: ref })
    }
    const blobPath = url.searchParams.get('path') ?? ''
    if (blobPath.length > 0) {
      const entry = snap.tree.get(canonical(blobPath))
      if (entry === undefined || entry.text === undefined) {
        return jsonError(res, 404, 'NOT_FOUND', `Path not found in commit: ${blobPath}`, { type: 'file', resource: blobPath })
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-snapshot-oid': snap.oid,
        'x-snapshot-size': String(Buffer.byteLength(entry.text)),
      })
      return res.end(entry.text)
    }
    return json(res, {
      status: 'ok',
      result: {
        oid: snap.oid,
        tree: snap.oid,
        parents: snap.parent === null ? [] : [snap.parent],
        author: commitAuthor(snap.time),
        committer: commitAuthor(snap.time),
        message: snap.message,
      },
    })
  }

  // GET /api/v1/snapshot/diff — one file as a unified diff between commits.
  if (path === '/api/v1/snapshot/diff') {
    const fileUri = canonical(url.searchParams.get('path') ?? '')
    const from = SNAPSHOTS.find((snap) => snap.oid === (url.searchParams.get('from') ?? ''))
    const to = SNAPSHOTS.find((snap) => snap.oid === (url.searchParams.get('to') ?? ''))
    if (from === undefined || to === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', 'commit not found', { type: 'git_commit', resource: '' })
    }
    const fromEntry = from.tree.get(fileUri)
    const toEntry = to.tree.get(fileUri)
    const fromText = fromEntry?.text ?? null
    const toText = toEntry?.text ?? null
    const changeType =
      fromText === null && toText === null ? 'unchanged' : fromText === null ? 'added' : toText === null ? 'deleted' : fromText === toText ? 'unchanged' : 'modified'
    return json(res, {
      status: 'ok',
      result: {
        path: fileUri,
        from_commit: from.oid,
        to_commit: to.oid,
        change_type: changeType,
        diff_text: mockUnifiedDiff(fileUri, fromText, toText),
      },
    })
  }

  // GET /api/v1/snapshot/diff-paths (0.5.3): changed source files between refs.
  if (path === '/api/v1/snapshot/diff-paths') {
    const toRef = url.searchParams.get('to') ?? ''
    if (toRef.length === 0) {
      // A present route validating its arguments (this is the v0.8 capability
      // probe; pre-v0.8 builds never call it).
      return jsonError(res, 400, 'INVALID_ARGUMENT', 'to is required', { field: 'to' })
    }
    const to = SNAPSHOTS.find((snap) => snap.oid === toRef)
    if (to === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', 'commit not found', { type: 'git_commit', resource: toRef })
    }
    const fromRef = url.searchParams.get('from') ?? ''
    const from = fromRef.length === 0 ? new Map() : (SNAPSHOTS.find((snap) => snap.oid === fromRef)?.tree ?? new Map())
    const changes = []
    for (const [uri, entry] of to.tree) {
      const before = from.get(uri)
      if (before === undefined) changes.push({ uri, change_type: 'added' })
      else if (!sameStoreEntry(entry, before)) changes.push({ uri, change_type: 'modified' })
    }
    for (const uri of from.keys()) if (!to.tree.has(uri)) changes.push({ uri, change_type: 'deleted' })
    return json(res, {
      status: 'ok',
      result: { changes: changes.slice(0, 50), offset: 0, limit: 50, total: changes.length, has_more: changes.length > 50, next_offset: null },
    })
  }

  // GET /api/v1/snapshot/versions (0.5.3): compile-output version history.
  if (path === '/api/v1/snapshot/versions') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    if (uri.length === 0) {
      // The v0.8 capability probe: a present route answers a validation error.
      return jsonError(res, 400, 'INVALID_ARGUMENT', 'uri is required', { field: 'uri' })
    }
    if (uri !== COMPILE_OUTPUT_URI) {
      return jsonError(res, 400, 'FAILED_PRECONDITION', 'not a compile-managed file', { type: 'file', resource: uri })
    }
    return json(res, {
      status: 'ok',
      result: {
        uri,
        to: 'viking://user/demo/memories',
        current_version: 'ver-0003',
        total: 3,
        versions: [
          { version_id: 'ver-0003', version_number: 3, snapshot_id: 'snap-c003', snapshot_path: uri, created_at: 1762218030, source: 'compile', actor: 'demo' },
          { version_id: 'ver-0002', version_number: 2, snapshot_id: 'snap-c002', snapshot_path: uri, created_at: 1762217000, source: 'compile', actor: 'demo' },
          { version_id: 'ver-0001', version_number: 1, snapshot_id: 'snap-c001', snapshot_path: uri, created_at: 1762216000, source: 'compile', actor: 'demo' },
        ],
        next_before_version: null,
      },
    })
  }

  // GET /api/v1/snapshot/ignore — empty ignore-file body on this mock.
  if (path === '/api/v1/snapshot/ignore') {
    if (OPS_MODE) {
      return json(res, { status: 'ok', result: '# .ovgitignore for the demo account\n# generated evidence fixture\n*.tmp\n' })
    }
    return json(res, { status: 'ok', result: '' })
  }

  // POST /api/v1/sessions/{id}/commit — force commit: archive + async task.
  if (req.method === 'POST' && path.startsWith('/api/v1/sessions/') && path.endsWith('/commit')) {
    const ovSessionId = decodeURIComponent(path.split('/')[4] ?? 'demo-session')
    const task = createTask({
      taskType: 'session_commit',
      resourceId: ovSessionId,
      status: 'running',
      stage: 'archive',
      settleMs: 3000,
      result: {
        session_id: ovSessionId,
        archive_uri: `${USER}/sessions/${ovSessionId}/history/archive_004`,
        memories_extracted: { memory_write: 2, memory_edit: 1 },
        memory_diff_uri: `${USER}/sessions/${ovSessionId}/history/archive_004/memory_diff.json`,
        token_usage: { total: { input: 1902, output: 88 } },
      },
      events: [
        { kind: 'created', status: 'pending', stage: 'queued' },
        { kind: 'status_changed', status: 'running', stage: 'archive' },
      ],
    })
    return json(res, {
      status: 'ok',
      result: {
        session_id: ovSessionId,
        status: 'accepted',
        task_id: task.task_id,
        archive_uri: `${USER}/sessions/${ovSessionId}/history/archive_004`,
        archived: true,
      },
    })
  }

  // GET /api/v1/tasks/{id} (+ optional execution events).
  if (req.method === 'GET' && path.startsWith('/api/v1/tasks/') && !path.endsWith('/cancel')) {
    const taskId = decodeURIComponent(path.slice('/api/v1/tasks/'.length))
    const task = TASKS.get(taskId)
    if (task === undefined) {
      return json(res, failure('NOT_FOUND', `Task not found: ${taskId}`, { type: 'task', resource: taskId }), 404)
    }
    const includeEvents = ['1', 'true'].includes(url.searchParams.get('include_events') ?? '')
    const view = taskView(task)
    if (!includeEvents) return json(res, { status: 'ok', result: view })
    // The 0.5.3 contract puts the event container inside `result`
    // (`result.execution_events`); keep the top-level copy too for older readers.
    const events = taskEvents(task)
    return json(res, {
      status: 'ok',
      result: { ...view, result: { ...(view.result ?? {}), execution_events: events }, execution_events: events },
    })
  }

  // POST /api/v1/tasks/{id}/cancel — cooperative cancel (mock succeeds).
  if (req.method === 'POST' && path.startsWith('/api/v1/tasks/') && path.endsWith('/cancel')) {
    const taskId = decodeURIComponent(path.slice('/api/v1/tasks/'.length, -'/cancel'.length))
    const task = TASKS.get(taskId)
    if (task === undefined) {
      return json(res, failure('NOT_FOUND', `Task not found: ${taskId}`, { type: 'task', resource: taskId }), 404)
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return json(res, failure('FAILED_PRECONDITION', `Task is already ${task.status}: ${taskId}`, { type: 'task', resource: taskId }), 412)
    }
    task.status = 'cancelled'
    task.stage = 'cancelled'
    task.updated_at = nowSeconds()
    return json(res, { status: 'ok', result: taskView(task) })
  }

  // GET /api/v1/console/dashboard/summary — F11 metric card.
  if (path === '/api/v1/console/dashboard/summary') {
    return json(res, {
      status: 'ok',
      result: {
        context_counts: { files: 42, skills: 2, memories: 9, total: 53 },
        today_tokens: { vlm_input: 3210, vlm_output: 980, embedding_input: 640, total: 4830 },
        today_retrievals: { find: 12, search: 31, total: 43 },
      },
    })
  }

  // GET /api/v1/observer/queue?format=json — F11 metric card.
  if (path === '/api/v1/observer/queue') {
    return json(res, {
      status: 'ok',
      result: {
        name: 'queue',
        is_healthy: true,
        has_errors: false,
        status: {
          queues: [
            { queue: 'memory_extract', pending: 1, in_progress: 0, processed: 14, requeued: 0, errors: 0, total: 15 },
            { queue: 'semantic', pending: 0, in_progress: 0, processed: 9, requeued: 1, errors: 0, total: 10 },
            { queue: 'vector', pending: 2, in_progress: 1, processed: 22, requeued: 0, errors: 1, total: 25 },
          ],
        },
      },
    })
  }

  // GET /api/v1/stats/memories — F11 metric card.
  if (path === '/api/v1/stats/memories') {
    return json(res, {
      status: 'ok',
      result: {
        total_memories: 9,
        by_category: { profile: 1, preferences: 2, entities: 4, events: 1, cases: 0, patterns: 0, tools: 1, skills: 0 },
        hotness_distribution: { cold: 5, warm: 3, hot: 1 },
        staleness: { not_accessed_7d: 4, not_accessed_30d: 2, oldest_memory_age_days: 38 },
      },
    })
  }

  // GET /api/v1/stats/sessions/{id} — F11 metric card.
  if (path.startsWith('/api/v1/stats/sessions/')) {
    const sessionId = decodeURIComponent(path.slice('/api/v1/stats/sessions/'.length))
    return json(res, {
      status: 'ok',
      result: { session_id: sessionId, total_turns: 1, memories_extracted: 9 },
    })
  }

  // GET /api/v1/acl?uri= — resources-only; unavailable on the mock (like dev).
  if (path === '/api/v1/acl') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    if (!uri.startsWith('viking://resources')) {
      return json(res, failure('INVALID_ARGUMENT', 'ACL is only supported for viking://resources'), 400)
    }
    return json(res, failure('PERMISSION_DENIED', 'manage permission required'), 403)
  }

  if (path === '/health') {
    // v0.3 and v0.4 both read this; the version has to be 0.5.3-like so the
    // Rules / Experience capability probes enable.
    return json(res, { status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' })
  }
  if (path === '/api/v1/system/status') {
    return json(res, { status: 'ok', result: { initialized: true, user: 'demo' }, error: null })
  }
  if (path === '/api/v1/skills') {
    // v0.3's Doctor count and the v0.4 Doctor count both use node_limit=1 (the
    // legacy body); the F8 catalogue asks for the whole list.
    const nodeLimit = Number(url.searchParams.get('node_limit') ?? '1')
    if (Number.isFinite(nodeLimit) && nodeLimit > 1) {
      return json(res, { status: 'ok', result: enrichedSkills() })
    }
    return json(res, { status: 'ok', result: legacySkills() })
  }
  if (path === '/api/v1/observer/retrieval') {
    return json(res, {
      status: 'ok',
      result: {
        name: 'retrieval',
        is_healthy: true,
        status: { total_queries: 233, total_results: 1765, zero_result_rate: 0.1159, avg_results_per_query: 7.58, avg_latency_ms: 546.9 },
      },
    })
  }
  if (path === '/api/v1/fs/stat') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    // The released Doctor's fs capability probe: keep its body byte-identical.
    if (uri === USER) {
      return json(res, {
        status: 'ok',
        result: { uri: `${USER}`, name: 'demo', size: 320, isDir: true, modTime: '2026-10-02T07:00:00Z', count: 108 },
      })
    }
    const entry = STORE.get(uri)
    if (entry === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Resource not found: ${uri}`, { type: 'resource', resource: uri })
    }
    return json(res, { status: 'ok', result: statOf(entry) })
  }
  if (path === '/api/v1/fs/attrs') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    const entry = STORE.get(uri)
    if (entry === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Resource not found: ${uri}`, { type: 'resource', resource: uri })
    }
    // Directories have no context face: the preview then falls back to its
    // "directory" type row (there is no L2 body for them either).
    return json(res, {
      status: 'ok',
      result: {
        uri: entry.uri,
        ...(entry.isDir ? {} : { context_type: entry.contextType }),
        attrs: {
          tags: entry.tags,
          ...(entry.isDir ? {} : { memory: { memory_type: entry.memory.memory_type ?? 'entity', version: 3, ...entry.memory } }),
        },
      },
    })
  }
  if (path === '/api/v1/content/abstract' || path === '/api/v1/content/overview') {
    const tier = path.endsWith('abstract') ? 'abstract' : 'overview'
    const uri = canonical(url.searchParams.get('uri') ?? '')
    const sidecar = sidecarFor(uri)
    if (sidecar === null) {
      return jsonError(res, 404, 'NOT_FOUND', `Resource not found: ${uri}`, { type: 'resource', resource: uri })
    }
    return json(res, { status: 'ok', result: sidecar[tier] })
  }
  if (path === '/api/v1/rules/search') {
    let requestBody = ''
    req.on('data', (chunk) => (requestBody += chunk))
    req.on('end', () => {
      let taskContext = ''
      try {
        const parsed = JSON.parse(requestBody || '{}')
        taskContext = typeof parsed.task_context === 'string' ? parsed.task_context : ''
      } catch {
        taskContext = ''
      }
      if (taskContext.trim().length === 0) {
        return jsonError(res, 400, 'INVALID_ARGUMENT', 'task_context is required', { field: 'task_context' })
      }
      // The capability probe keeps the released build's empty-library answer.
      // Everything else (F8 tester, Explore search) gets the matched rules.
      const result = taskContext.startsWith('OpenViking plugin doctor') ? emptyRuleSearch() : matchedRuleSearch()
      return json(res, { status: 'ok', result })
    })
    return
  }
  if (path.startsWith('/api/v1/sessions/')) {
    const requestedId = decodeURIComponent(path.split('/').pop() ?? 'demo-session')
    return json(res, {
      result: {
        session_id: requestedId,
        uri: `${USER}/sessions/${requestedId}`,
        created_by_user_id: 'demo',
        user: { account_id: 'demo', user_id: 'demo' },
        message_count: 24,
        commit_count: 3,
        memories_extracted: { total: 9, memory_write: 7, memory_edit: 2 },
        last_commit_at: '2026-10-02T07:55:00Z',
        last_auto_commit_at: '2026-10-02T07:30:00Z',
        last_message_at: '2026-10-02T08:10:00Z',
        created_at: '2026-10-02T06:00:00Z',
        updated_at: '2026-10-02T08:10:00Z',
        pending_tokens: 4820,
        threshold: 20000,
        total_message_count: 42,
      },
    })
  }
  if (path === '/api/v1/fs/ls') {
    const requested = url.searchParams.get('uri') ?? ''
    const uri = canonical(requested)
    // The v0.3 commit-timeline read: unchanged body, keyed by the requested
    // session-history URI exactly as before.
    if (requested.endsWith('/history')) {
      const entries = ARCHIVES.map((archive) => ({
        uri: `${requested.replace(/\/+$/, '')}/${archive.id}`,
        size: 0,
        isDir: true,
        modTime: archive.modTime,
        abstract: `commit archive ${archive.id}`,
      }))
      return json(res, { result: entries })
    }
    if (uri === EXPERIENCES_ROOT && EMPTY_EXPERIENCES) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    if (!STORE.has(uri) || STORE.get(uri).isDir !== true) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    // v0.7 native tree/sessions pages call `fs/ls` with node_limit+offset; the
    // released builds never sent those parameters, so this branch is additive.
    if (url.searchParams.has('node_limit')) {
      let children = childrenOf(uri)
      if (url.searchParams.get('sort_by') === 'mtime') {
        const direction = url.searchParams.get('sort_order') === 'asc' ? 1 : -1
        children = [...children].sort((left, right) => {
          const a = new Date(STORE.get(left)?.modTime ?? 0).getTime()
          const b = new Date(STORE.get(right)?.modTime ?? 0).getTime()
          if (a === b) return left.localeCompare(right)
          return a < b ? -direction : direction
        })
      }
      const limitRaw = Number(url.searchParams.get('node_limit'))
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50
      const offsetRaw = Number(url.searchParams.get('offset') ?? 0)
      const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0
      const page = children.slice(offset, offset + limit)
      const hasMore = offset + limit < children.length
      return json(res, {
        status: 'ok',
        result: {
          items: page.map(listingEntry),
          has_more: hasMore,
          offset,
          next_offset: hasMore ? offset + page.length : null,
        },
      })
    }
    return json(res, { status: 'ok', result: childrenOf(uri).map(listingEntry) })
  }
  if (path === '/api/v1/fs/tree') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    if (uri === EXPERIENCES_ROOT && EMPTY_EXPERIENCES) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    if (!STORE.has(uri) || STORE.get(uri).isDir !== true) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    const flat = []
    const visit = (dirUri, rel) => {
      for (const childUri of childrenOf(dirUri)) {
        const entry = STORE.get(childUri)
        flat.push({ ...listingEntry(childUri), rel_path: rel.length === 0 ? entry.name : `${rel}/${entry.name}` })
        if (entry.isDir) visit(childUri, rel.length === 0 ? entry.name : `${rel}/${entry.name}`)
      }
    }
    visit(uri, '')
    return json(res, { status: 'ok', result: flat, has_more: false })
  }
  if (path === '/api/v1/content/read') {
    const uri = url.searchParams.get('uri') ?? ''
    const archive = ARCHIVES.find((candidate) => uri.includes(`/${candidate.id}/`))
    if (archive !== undefined) {
      // The real server hands this back as a JSON *string*; the plugin unwraps
      // both. Every file under the archive answers the archived diff.
      return json(res, { result: JSON.stringify(DIFFS[archive.stamp]) })
    }
    const entry = STORE.get(canonical(uri))
    if (entry === undefined || entry.isDir || entry.text === undefined) {
      // Unchanged: the released build saw this 404 for every non-archive read
      // (recall-panel detail, session log, skill bodies) and the v0.4 preview
      // reports the tier as unavailable in place.
      return json(res, { result: null }, 404)
    }
    const respondPage = () =>
      json(res, { status: 'ok', result: pageText(entry.text, url.searchParams.get('offset'), url.searchParams.get('limit')) })
    // v0.6 Rules partial evidence: the host gives the whole listing 15 s and a
    // concurrency-4 pool. Only the extra `stall-rule-*` bodies stall (longer
    // than the host's 8 s read timeout), so the three real rule files arrive
    // immediately and the pool still has unstarted items when the 15 s deadline
    // passes — a deterministic partial listing with real rows.
    if (RULES_STALL && entry.memory?.memory_type === 'rule' && entry.name.startsWith('stall-rule-')) {
      setTimeout(respondPage, 20_000)
      return
    }
    return respondPage()
  }
  if (path === '/api/v1/agent-evolution/experiences/trajectories') {
    const experienceUri = canonical(url.searchParams.get('experience_uri') ?? '')
    if (experienceUri.length === 0) {
      return jsonError(res, 400, 'INVALID_ARGUMENT', 'query.experience_uri: Field required', { field: 'experience_uri' })
    }
    const items = TRAJECTORIES.get(experienceUri)
    if (items === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `File not found: ${experienceUri}`, { type: 'file', resource: experienceUri })
    }
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return json(res, {
      status: 'ok',
      result: { experience_uri: experienceUri, items, total: items.length, limit: Number.isFinite(limit) ? limit : 50, offset: 0, has_more: false },
    })
  }
  if (path === '/api/v1/agent-evolution/experiences/outcomes') {
    const experienceUri = canonical(url.searchParams.get('experience_uri') ?? '')
    if (experienceUri.length === 0) {
      return jsonError(res, 400, 'INVALID_ARGUMENT', 'query.experience_uri: Field required', { field: 'experience_uri' })
    }
    const distribution = OUTCOMES.get(experienceUri)
    if (distribution === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `File not found: ${experienceUri}`, { type: 'file', resource: experienceUri })
    }
    return json(res, { status: 'ok', result: { experience_uri: experienceUri, outcome_distribution: distribution } })
  }
  if (path === '/api/v1/tasks' && (url.searchParams.get('pagination') === 'cursor' || url.searchParams.has('limit'))) {
    const statuses = url.searchParams.getAll('status')
    const types = url.searchParams.getAll('task_type')
    let items = [...TASKS.values()].map(taskView)
    if (statuses.length > 0) items = items.filter((task) => statuses.includes(task.status))
    if (types.length > 0) items = items.filter((task) => types.includes(task.task_type))
    items.sort((a, b) => b.created_at - a.created_at)
    const limitRaw = Number(url.searchParams.get('limit') ?? '20')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 20
    const cursorRaw = url.searchParams.get('cursor')
    const offset = cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : 0
    const page = items.slice(offset, offset + limit)
    const hasMore = offset + limit < items.length
    return json(res, {
      status: 'ok',
      result: { items: page, has_more: hasMore, next_cursor: hasMore ? String(offset + limit) : null },
    })
  }
  if (path === '/api/v1/tasks') {
    const resourceId = url.searchParams.get('resource_id') ?? 'dsh-demo-session'
    const archiveUri = `${USER}/sessions/${resourceId}/history/archive_003`
    return json(res, {
      status: 'ok',
      result: [
        {
          task_id: 'task_demo_003',
          task_type: 'session_commit',
          status: 'completed',
          stage: 'extract',
          error: null,
          created_at_iso: '2026-10-02T07:55:00Z',
          updated_at_iso: '2026-10-02T07:55:20Z',
          processing_seconds: 20,
          resource_id: resourceId,
          result: { archive_uri: archiveUri, memory_diff_uri: `${archiveUri}/memory_diff.json` },
        },
      ],
    })
  }
  if (path === '/api/v1/search/search') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let query = ''
      let mode = 'list'
      let scoped = false
      try {
        const parsed = JSON.parse(body || '{}')
        query = typeof parsed.query === 'string' ? parsed.query : ''
        mode = parsed.mode === 'context' ? 'context' : 'list'
        // The v0.3 recall panel always scopes a list read to a session and one
        // or more targets; Explore's unified search intentionally does neither.
        scoped = parsed.session_id !== undefined || parsed.target_uri !== undefined
      } catch {
        query = ''
      }
      if (mode === 'context') {
        return json(res, { status: 'ok', result: contextAnswer(query) })
      }
      if (scoped) return json(res, { status: 'ok', result: search(query) })
      return json(res, { status: 'ok', result: searchList() })
    })
    return
  }
  if (path === '/' || path.startsWith('/studio')) {
    const headers = { 'content-type': 'text/html; charset=utf-8' }
    if (STUDIO_BLOCKED) {
      headers['x-frame-options'] = 'DENY'
      headers['content-security-policy'] = "frame-ancestors 'none'"
    }
    res.writeHead(200, headers)
    return res.end(STUDIO)
  }
  /* ==================================================================
   * v0.8 Operate evidence routes (behind OV_FIXTURE_OPS). New endpoints plus
   * branches for the 0.5.3 read routes; the pre-v0.8 request set is unchanged.
   * ================================================================== */
  if (OPS_MODE) {
    // ---- compile reads + trigger -------------------------------------
    if (path === '/api/v1/compile/capabilities') {
      return json(res, { status: 'ok', result: { configured: true, can_create: true, reason_code: null } })
    }
    if (path === '/api/v1/compile/configs') {
      return json(res, { status: 'ok', result: { targets: COMPILE_TARGETS, next_cursor: null } })
    }
    if (path === '/api/v1/compile/config') {
      const to = url.searchParams.get('to') ?? ''
      const target = COMPILE_TARGETS.find((candidate) => candidate.to === to) ?? COMPILE_TARGETS[0]
      return json(res, {
        status: 'ok',
        result: {
          to: target.to,
          from: [`${target.to}/entities`, `${target.to}/rules`],
          skill: target.compile_type === 'memory' ? 'memory-consolidate' : 'resource-compile',
          instruction: null,
          auto_update: target.auto_update,
          update_schedule: target.update_schedule,
          status: target.status,
          compile_type: target.compile_type,
          conflicts_num: target.conflicts_num,
        },
      })
    }
    if (path === '/api/v1/compile/operations') {
      const to = url.searchParams.get('to') ?? COMPILE_TARGETS[0].to
      return json(res, {
        status: 'ok',
        result: {
          operations: [
            {
              operation_id: 'op-0001',
              operation_type: 'compile',
              actor: 'demo',
              status: 'completed',
              created_at: 1762217900,
              started_at: 1762217901,
              finished_at: 1762217920,
              params: { to, skill: 'memory' },
              result: { outputs: 2 },
              error: null,
              meta: { task_id: 'task_compile_demo_001', trigger: 'manual' },
            },
            {
              operation_id: 'op-0002',
              operation_type: 'compile',
              actor: 'demo',
              status: 'running',
              created_at: 1762218050,
              started_at: 1762218051,
              finished_at: null,
              params: { to, skill: 'memory' },
              result: null,
              error: null,
              meta: { task_id: 'task_compile_running_002', trigger: 'manual' },
            },
          ],
          next_cursor: null,
        },
      })
    }
    if (path.startsWith('/api/v1/compile/operations/') && !path.endsWith('/outputs')) {
      const operationId = decodeURIComponent(path.slice('/api/v1/compile/operations/'.length))
      const polls = (COMPILE_POLLS.get(operationId) ?? 0) + 1
      COMPILE_POLLS.set(operationId, polls)
      const done = operationId === 'op-0001' || polls > 1
      return json(res, {
        status: 'ok',
        result: {
          operation_id: operationId,
          operation_type: 'compile',
          actor: 'demo',
          status: done ? 'completed' : 'running',
          created_at: 1762218050,
          started_at: 1762218051,
          finished_at: done ? 1762218070 : null,
          params: { to: COMPILE_TARGETS[0].to, skill: 'memory' },
          result: done ? { outputs: 2 } : null,
          error: null,
          meta: { task_id: 'task_compile_running_002', trigger: 'manual' },
        },
      })
    }
    if (path.startsWith('/api/v1/compile/operations/') && path.endsWith('/outputs')) {
      const operationId = decodeURIComponent(path.slice('/api/v1/compile/operations/'.length, -'/outputs'.length))
      return json(res, {
        status: 'ok',
        result: {
          outputs: [
            { uri: COMPILE_OUTPUT_URI, version_id: 'ver-0003', snapshot_id: 'snap-c003' },
            { uri: 'viking://resources/compiled/dsh-plugin.lock.json', version_id: 'ver-0003', snapshot_id: 'snap-c003' },
          ],
          next_cursor: null,
        },
      })
    }
    if (path.startsWith('/api/v1/compile/submissions/')) {
      const key = decodeURIComponent(path.slice('/api/v1/compile/submissions/'.length))
      return json(res, {
        status: 'ok',
        result: {
          task_id: 'task_compile_demo_001',
          task_type: 'compile',
          status: 'completed',
          created_at: 1762217900,
          updated_at: 1762217920,
          resource_id: COMPILE_TARGETS[0].to,
          stage: 'done',
          result: { outputs: 2 },
          error: null,
          meta: { idempotency_key: key },
        },
      })
    }
    if (req.method === 'POST' && path === '/api/v1/compile') {
      return withJsonBody(req, res, (body) => {
        const task = createTask({
          taskId: 'task_compile_running_002',
          taskType: 'compile',
          resourceId: typeof body.to === 'string' ? body.to : COMPILE_TARGETS[0].to,
          status: 'running',
          stage: 'compile',
          settleMs: 600000,
          events: [
            { kind: 'created', status: 'pending', stage: 'queued', at: nowSeconds() },
            { kind: 'status_changed', status: 'running', stage: 'compile', at: nowSeconds() },
          ],
        })
        return json(
          res,
          {
            status: 'ok',
            result: {
              task_id: task.task_id,
              task_type: 'compile',
              status: 'running',
              stage: 'compile',
              created_at: task.created_at,
              updated_at: task.updated_at,
              resource_id: task.resource_id,
              result: null,
              error: null,
              meta: { operation_id: 'op-0002', idempotency_key: req.headers['idempotency-key'] ?? null },
            },
          },
          202,
        )
      })
    }

    // ---- OVPack export (streaming zip, never JSON) --------------------
    if (req.method === 'POST' && path === '/api/v1/pack/export') {
      return withJsonBody(req, res, (body) => {
        if (typeof body.uri !== 'string' || body.uri.trim().length === 0) {
          return json(res, failure('INVALID_ARGUMENT', 'uri is required'), 400)
        }
        const payload = Buffer.concat([
          Buffer.from('PK\x03\x04', 'latin1'),
          Buffer.from('v0.8 evidence ovpack for the OpenViking native cockpit. This is invented fixture content.'.repeat(8), 'utf8'),
          Buffer.from('PK\x01\x02', 'latin1'),
        ])
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="demo-memories.ovpack"',
          'content-length': String(payload.byteLength),
          'x-request-id': randomUUID(),
        })
        return res.end(payload)
      })
    }

    // ---- console analytics + observer cards --------------------------
    if (path === '/api/v1/console/tokens') {
      return json(res, {
        status: 'ok',
        result: {
          total_tokens: 4830,
          period: { start_date: '2026-11-04', end_date: '2026-11-10', bucket: 'day' },
          series: [
            { bucket: '2026-11-09', tokens: 2100 },
            { bucket: '2026-11-10', tokens: 2730 },
          ],
        },
      })
    }
    if (path === '/api/v1/console/context-commits') {
      return json(res, {
        status: 'ok',
        result: {
          total_commits: 5,
          period: { start_date: '2026-11-04', end_date: '2026-11-10', bucket: '4h' },
          series: [
            { bucket: '2026-11-10T08:00:00Z', commits: 2 },
            { bucket: '2026-11-10T12:00:00Z', commits: 3 },
          ],
        },
      })
    }
    if (path === '/api/v1/console/audit') {
      return json(res, {
        status: 'ok',
        result: {
          page: 1,
          page_size: 20,
          total: 2,
          items: [
            { request_id: 'req-demo-0001', method: 'GET', route: '/api/v1/fs/ls', status: 200, created_at: '2026-11-10T08:01:00Z' },
            { request_id: 'req-demo-0002', method: 'POST', route: '/api/v1/compile', status: 202, created_at: '2026-11-10T08:02:00Z' },
          ],
        },
      })
    }
    if (path.startsWith('/api/v1/observer/') && url.searchParams.get('format') === 'json') {
      const name = path.slice('/api/v1/observer/'.length)
      const cards = {
        system: { status: 'ok', uptime_seconds: 194400, cpu_percent: 3.2, rss_mb: 188 },
        models: { status: 'ok', models: [{ name: 'dashscope-embedding-v4', ready: true }] },
        vikingdb: { status: 'ok', collections: 4, vectors: 108 },
        lock: { status: 'ok', holders: 0, waiting: 0 },
        filesystem: { status: 'ok', files: 42, directories: 12 },
      }
      const body = cards[name]
      if (body !== undefined) return json(res, { status: 'ok', result: body })
    }
  }

  return json(res, { error: { message: `mock: no route for ${path}` } }, 404)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock openviking on http://127.0.0.1:${PORT}${EMPTY_EXPERIENCES ? ' (empty experiences mode)' : ''}`)
})

/** The `fs/stat` body for one catalogue entry (directories carry `count`). */
function statOf(entry) {
  if (entry.isDir) {
    return { uri: entry.uri, name: entry.name, size: 0, mode: entry.mode, modTime: entry.modTime, isDir: true, isLocked: false, count: entry.count }
  }
  return { uri: entry.uri, name: entry.name, size: entry.size, mode: entry.mode, modTime: entry.modTime, isDir: false, isLocked: false, id: 'a1b2c3d4e5f678901234567890abcdef' }
}
