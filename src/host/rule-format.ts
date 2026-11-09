/**
 * The Rule document format, as OpenViking 0.5.3 stores it.
 *
 * A Rule is a Markdown file whose YAML frontmatter carries the retrieval facts
 * and whose body carries the long-form text:
 *
 *   ---
 *   schema: openviking.rule/v1
 *   atomic_id: 3f1c…
 *   revision: 2
 *   status: active            # active | paused | archived
 *   scenario_id: coding
 *   name: Run the test suite before reporting done
 *   description: …
 *   confidence: 0.82
 *   content: Run the full test suite before reporting a change as complete.
 *   applies_when: The task modifies source code.
 *   exception: The change is documentation-only.
 *   ---
 *   …body…
 *
 * `POST /api/v1/rules/search` returns these files verbatim in `rules[].content`
 * with `atomic_id`/`revision`/`scenario_id`/`probability` beside them. The rule
 * *list* is a filesystem tree (`viking://~/memories/rules/<scenario>/<id>.md`),
 * so the same parser serves both paths.
 *
 * The parser is deliberately small and tolerant: this is display data for a
 * read-only tester, and a server-side format addition must not blank the whole
 * panel. Unparseable frontmatter degrades to "the whole text is the body", and
 * unknown keys are ignored rather than validated.
 */

/** One frontmatter block: scalar fields plus the Markdown body after it. */
export interface ParsedRuleDocument {
  fields: Record<string, string>
  body: string
}

const DELIMITER = '---'

/** Strip one layer of single or double quotes from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** `key: value` on one line, or null when the line is not a mapping entry. */
function keyValue(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
  if (match === null) return null
  return { key: match[1] as string, value: match[2] as string }
}

/**
 * Parse a frontmatter document.
 *
 * Only the subset the Rule format uses is understood: scalar `key: value`
 * lines, quoted scalars, and the block scalars `|` / `>` (with the usual
 * `-`/`+` chomping spellings). Sequence values are skipped, because no field
 * this plugin reads is a list. Everything from the closing delimiter on is the
 * body, unmodified apart from one leading blank line.
 */
export function parseRuleDocument(text: string): ParsedRuleDocument {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines.length === 0 || lines[0]?.trim() !== DELIMITER) {
    return { fields: {}, body: normalized }
  }

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === DELIMITER || line.trim() === '...') {
      close = index
      break
    }
  }
  if (close === -1) return { fields: {}, body: normalized }

  const fields: Record<string, string> = {}
  let blockKey: string | null = null
  let blockStyle: 'literal' | 'folded' = 'literal'
  let blockLines: string[] = []

  /** Commit the pending block scalar into its field. */
  const flushBlock = (): void => {
    if (blockKey === null) return
    const joined = blockStyle === 'literal' ? blockLines.join('\n') : blockLines.join(' ')
    fields[blockKey] = joined.trim()
    blockKey = null
    blockLines = []
  }

  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      if (blockKey !== null) blockLines.push('')
      continue
    }
    const indented = /^\s/.test(line)
    if (blockKey !== null && indented) {
      blockLines.push(line.replace(/^\s+/, ''))
      continue
    }
    flushBlock()

    const entry = keyValue(line)
    if (entry === null) continue
    const raw = entry.value.trim()
    const block = /^([|>])([+-]?)$/.exec(raw)
    if (block !== null) {
      blockKey = entry.key
      blockStyle = block[1] === '>' ? 'folded' : 'literal'
      blockLines = []
      continue
    }
    if (raw.length === 0) {
      // Could be a sequence (`key:` then `- item` lines); no field this plugin
      // reads is a list, so it degrades to an empty scalar.
      fields[entry.key] = ''
      continue
    }
    fields[entry.key] = unquote(raw)
  }
  flushBlock()

  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')
  return { fields, body }
}

/** The facts the UI shows for one rule, parsed out of its document. */
export interface RuleFacts {
  id: string
  uri: string
  revision: number | null
  scenario: string | null
  probability: number | null
  name: string
  constraint: string
  appliesWhen: string | null
  exception: string | null
  status: string | null
  body: string
}

/** The rule states the format defines; anything else is `unknown`. */
export const RULE_STATUSES = ['active', 'paused', 'archived'] as const
export type RuleStatus = (typeof RULE_STATUSES)[number] | 'unknown'

/** One status, normalized; a missing or newer status is `unknown`, never a gap. */
export function normalizeRuleStatus(raw: string | null | undefined): RuleStatus {
  const value = (raw ?? '').trim().toLowerCase()
  return (RULE_STATUSES as readonly string[]).includes(value) ? (value as RuleStatus) : 'unknown'
}

/** A number out of a frontmatter scalar, or null. */
function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** A trimmed scalar, or null when empty. */
function textOrNull(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  return value.length > 0 ? value : null
}

/**
 * Build the display facts for one rule document.
 *
 * `overrides` carries the fields the search reply has at the top level
 * (`atomic_id`, `revision`, `scenario_id`, `probability`, `uri`); the document's
 * own frontmatter wins for everything else, because it is the stored source of
 * truth. A rule with no `content` field falls back to the first non-empty body
 * paragraph, so the tester never shows a blank requirement.
 */
export function ruleFactsFromDocument(
  uri: string,
  text: string,
  overrides: {
    id?: string | undefined
    revision?: number | undefined
    scenario?: string | undefined
    probability?: number | undefined
    name?: string | undefined
  } = {},
): RuleFacts {
  const { fields, body } = parseRuleDocument(text)
  // The fallback requirement is the first real body paragraph. A leading
  // `# <name>` heading is a title, not a constraint, so it is skipped rather
  // than flattened into the row.
  const bodyParagraph = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !/^#{1,6}\s/.test(paragraph))
    .map((paragraph) => paragraph.replace(/^#+\s*/gm, '').trim())
    .find((paragraph) => paragraph.length > 0)
  const constraint = textOrNull(fields.content) ?? bodyParagraph ?? ''
  return {
    id: (overrides.id ?? fields.atomic_id ?? '').trim(),
    uri,
    revision: overrides.revision ?? numberOrNull(fields.revision),
    scenario: textOrNull(overrides.scenario) ?? textOrNull(fields.scenario_id),
    probability: overrides.probability ?? null,
    name:
      textOrNull(overrides.name) ??
      textOrNull(fields.name) ??
      textOrNull(fields.atomic_id) ??
      uri.split('/').pop() ??
      uri,
    constraint,
    appliesWhen: textOrNull(fields.applies_when),
    exception: textOrNull(fields.exception),
    status: textOrNull(fields.status),
    body,
  }
}

/** One rule file as `GET /rules` lists it. */
export interface ParsedRuleFile {
  document: ParsedRuleDocument
  facts: RuleFacts
}

/** Parse one rule file discovered under the rules tree. */
export function parseRuleFile(uri: string, text: string, scenarioId: string | null): ParsedRuleFile {
  const document = parseRuleDocument(text)
  const facts = ruleFactsFromDocument(uri, text, {
    ...(scenarioId === null ? {} : { scenario: scenarioId }),
  })
  return { document, facts }
}

/** The scenario metadata a `<scenario>/abstract.md` carries. */
export interface ScenarioMeta {
  id: string
  name: string
  description: string
}

/** Parse one scenario's `abstract.md`; unknown or missing fields degrade to the id. */
export function parseScenarioMeta(id: string, text: string): ScenarioMeta {
  const { fields } = parseRuleDocument(text)
  return {
    id: (fields.scenario_id ?? id).trim() || id,
    name: (fields.name ?? id).trim() || id,
    description: (fields.description ?? '').trim(),
  }
}
