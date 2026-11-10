// The frozen PyYAML fixture evidence for the Rule-frontmatter parser.
//
// PR #2's second review objected that the first round's tests were hand-written
// YAML and that the claimed wide round-trip lived only in a commit message.
// `scripts/gen-rule-fixtures.py` is the missing generator: it runs the installed
// OpenViking server's own PyYAML with the same options as
// `openviking/service/rule_service.py::_render_markdown`, serializes an invented
// corpus, parses it back with `yaml.safe_load`, and freezes both sides in
// `test/fixtures/rule-frontmatter.json`.
//
// This test is the committed evidence: it needs no Python, and it compares our
// TypeScript parser against PyYAML's own answer for every fixture. Regenerate
// the JSON (only when the corpus or PyYAML changes) with:
//
//   ~/.local/share/uv/tools/openviking/bin/python3 scripts/gen-rule-fixtures.py
//   ~/.local/share/uv/tools/openviking/bin/python3 scripts/gen-rule-fixtures.py --check
//
// All fixture content is invented; no real memory content is committed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseRuleDocument, ruleFactsFromDocument } from '../src/host/rule-format.ts'

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/rule-frontmatter.json', import.meta.url), 'utf8'),
)

/** Parse one frozen document the way the host reads a stored rule. */
function parseFixture(document) {
  return parseRuleDocument(`---\n${document.frontmatter}\n---\n\nbody of the rule\n`)
}

const byName = new Map(FIXTURE.documents.map((document) => [document.name, document]))

test('the fixture file records the server serializer, its options and invented content', () => {
  assert.equal(FIXTURE.generated_by, 'scripts/gen-rule-fixtures.py')
  assert.equal(FIXTURE.server_serializer, 'openviking/service/rule_service.py::_render_markdown')
  assert.match(FIXTURE.pyyaml_version, /^6\./, 'generated with the server-era PyYAML')
  // The option names the review corrected (allow_unicode, not all_unicode).
  assert.equal(FIXTURE.safe_dump_options.allow_unicode, true)
  assert.equal(FIXTURE.safe_dump_options.sort_keys, false)
  assert.equal(FIXTURE.safe_dump_options.default_flow_style, false)
  assert.equal(FIXTURE.safe_dump_options.width, 80, "PyYAML's default fold width")
  assert.match(FIXTURE.content_policy, /invented/i)
  assert.ok(Array.isArray(FIXTURE.documents) && FIXTURE.documents.length >= 20)
  const names = FIXTURE.documents.map((document) => document.name)
  assert.equal(new Set(names).size, names.length, 'fixture names are unique')
  // The named shapes from both review rounds must stay in the corpus; losing one
  // would quietly stop covering the bug it was added for.
  for (const required of [
    'review-b1-wrapped-plain',
    'review-n1-apostrophe-fold',
    'review-n2-multi-paragraph-quoted',
    'double-quoted-escaped-break',
  ]) {
    assert.ok(byName.has(required), `the corpus keeps the ${required} shape`)
  }
})

test('the corpus actually contains PyYAML-wrapped and quoted-folded documents', () => {
  // If a PyYAML upgrade stopped wrapping, these fixtures would stop exercising
  // the continuation parser; fail loudly instead of passing vacuously.
  const wrapped = FIXTURE.documents.filter((document) => /\n\s+\S/.test(document.frontmatter))
  assert.ok(wrapped.length >= 8, `expected wrapped fixture documents, saw ${wrapped.length}`)
  const quotedFolded = FIXTURE.documents.filter(
    (document) =>
      /\n\s+\S/.test(document.frontmatter) && /(^|\n)\w+:\s*['"]/.test(document.frontmatter),
  )
  assert.ok(quotedFolded.length >= 2, `expected quoted folded documents, saw ${quotedFolded.length}`)
})

test("every frozen document parses to PyYAML's own scalar values", () => {
  for (const document of FIXTURE.documents) {
    const parsed = parseFixture(document)
    for (const [key, expected] of Object.entries(document.expected)) {
      // The parser intentionally skips sequences (`source_uris`, `evidence`),
      // and null only appears for absent values; every scalar is compared.
      if (expected === null || typeof expected === 'object') continue
      assert.equal(parsed.fields[key], String(expected), `${document.name}: field ${key}`)
    }
    assert.match(parsed.body, /^body of the rule/, `${document.name}: body is preserved`)
  }
})

test('the named regression shapes come through complete (B1, N1 and N2)', () => {
  // B1: plain-scalar width folding.
  const b1 = byName.get('review-b1-wrapped-plain')
  const b1Fields = parseFixture(b1).fields
  assert.equal(b1Fields.content, b1.expected.content)
  assert.match(b1Fields.content, /unless the change is documentation-only\.$/)
  assert.match(b1Fields.description, /wraps onto a continuation line\.$/)
  assert.match(b1Fields.applies_when, /reported to another person as complete\.$/)
  assert.equal(b1Fields.exception, '')
  const b1Facts = ruleFactsFromDocument('viking://user/default/rules/x/rule.md', `---\n${b1.frontmatter}\n---\n`)
  assert.equal(b1Facts.constraint, b1.expected.content, 'the requirement fact is the full sentence')

  // N1: a single-quoted scalar whose fold lands after `dogs'` must not close early.
  const n1 = byName.get('review-n1-apostrophe-fold')
  const n1Fields = parseFixture(n1).fields
  assert.equal(n1Fields.content, n1.expected.content)
  assert.match(n1Fields.content, /dogs' toys and more text that keeps going/)
  assert.equal(n1Fields.content.includes('\n'), false, 'the value stays one logical line')

  // N2: a blank line inside a quoted scalar is a newline in the value.
  const n2 = byName.get('review-n2-multi-paragraph-quoted')
  const n2Fields = parseFixture(n2).fields
  assert.equal(n2Fields.content, n2.expected.content)
  assert.match(n2Fields.content, /\n\nSecond line that is also quite long/)
  assert.equal(n2Fields.content.startsWith('First line of the rule.'), true)

  // The double-quoted escaped-break shape stays a tab plus one sentence, with no
  // leftover escape characters or backslashes.
  const dq = byName.get('double-quoted-escaped-break')
  const dqFields = parseFixture(dq).fields
  assert.equal(dqFields.content, dq.expected.content)
  assert.match(dqFields.content, /\t/)
  assert.equal(dqFields.content.includes('\\'), false)
})
