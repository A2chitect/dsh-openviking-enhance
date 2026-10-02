// The copy layer's contract, as tests.
//
// `t()` returns the key itself when a key is missing, which makes a typo visible
// in the interface instead of rendering an empty element — but it also means a
// typo ships silently. These tests turn that into a build failure: every key the
// components ask for must exist, in both languages, and the two dictionaries must
// describe exactly the same set.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { DICTS, activeLocale, attachLocale, t } from '../src/client/locale.ts'

const clientDir = new URL('../src/client/', import.meta.url)
const sources = readdirSync(clientDir)
  .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
  .filter((name) => name !== 'locale.ts')
  .map((name) => ({ name, text: readFileSync(new URL(name, clientDir), 'utf8') }))

/** Every `t('key')` call in the client half. */
function calledKeys() {
  const keys = new Set()
  for (const { text } of sources) {
    for (const match of text.matchAll(/\bt\('([^']+)'/g)) keys.add(match[1])
    // Keys also live in tables the components read through `t(...)`.
    for (const match of text.matchAll(/^\s+(?:label|hint): '([a-z][\w.]*)',$/gm)) keys.add(match[1])
    for (const match of text.matchAll(/^\s+(?:memories|resources|skills): '([a-z][\w.]*)',$/gm)) keys.add(match[1])
  }
  return keys
}

test('both dictionaries describe exactly the same keys', () => {
  const zh = Object.keys(DICTS.zh).sort()
  const en = Object.keys(DICTS.en).sort()
  assert.deepEqual(zh.filter((key) => !(key in DICTS.en)), [], 'keys missing from en')
  assert.deepEqual(en.filter((key) => !(key in DICTS.zh)), [], 'keys missing from zh')
  assert.ok(zh.length > 50, `expected the plugin's whole copy, saw ${zh.length} keys`)
})

test('every key the components ask for exists', () => {
  const keys = [...calledKeys()]
  assert.ok(keys.length > 40, `expected the scan to find the copy, saw ${keys.length} keys`)
  const missing = keys.filter((key) => !(key in DICTS.en))
  assert.deepEqual(missing, [], `keys used but not defined: ${missing.join(', ')}`)
})

test('placeholders in a translation are the ones the key was given', () => {
  // A `{count}` left in the Chinese text but typed as `{total}` at the call site
  // renders the braces, which is the sort of thing only a test notices.
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(DICTS.en)) {
    assert.deepEqual(
      placeholders(DICTS.zh[key]),
      placeholders(DICTS.en[key]),
      `${key} uses different placeholders in zh and en`,
    )
  }
})

test('the language follows the app, then the browser, then English', () => {
  attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
  assert.equal(activeLocale(), 'zh')
  assert.equal(t('recall.search'), '检索')

  attachLocale({ getSnapshot: () => ({ active: 'en-US' }) })
  assert.equal(activeLocale(), 'en')
  assert.equal(t('recall.search'), 'Search')

  // An unknown language is not a reason to show nothing: English is the fallback
  // the README is written in.
  attachLocale({ getSnapshot: () => ({ active: 'fr' }) })
  assert.equal(t('recall.search'), 'Search')

  attachLocale(undefined)
  assert.equal(activeLocale() === 'zh' || activeLocale() === 'en', true)

  attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
})

test('a missing key and its placeholders stay visible', () => {
  attachLocale({ getSnapshot: () => ({ active: 'en' }) })
  // Returning the key is the point: a typo shows up as `recall.nope` in the UI.
  assert.equal(t('recall.nope'), 'recall.nope')
  assert.equal(t('recall.count', { count: 3 }), '3 entries')
  // A placeholder the copy does not use survives unchanged rather than vanishing.
  assert.equal(t('recall.count', { count: 3, other: 'x' }), '3 entries')
})
