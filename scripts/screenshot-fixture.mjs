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

const PORT = Number(process.argv[2] ?? 1999)
/** Test switch for the Experience tab's empty state (see `.scratch/v04`). */
const EMPTY_EXPERIENCES = process.env.OV_FIXTURE_EMPTY_EXPERIENCES === '1'

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

/** A JSON listing entry as `fs/ls` returns it (`output=agent` shape). */
function listingEntry(uri) {
  const entry = STAT.get(uri)
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
  const entry = STAT.get(canonicalUri)
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

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
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

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

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
    const entry = STAT.get(uri)
    if (entry === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Resource not found: ${uri}`, { type: 'resource', resource: uri })
    }
    return json(res, { status: 'ok', result: statOf(entry) })
  }
  if (path === '/api/v1/fs/attrs') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    const entry = STAT.get(uri)
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
    const children = CHILDREN.get(uri)
    if (children === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    return json(res, { status: 'ok', result: children.map(listingEntry) })
  }
  if (path === '/api/v1/fs/tree') {
    const uri = canonical(url.searchParams.get('uri') ?? '')
    if (uri === EXPERIENCES_ROOT && EMPTY_EXPERIENCES) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    const children = CHILDREN.get(uri)
    if (children === undefined) {
      return jsonError(res, 404, 'NOT_FOUND', `Directory not found: ${uri}`, { type: 'directory', resource: uri })
    }
    const flat = []
    const visit = (dirUri, rel) => {
      for (const childUri of CHILDREN.get(dirUri) ?? []) {
        const entry = STAT.get(childUri)
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
    const entry = STAT.get(canonical(uri))
    if (entry === undefined || entry.isDir || entry.text === undefined) {
      // Unchanged: the released build saw this 404 for every non-archive read
      // (recall-panel detail, session log, skill bodies) and the v0.4 preview
      // reports the tier as unavailable in place.
      return json(res, { result: null }, 404)
    }
    return json(res, { status: 'ok', result: pageText(entry.text, url.searchParams.get('offset'), url.searchParams.get('limit')) })
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(STUDIO)
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
