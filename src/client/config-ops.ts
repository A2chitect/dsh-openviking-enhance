/**
 * What a configuration form's staged edits become on the wire.
 *
 * This is the part of the form that decides what the host is actually asked to
 * do, and it is deliberately not a React concern: clearing a field is an `unset`
 * (which restores the layer beneath) rather than a write of an empty string,
 * numbers are parsed, and a value the schema cannot accept is refused before any
 * request leaves. Keeping it here means `test/config-ops.test.mjs` can pin those
 * three rules without rendering anything.
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** The slice of a field this module needs. */
export interface ConfigOpField {
  readonly key: string
  /** A field the schema declares as a number. */
  readonly numeric?: boolean
}

export type ConfigOpsResult =
  | { readonly ok: true; readonly ops: SettingsPathOpView[] }
  /** The field whose staged value cannot be submitted. */
  | { readonly ok: false; readonly field: string }

/**
 * Every staged edit as one atomic operation list.
 *
 * An empty string is `unset` — the form's "Default" button stages one, and so
 * does clearing the input by hand. Anything else is a `set`, with numbers parsed
 * so a numeric field cannot send `"2500"` where the schema expects `2500`.
 *
 * A field the caller staged but does not describe is ignored rather than guessed
 * at: the caller's field table is the schema's shape, and inventing an entry for
 * an unknown key would write something nobody declared.
 */
export function configOps(
  fields: readonly ConfigOpField[],
  draft: Readonly<Record<string, string>>,
): ConfigOpsResult {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const ops: SettingsPathOpView[] = []
  for (const [key, staged] of Object.entries(draft)) {
    const field = byKey.get(key)
    if (field === undefined) continue
    if (staged.length === 0) {
      ops.push({ op: 'unset', path: [key] })
      continue
    }
    if (field.numeric === true) {
      // `Number('')` is 0 and `Number(' ')` is 0, which is why the empty case is
      // handled above rather than by this parse.
      const parsed = Number(staged)
      if (!Number.isFinite(parsed)) return { ok: false, field: key }
      ops.push({ op: 'set', path: [key], value: parsed })
      continue
    }
    ops.push({ op: 'set', path: [key], value: staged })
  }
  return { ok: true, ops }
}
