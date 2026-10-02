// A stand-in OpenAI-compatible model for screenshots: it answers one chat
// completion with a canned reply and usage numbers, so a scratch profile can run
// a real turn without an account behind it. Nothing it returns is a real answer.
//
// It backs `assets/commit-pill.png`: the composer dock only renders for a session
// that has run a turn, so the scratch profile points its default model here and
// the pill has somewhere to appear. The reply is canned; no account is involved.
//
//   node scripts/screenshot-model.mjs [port]
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 1998)

const REPLY = [
  'Here is the checklist, in the order I would run it:',
  '',
  '1. Bump the version and promote the changelog section.',
  '2. Rebuild the bundled client half, then pack the tarball.',
  '3. Tag the release and push the tag with the commit.',
  '4. Publish the artifact and verify it installs into a clean profile.',
].join('\n')

const chunk = (delta, extra = {}) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`

createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    const body = JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    return res.end(body)
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'mock: only /v1/chat/completions' } }))
  }

  let body = ''
  req.on('data', (data) => (body += data))
  req.on('end', () => {
    let stream = true
    try {
      const parsed = JSON.parse(body || '{}')
      stream = parsed.stream !== false
    } catch {
      /* default to streaming */
    }
    console.log(`[mock-model] completion requested (${body.length} bytes, stream=${String(stream)})`)

    if (!stream) {
      const payload = JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1843, completion_tokens: 96, total_tokens: 1939 },
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      return res.end(payload)
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(chunk({ role: 'assistant', content: '' }))
    // Word by word, so the transcript renders the way a real stream does.
    for (const word of REPLY.split(/(\s+)/)) {
      if (word !== '') res.write(chunk({ content: word }))
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1843, completion_tokens: 96, total_tokens: 1939 },
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock model on http://127.0.0.1:${PORT}/v1`)
})
