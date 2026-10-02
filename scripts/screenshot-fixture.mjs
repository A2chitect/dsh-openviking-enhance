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
    return json(res, { result: { status: 'ok', healthy: true, version: '0.4.22', auth_mode: 'dev' } })
  }
  if (path.startsWith('/api/v1/sessions/')) {
    return json(res, {
      result: {
        session_id: decodeURIComponent(path.split('/').pop() ?? 'demo-session'),
        uri: SESSION_URI,
        created_by_user_id: 'demo',
        user: { account_id: 'demo', user_id: 'demo' },
        message_count: 24,
        commit_count: 3,
        memories_extracted: { total: 9, memory_write: 7, memory_edit: 2 },
        last_commit_at: '2026-10-02T07:55:00Z',
        pending_tokens: 4820,
        threshold: 20000,
      },
    })
  }
  if (path === '/api/v1/fs/ls') {
    const uri = url.searchParams.get('uri') ?? ''
    // Only the history directory is asked for; answer with the three archives.
    const entries = Object.keys(DIFFS).map((stamp, index) => ({
      uri: `${uri.replace(/\/+$/, '')}/${stamp}`,
      size: 0,
      isDir: true,
      modTime: `2026-10-02T0${7 + index}:${index === 0 ? '10' : index === 1 ? '30' : '55'}:00Z`,
      abstract: `commit archive ${stamp}`,
    }))
    return json(res, { result: entries })
  }
  if (path === '/api/v1/content/read') {
    const uri = url.searchParams.get('uri') ?? ''
    const stamp = Object.keys(DIFFS).find((key) => uri.includes(key))
    if (stamp === undefined) return json(res, { result: null }, 404)
    // The real server hands this back as a JSON *string*; the plugin unwraps both.
    return json(res, { result: JSON.stringify(DIFFS[stamp]) })
  }
  if (path === '/api/v1/tasks') {
    return json(res, { result: [] })
  }
  if (path === '/api/v1/search/search') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let query = ''
      try {
        const parsed = JSON.parse(body || '{}')
        query = typeof parsed.query === 'string' ? parsed.query : ''
      } catch {
        query = ''
      }
      json(res, { result: search(query) })
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
