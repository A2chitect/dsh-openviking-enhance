/**
 * Non-empty host warnings, rendered instead of swallowed.
 *
 * A read that degraded is not an empty read: a `staleDirectory` warning means
 * "this path moved since the tree page was listed", and an unsupported/older
 * server answer means "this build cannot list it". Rendering both as "nothing
 * here" is a lie the v0.7 review caught, so the native views collect the host's
 * `warnings[]` into this collapsed row: the count is visible, the translated
 * reason is one click away, and an empty list still renders nothing at all.
 *
 * Uses native `<details>` (no hooks) so the server-render harness can pin it.
 */
import type { PluginNotice } from '../shared/protocol.ts'
import { noticeText, t } from './locale.ts'

export interface NativeWarningsProps {
  warnings: readonly PluginNotice[]
  /** Locale key for the summary line; the native views share one. */
  labelKey?: string
}

export function NativeWarnings({ warnings, labelKey = 'native.warnings.summary' }: NativeWarningsProps) {
  if (warnings.length === 0) return null
  return (
    <details
      className="ove-nat-warnings-box"
      data-dsh-plugin="openviking-enhance-warnings"
      role="status"
      aria-live="polite"
    >
      <summary>{t(labelKey, { count: warnings.length })}</summary>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>{noticeText(warning)}</li>
        ))}
      </ul>
    </details>
  )
}
