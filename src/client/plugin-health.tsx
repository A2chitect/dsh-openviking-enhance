/**
 * The compact health summary on this plugin's own page in the Plugins view.
 *
 * The full Doctor lives in the right-sidebar Memory health tab, which is
 * session-scoped. This section exists so a person who opens the plugin's page to
 * ask "is it working?" gets a first answer without hunting for a session, and it
 * renders nothing for any other plugin's page.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DoctorReport } from '../shared/protocol.ts'
import { fetchDoctor } from './host-api.ts'
import { noticeText, t } from './locale.ts'

const PACKAGE_NAME = 'dsh-openviking-enhance'
const ROW_ID = 'openviking-enhance'

type DetailProps = PropsRuntime<'plugins.detail.section'>

/** Whether this page is the plugin's own bundle or its loader row. */
export function isOurSubject(subject: DetailProps['subject']): boolean {
  if (subject.kind === 'item') return false
  if (subject.pkg.name !== PACKAGE_NAME) return false
  return subject.kind === 'bundle' || subject.row.rowId === ROW_ID
}

export function PluginHealthSection(props: DetailProps) {
  // Render nothing for other plugins. The no-result is decided before any hook
  // runs, so React never sees a conditional hook order on this page.
  return isOurSubject(props.subject) ? <PluginHealthSummary /> : null
}

function PluginHealthSummary() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchDoctor().then((answer) => {
      if (cancelled) return
      if (answer.ok) setReport(answer.report)
      else setError(answer.error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const ok = report?.checks.filter((check) => check.status === 'ok').length ?? 0
  const warn = report?.checks.filter((check) => check.status === 'warn').length ?? 0
  const bad = report?.checks.filter((check) => check.status === 'error').length ?? 0
  const tone = report === null ? 'ove-health-state-unknown' : bad > 0 ? 'ove-health-state-bad' : warn > 0 ? 'ove-health-state-warn' : 'ove-health-state-good'

  return (
    <section className="ove-plugin-health" data-dsh-plugin="openviking-enhance-health-summary">
      <div className="ove-health-section-title">{t('pluginHealth.title')}</div>
      {error !== null ? (
        <p className="ove-health-error">{t('pluginHealth.failed', { error })}</p>
      ) : report === null ? (
        <p className="ove-health-hint">{t('pluginHealth.loading')}</p>
      ) : (
        <>
          <div className="ove-health-meta">
            <span className={`ove-health-dot ${tone}`} />
            <span>
              {report.health.healthy
                ? t('pluginHealth.reachable', { version: report.health.version ?? '?' })
                : t('pluginHealth.unreachable')}
            </span>
            <span className="ove-health-spacer" />
            <span className="ove-health-hint">{`${ok} ok · ${warn} warn · ${bad} error`}</span>
          </div>
          <dl className="ove-health-facts">
            <dt>{t('pluginHealth.endpoint')}</dt>
            <dd>
              <code>{report.endpoint}</code>
            </dd>
            <dt>{t('pluginHealth.memoryPlugin')}</dt>
            <dd>{report.plugin.mounted ? report.plugin.version ?? t('pluginHealth.mounted') : t('pluginHealth.missing')}</dd>
            <dt>{t('pluginHealth.dsh')}</dt>
            <dd>{report.compatibility.dshVersion ?? t('health.unknown')}</dd>
            <dt>{t('pluginHealth.tested')}</dt>
            <dd>{report.compatibility.testedRange}</dd>
          </dl>
          {report.warnings.length > 0 ? (
            <div className="ove-health-hint">
              {report.warnings.slice(0, 3).map((warning, index) => (
                <div key={`${warning.code}-${index}`}>{noticeText(warning)}</div>
              ))}
            </div>
          ) : null}
          <p className="ove-health-hint">{t('pluginHealth.hint')}</p>
        </>
      )}
    </section>
  )
}
