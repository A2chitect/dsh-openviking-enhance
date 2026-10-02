/**
 * The OpenViking Studio panel.
 *
 * Mounted twice by `index.tsx`, as the shell requires for a global panel:
 *   - `sidebar.panellist`  — renders only the icon glyph (the shell owns the
 *     button, label, tooltip and active state);
 *   - `main` keyed `openviking` — renders this page in the centre column when
 *     that sidebar row is selected.
 *
 * The panel is a plain iframe onto the OpenViking server's own origin. That is
 * viable only because the server is a *different* origin from the GUI and sends
 * no frame-blocking headers:
 *   - `GET /studio/` on OpenViking 0.4.22 sets no `X-Frame-Options` and no CSP;
 *   - the only `frame-ancestors 'none'` in the server is the OAuth consent page;
 *   - CORS echoes the GUI origin, so Studio's own `fetch` calls keep working.
 * Do NOT add a `sandbox` attribute: Studio is a same-origin SPA that relies on
 * `localStorage` and relative `/api/v1` calls. If a sandbox is ever required,
 * mirror the shell's token list, which includes `allow-same-origin`.
 */
import { useCallback, useEffect, useState } from 'react'
import type { EnhanceConfig } from '../shared/protocol.ts'
import { fetchConfig } from './host-api.ts'

/**
 * The panel page. `nonce` forces the iframe to remount on refresh, which is the
 * only way to reload a cross-origin frame without touching its `src`.
 */
export function StudioPanel() {
  const [config, setConfig] = useState<EnhanceConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(async () => {
    const result = await fetchConfig()
    if (result.ok) {
      setConfig(result)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div className="ove-panel">
        <div className="ove-notice">
          <h4>OpenViking 面板不可用</h4>
          <p>{error}</p>
          <p className="ove-empty">宿主路由未响应；确认插件已在 profile 中启用后重载界面。</p>
        </div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="ove-panel">
        <div className="ove-notice ove-empty">正在连接 OpenViking…</div>
      </div>
    )
  }

  return (
    <div className="ove-panel" data-dsh-plugin="openviking-enhance">
      <div className="ove-toolbar">
        <span className={`ove-dot ${config.healthy ? 'ove-dot-ok' : 'ove-dot-bad'}`} />
        <span className="ove-title">OpenViking Studio</span>
        <span className="ove-empty">{config.version ? `v${config.version}` : '未连接'}</span>
        <span className="ove-empty">{`${config.account}/${config.user}`}</span>
        <span className="ove-spacer" />
        <button type="button" onClick={() => setNonce((n) => n + 1)} title="重新加载面板">
          刷新
        </button>
        <button
          type="button"
          onClick={() => window.open(config.studioUrl, '_blank', 'noopener,noreferrer')}
          title="在新标签页打开"
        >
          新标签页
        </button>
      </div>
      {config.warnings.length > 0 ? (
        <div className="ove-notice" style={{ padding: '8px 12px', fontSize: 12, opacity: 0.75 }}>
          {config.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      ) : null}
      <iframe
        key={nonce}
        className="ove-iframe"
        src={config.studioUrl}
        title="OpenViking Studio"
        referrerPolicy="no-referrer"
        allow="clipboard-write"
      />
    </div>
  )
}
