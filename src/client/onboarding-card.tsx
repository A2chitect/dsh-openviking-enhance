/**
 * The first-run onboarding checklist, surfaced in two places from one component
 * family:
 *
 *  - `OnboardingCard` in the native Overview (full checklist, dismissible);
 *  - `OnboardingSetupSection` as a second `plugins.detail.section` on the
 *    plugin's Plugins page (compact status + "Open setup" + "Reset setup").
 *
 * Both are read-only: they display the cheap checks the composed `/overview`
 * response already carries and, on request, run the existing Doctor probe
 * (`/doctor?probe=1`). The only write is the plugin's own local
 * `onboarding.json` through the same-origin guarded POST — never OpenViking.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DoctorReport,
  OnboardingCheck,
  OnboardingPayload,
  OnboardingState,
} from '../shared/protocol.ts'
import { fetchDoctor, fetchOverview, postOnboardingState } from './host-api.ts'
import { canSelectPanel, openNative } from './native-store.ts'
import { openRightTab } from './tab-store.ts'
import { errorText, t, writeErrorText } from './locale.ts'

const PACKAGE_NAME = 'dsh-openviking-enhance'
const ROW_ID = 'openviking-enhance'

/** Count the checklist by status for the one-line summaries. */
export function onboardingCounts(checks: readonly OnboardingCheck[]): { ok: number; warn: number; error: number; total: number } {
  let ok = 0
  let warn = 0
  let error = 0
  for (const check of checks) {
    if (check.status === 'ok') ok += 1
    else if (check.status === 'warn') warn += 1
    else if (check.status === 'error') error += 1
  }
  return { ok, warn, error, total: checks.length }
}

/** The status glyph: one class per check state. */
function statusTone(status: OnboardingCheck['status']): string {
  if (status === 'ok') return 'ove-onb-tone-ok'
  if (status === 'warn') return 'ove-onb-tone-warn'
  if (status === 'error') return 'ove-onb-tone-bad'
  return 'ove-onb-tone-unknown'
}

function statusGlyph(status: OnboardingCheck['status']): string {
  if (status === 'ok') return '✓'
  if (status === 'warn') return '!'
  if (status === 'error') return '×'
  return '?'
}

/** One checklist row: status, label, hint/detail, and a local "done" toggle. */
function CheckRow(props: {
  check: OnboardingCheck
  completed: boolean
  disabled: boolean
  onComplete: () => void
}) {
  const { check } = props
  const hint = check.hintKey === null ? null : t(check.hintKey)
  return (
    <li className="ove-onb-row" data-check={check.id}>
      <span className={`ove-onb-dot ${statusTone(check.status)}`} aria-hidden="true">
        {statusGlyph(check.status)}
      </span>
      <span className="ove-onb-text">
        <span className="ove-onb-label">
          {t(check.labelKey)}
          {check.detail !== null && <span className="ove-onb-detail">{check.detail}</span>}
        </span>
        {hint !== null && <span className="ove-onb-hint">{hint}</span>}
      </span>
      <span className="ove-onb-row-actions">
        {props.completed ? (
          <span className="ove-onb-badge">{t('native.onboarding.done')}</span>
        ) : check.status !== 'ok' ? (
          <button type="button" className="ove-onb-button" disabled={props.disabled} onClick={props.onComplete}>
            {t('native.onboarding.markDone')}
          </button>
        ) : (
          <span className="ove-onb-badge ove-onb-badge-ok">{t('native.onboarding.ok')}</span>
        )}
      </span>
    </li>
  )
}

/** The counts line after a full Doctor run. */
function fullCheckLine(report: DoctorReport): { ok: number; warn: number; error: number } {
  return {
    ok: report.checks.filter((check) => check.status === 'ok').length,
    warn: report.checks.filter((check) => check.status === 'warn').length,
    error: report.checks.filter((check) => check.status === 'error').length,
  }
}

export interface OnboardingCardProps {
  onboarding: OnboardingPayload | null
  /** The `showOnboarding` switch (default true). */
  enabled: boolean
  /** Called after a state POST succeeds, with the new persisted state. */
  onStateChange: (state: OnboardingState) => void
}

/**
 * The full checklist card. Renders a one-line summary when dismissed, and the
 * checklist itself while it is open.
 */
export function OnboardingCard(props: OnboardingCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  if (!props.enabled) return null
  const onboarding = props.onboarding
  if (onboarding === null) return null
  const counts = onboardingCounts(onboarding.checks)
  const state = onboarding.state
  const dismissed = state.dismissedAt !== null
  const notOk = counts.error + counts.warn
  if (dismissed && !expanded) {
    return (
      <section className="ove-onb ove-onb-collapsed" data-dsh-plugin="openviking-enhance-onboarding">
        <span className={`ove-onb-dot ${notOk > 0 ? 'ove-onb-tone-warn' : 'ove-onb-tone-ok'}`} aria-hidden="true">
          {notOk > 0 ? '!' : '✓'}
        </span>
        <span className="ove-onb-collapsed-text">{t('native.onboarding.collapsed', { ok: counts.ok, total: counts.total })}</span>
        <span className="ove-onb-spacer" />
        <button type="button" className="ove-onb-button" onClick={() => setExpanded(true)}>
          {t('native.onboarding.show')}
        </button>
      </section>
    )
  }

  const submit = async (request: Parameters<typeof postOnboardingState>[0]): Promise<boolean> => {
    setBusy(true)
    setNote(null)
    try {
      const answer = await postOnboardingState(request)
      if (!answer.ok) {
        setNote(writeErrorText(answer.error))
        return false
      }
      props.onStateChange(answer.state)
      if (answer.writeError !== null) {
        setNote(t('native.onboarding.writeFailed', { error: answer.writeError }))
        return false
      }
      return true
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const completeStep = async (stepId: string): Promise<void> => {
    await submit({ action: 'complete-step', stepId })
  }

  const dismiss = async (): Promise<void> => {
    const ok = await submit({ action: 'dismiss' })
    if (ok) setExpanded(false)
  }

  /** "Run full check": the existing Doctor probe, then record the counts locally. */
  const runFullCheck = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    setCheckError(null)
    try {
      const answer = await fetchDoctor(undefined, { probe: true })
      if (!answer.ok) {
        setCheckError(errorText(answer.error))
        return
      }
      const result = fullCheckLine(answer.report)
      const saved = await postOnboardingState({ action: 'full-check', ...result })
      if (!saved.ok) {
        setNote(writeErrorText(saved.error))
        return
      }
      props.onStateChange(saved.state)
      setNote(t('native.onboarding.fullCheckDone', { ok: result.ok, warn: result.warn, error: result.error }))
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const firstStepHint =
    onboarding.checks.find((check) => check.id === 'firstStep')?.hintKey ?? null

  return (
    <section className="ove-onb" data-dsh-plugin="openviking-enhance-onboarding">
      <div className="ove-onb-head">
        <span className="ove-onb-title">{t('native.onboarding.title')}</span>
        <span className="ove-onb-counts">{t('native.onboarding.counts', { ok: counts.ok, total: counts.total })}</span>
        <span className="ove-onb-spacer" />
        <button type="button" className="ove-onb-button" disabled={busy} onClick={() => void dismiss()}>
          {t('native.onboarding.dismiss')}
        </button>
      </div>
      <p className="ove-onb-intro">{t('native.onboarding.intro')}</p>
      {firstStepHint !== null && <p className="ove-onb-first-step">{t(firstStepHint)}</p>}
      <ul className="ove-onb-list">
        {onboarding.checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            completed={state.completedStepIds.includes(check.id)}
            disabled={busy}
            onComplete={() => void completeStep(check.id)}
          />
        ))}
      </ul>
      <div className="ove-onb-actions">
        <button type="button" className="ove-onb-primary" disabled={busy} onClick={() => void runFullCheck()}>
          {t('native.onboarding.runFullCheck')}
        </button>
        <button type="button" className="ove-onb-button" onClick={() => openRightTab('openviking-health')}>
          {t('native.onboarding.openDoctor')}
        </button>
        {state.lastFullCheck !== null && (
          <span className="ove-onb-last-check">
            {t('native.onboarding.lastFullCheck', {
              at: state.lastFullCheck.at,
              ok: state.lastFullCheck.ok,
              warn: state.lastFullCheck.warn,
              error: state.lastFullCheck.error,
            })}
          </span>
        )}
      </div>
      {note !== null && <p className="ove-onb-hint">{note}</p>}
      {checkError !== null && <p className="ove-onb-error">{checkError}</p>}
      <p className="ove-onb-privacy">{t('native.onboarding.privacy')}</p>
    </section>
  )
}

type DetailProps = PropsRuntime<'plugins.detail.section'>

/** Whether this Plugins page belongs to this plugin. */
export function isOurPluginPage(subject: DetailProps['subject']): boolean {
  if (subject.kind === 'item') return false
  if (subject.pkg.name !== PACKAGE_NAME) return false
  return subject.kind === 'bundle' || subject.row.rowId === ROW_ID
}

/**
 * The compact Plugins-page Setup card.
 *
 * Shows a status line and, when the shell exposes the layout action, an "Open
 * setup" button that selects the native panel's Overview. On older DSH
 * generations without `selectPanel` the button is hidden; the status line (and
 * the Doctor's Memory health tab) remains the setup surface.
 */
export function OnboardingSetupSection(props: DetailProps) {
  return isOurPluginPage(props.subject) ? <OnboardingSetupSummary /> : null
}

function OnboardingSetupSummary() {
  const [onboarding, setOnboarding] = useState<OnboardingPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (fresh = false): Promise<void> => {
    const answer = await fetchOverview(fresh)
    if (answer.ok) {
      setOnboarding(answer.overview.onboarding)
      setError(null)
    } else {
      setError(writeErrorText(answer.error))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load().then(() => {
      if (cancelled) return
    })
    return () => {
      cancelled = true
    }
  }, [load])

  const reset = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const answer = await postOnboardingState({ action: 'reset' })
      if (!answer.ok) {
        setNote(writeErrorText(answer.error))
        return
      }
      await load(true)
      setNote(t('native.onboarding.resetDone'))
    } finally {
      setBusy(false)
    }
  }

  const counts = onboarding === null ? null : onboardingCounts(onboarding.checks)
  return (
    <section className="ove-plugin-health ove-onb-setup" data-dsh-plugin="openviking-enhance-setup">
      <div className="ove-health-section-title">{t('native.onboarding.setupTitle')}</div>
      {error !== null ? (
        <p className="ove-health-error">{t('native.onboarding.setupFailed', { error })}</p>
      ) : counts === null ? (
        <p className="ove-health-hint">{t('native.onboarding.loading')}</p>
      ) : (
        <>
          <div className="ove-health-meta">
            <span className={`ove-onb-dot ${counts.error > 0 ? 'ove-onb-tone-bad' : counts.warn > 0 ? 'ove-onb-tone-warn' : 'ove-onb-tone-ok'}`} aria-hidden="true">
              {counts.error > 0 ? '×' : counts.warn > 0 ? '!' : '✓'}
            </span>
            <span>{t('native.onboarding.setupLine', { ok: counts.ok, total: counts.total })}</span>
            <span className="ove-health-spacer" />
            {canSelectPanel() && (
              <button
                type="button"
                className="ove-health-button"
                onClick={() => openNative({ view: 'overview' })}
              >
                {t('native.onboarding.openSetup')}
              </button>
            )}
          </div>
          {onboarding !== null && onboarding.state.dismissedAt !== null && (
            <p className="ove-health-hint">{t('native.onboarding.dismissedHint')}</p>
          )}
          {onboarding !== null && onboarding.state.lastFullCheck !== null && (
            <p className="ove-health-hint">
              {t('native.onboarding.lastFullCheck', {
                at: onboarding.state.lastFullCheck.at,
                ok: onboarding.state.lastFullCheck.ok,
                warn: onboarding.state.lastFullCheck.warn,
                error: onboarding.state.lastFullCheck.error,
              })}
            </p>
          )}
          {onboarding !== null && onboarding.checks.some((check) => check.status !== 'ok') && (
            <ul className="ove-onb-list ove-onb-list-compact">
              {onboarding.checks
                .filter((check) => check.status !== 'ok')
                .slice(0, 3)
                .map((check) => (
                  <li key={check.id} className="ove-onb-row" data-check={check.id}>
                    <span className={`ove-onb-dot ${statusTone(check.status)}`} aria-hidden="true">
                      {statusGlyph(check.status)}
                    </span>
                    <span className="ove-onb-text">
                      <span className="ove-onb-label">{t(check.labelKey)}</span>
                      {check.hintKey !== null && <span className="ove-onb-hint">{t(check.hintKey)}</span>}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <div className="ove-onb-actions">
            <button type="button" className="ove-health-button" disabled={busy} onClick={() => void reset()}>
              {t('native.onboarding.resetSetup')}
            </button>
          </div>
          {note !== null && <p className="ove-health-hint">{note}</p>}
          <p className="ove-health-hint">{t('native.onboarding.privacy')}</p>
        </>
      )}
    </section>
  )
}
