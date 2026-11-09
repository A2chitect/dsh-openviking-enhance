// A stand-in OpenViking server for screenshots: same endpoints and envelopes the
// real one answers, with invented content. Nothing here comes from a real memory
// store, which is the point — the screenshots show the plugin, not somebody's data.
//
// It backs the screenshots in `assets/`: boot a scratch profile, point this
// plugin at this server, and capture the surfaces without a real memory space
// anywhere in the picture. Nothing it serves is real content.
//
//   node scripts/screenshot-fixture.mjs [port]
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 1999)
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

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === '/health') {
    return json(res, { status: 'ok', healthy: true, version: '0.5.3', auth_mode: 'dev' })
  }
  if (path === '/api/v1/system/status') {
    return json(res, { status: 'ok', result: { initialized: true, user: 'demo' }, error: null })
  }
  if (path === '/api/v1/skills') {
    return json(res, {
      status: 'ok',
      result: {
        root_uris: [`${USER}/skills`, 'viking://agent/skills'],
        skills: [
          { type: 'skill', name: 'screenshot-a-plugin', uri: `${USER}/skills/screenshot-a-plugin`, description: 'Capture a plugin without leaking a real workspace.' },
          { type: 'skill', name: 'write-a-changelog', uri: `${USER}/skills/write-a-changelog`, description: 'Keep a changelog with one section per release.' },
        ],
      },
    })
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
    return json(res, {
      status: 'ok',
      result: { uri: `${USER}`, name: 'demo', size: 320, isDir: true, modTime: '2026-10-02T07:00:00Z', count: 108 },
    })
  }
  if (path === '/api/v1/rules/search') {
    return json(res, {
      status: 'ok',
      result: { rules: [], scenarios: [], rendered: '# Applicable OpenViking Rules\n\nMatched 0 active Rule(s).', delivery: { complete: true, rule_count: 0 }, warning: 'rule library is empty' },
    })
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
    const uri = url.searchParams.get('uri') ?? ''
    // Only the history directory is asked for; answer with the three archives.
    const entries = ARCHIVES.map((archive) => ({
      uri: `${uri.replace(/\/+$/, '')}/${archive.id}`,
      size: 0,
      isDir: true,
      modTime: archive.modTime,
      abstract: `commit archive ${archive.id}`,
    }))
    return json(res, { result: entries })
  }
  if (path === '/api/v1/content/read') {
    const uri = url.searchParams.get('uri') ?? ''
    const archive = ARCHIVES.find((candidate) => uri.includes(`/${candidate.id}/`))
    if (archive === undefined) return json(res, { result: null }, 404)
    // The real server hands this back as a JSON *string*; the plugin unwraps both.
    return json(res, { result: JSON.stringify(DIFFS[archive.stamp]) })
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
      try {
        const parsed = JSON.parse(body || '{}')
        query = typeof parsed.query === 'string' ? parsed.query : ''
        mode = parsed.mode === 'context' ? 'context' : 'list'
      } catch {
        query = ''
      }
      if (mode === 'context') {
        return json(res, { status: 'ok', result: contextAnswer(query) })
      }
      json(res, { status: 'ok', result: search(query) })
    })
    return
  }
  if (path === '/' || path.startsWith('/studio')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(STUDIO)
  }
  return json(res, { error: { message: `mock: no route for ${path}` } }, 404)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock openviking on http://127.0.0.1:${PORT}`)
})
