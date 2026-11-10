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
 *
 * ## Folded scalars are the normal case, not an edge case
 *
 * The server serializes this block with
 * `yaml.safe_dump(..., allow_unicode=True, sort_keys=False, default_flow_style=False)`
 * (`openviking/service/rule_service.py::_render_markdown`), and PyYAML folds any
 * scalar longer than its default `width=80` onto continuation lines:
 *
 *   content: Run the full test suite before reporting a change as complete, unless the
 *     change is documentation-only.
 *
 * Every English rule longer than 80 characters therefore arrives wrapped. A
 * continuation line is indented, is not a `key: value` line, and is part of the
 * scalar that started above it; dropping it silently truncates the requirement,
 * `applies_when`, `exception` and `description`. The parser below folds those
 * lines back with a single space, for all three scalar styles PyYAML can emit
 * for such a value: plain, single-quoted and double-quoted (a quoted scalar's
 * closing quote may land on the last continuation line).
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
 * Whether a quoted scalar ends on this piece of text.
 *
 * For a double-quoted scalar a quote preceded by an odd number of backslashes
 * is escaped and does not close it.
 *
 * A single-quoted scalar escapes an embedded apostrophe by doubling it, so only
 * an ODD run of trailing quotes is the delimiter; an even run is content. This
 * matters exactly at a PyYAML fold: when the fold lands after `dogs'`, the line
 * ends `dogs''` and a naive "ends with quote" check would close the scalar one
 * line early and drop the rest of the value.
 *
 * `text` is the scalar CONTENT: callers pass `raw.slice(1)` rather than the raw
 * `key: <value>` suffix, so the opening delimiter can never be mistaken for a
 * doubled apostrophe (an empty `''` scalar closes immediately).
 */
function closesQuoted(text: string, quote: '"' | "'"): boolean {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(quote)) return false
  if (quote === "'") {
    let quotes = 0
    for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "'"; index -= 1) quotes += 1
    return quotes % 2 === 1
  }
  let backslashes = 0
  for (let index = trimmed.length - 2; index >= 0 && trimmed[index] === '\\'; index -= 1) backslashes += 1
  return backslashes % 2 === 0
}

/** How many backslashes a string ends with (an odd count escapes the line break). */
function trailingBackslashes(text: string): number {
  let count = 0
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) count += 1
  return count
}

/** Decode the escape sequences PyYAML emits inside a double-quoted scalar. */
function decodeDoubleQuoted(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = value[index + 1]
    index += 1
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '"':
        out += '"'
        break
      case '\\':
        out += '\\'
        break
      case ' ':
        out += ' '
        break
      case undefined:
        out += '\\'
        break
      default:
        // Unknown escape: keep it visible rather than swallowing the character.
        out += `\\${next}`
        break
    }
  }
  return out
}

/**
 * Parse a frontmatter document.
 *
 * Only the subset the Rule format uses is understood: scalar `key: value`
 * lines, quoted scalars, and the block scalars `|` / `>` (with the usual
 * `-`/`+` chomping spellings). On top of those, a *folded* scalar — the style
 * PyYAML writes for anything longer than 80 characters — is re-joined here:
 * an indented line while no block scalar or quoted scalar is open continues
 * the previous plain scalar with a single space, and a quoted scalar may span
 * several lines up to its closing quote.
 *
 * Sequence values are skipped, because no field this plugin reads is a list.
 * Everything from the closing delimiter on is the body, unmodified apart from
 * one leading blank line.
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
  /**
   * The field a folded plain scalar is being appended to, when the previous
   * `key: value` line's value was plain and may continue on indented lines.
   */
  let plainKey: string | null = null
  /**
   * An unterminated quoted scalar: its opening delimiter was on a `key:` line
   * and its closing delimiter may be on a later continuation line.
   */
  let quoted:
    | {
        key: string
        quote: '"' | "'"
        /** The scalar split at each fold; `joins[i-1]` separates parts[i-1] and parts[i]. */
        parts: string[]
        /** One separator before each part after the first ('' for an escaped line break). */
        joins: string[]
        /**
         * Newline(s) contributed by blank lines since the last folded segment.
         * A blank line inside a quoted scalar is a line break in the value
         * (PyYAML writes every `\n` as one blank line), not the end of the
         * scalar; the next segment joins with these newlines instead of a space.
         */
        pendingSeparator: string | null
      }
    | null = null

  /** Commit the pending block scalar into its field. */
  const flushBlock = (): void => {
    if (blockKey === null) return
    const joined = blockStyle === 'literal' ? blockLines.join('\n') : blockLines.join(' ')
    fields[blockKey] = joined.trim()
    blockKey = null
    blockLines = []
  }

  /** Commit an unterminated quoted scalar as far as it was read. */
  const flushQuoted = (): void => {
    if (quoted === null) return
    let joined = quoted.parts[0] ?? ''
    for (let index = 1; index < quoted.parts.length; index += 1) {
      joined += (quoted.joins[index - 1] ?? ' ') + (quoted.parts[index] ?? '')
    }
    fields[quoted.key] = quoted.quote === '"' ? decodeDoubleQuoted(joined) : joined.replace(/''/g, "'")
    quoted = null
  }

  /** A new mapping entry ends any folded scalar. */
  const endFoldedScalar = (): void => {
    flushQuoted()
    plainKey = null
  }

  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      if (blockKey !== null) blockLines.push('')
      else if (quoted !== null) {
        // An empty line inside a quoted scalar is a folded line break, not the
        // end of the scalar: `content` allows 16 000 characters, so a rule can
        // legitimately have several paragraphs. PyYAML represents each `\n` in
        // the value as one blank line, so their count is the separator.
        quoted.pendingSeparator = `${quoted.pendingSeparator ?? ''}\n`
      } else endFoldedScalar()
      continue
    }
    const indented = /^\s/.test(line)
    if (blockKey !== null && indented) {
      blockLines.push(line.replace(/^\s+/, ''))
      continue
    }
    if (quoted !== null && indented) {
      let piece = line.replace(/^\s+/, '')
      const closed = closesQuoted(piece, quoted.quote)
      if (closed) piece = piece.trimEnd().slice(0, -1)
      // A double-quoted line ending in an odd number of backslashes continues on
      // the next line with NO folded space (`\` at EOL is YAML's escaped line
      // break); PyYAML emits exactly that when it wraps a double-quoted scalar.
      let escapedBreak = false
      if (quoted.quote === '"') {
        const previous = quoted.parts[quoted.parts.length - 1] ?? ''
        if (trailingBackslashes(previous) % 2 === 1) {
          quoted.parts[quoted.parts.length - 1] = previous.slice(0, -1)
          escapedBreak = true
        }
      }
      const pendingSeparator = quoted.pendingSeparator
      quoted.pendingSeparator = null
      // A blank-line separator wins over the ordinary folded space; it is what
      // preserves multi-paragraph values.
      quoted.joins.push(pendingSeparator ?? (escapedBreak ? '' : ' '))
      quoted.parts.push(piece)
      if (closed) flushQuoted()
      continue
    }
    if (indented && plainKey !== null) {
      // PyYAML's width=80 folding: the continuation belongs to the previous
      // plain scalar and a line break folds to one space.
      const piece = line.replace(/^\s+/, '').trimEnd()
      fields[plainKey] = `${fields[plainKey] ?? ''} ${piece}`.trim()
      continue
    }

    flushBlock()
    endFoldedScalar()

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
    const opensDouble = raw.startsWith('"') && !closesQuoted(raw.slice(1), '"')
    const opensSingle = raw.startsWith("'") && !closesQuoted(raw.slice(1), "'")
    if (opensDouble || opensSingle) {
      // A quoted scalar can wrap too: its closing delimiter is on a later line.
      quoted = {
        key: entry.key,
        quote: opensDouble ? '"' : "'",
        parts: [raw.slice(1)],
        joins: [],
        pendingSeparator: null,
      }
      continue
    }
    if (raw.startsWith('"')) {
      fields[entry.key] = decodeDoubleQuoted(unquote(raw))
      continue
    }
    if (raw.startsWith("'")) {
      fields[entry.key] = unquote(raw).replace(/''/g, "'")
      continue
    }
    // A plain scalar: remembered in case the next line continues it.
    fields[entry.key] = raw
    plainKey = entry.key
  }
  flushBlock()
  flushQuoted()

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
