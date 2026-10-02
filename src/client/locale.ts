/**
 * The plugin's own copy, in the two languages it speaks.
 *
 * DSH resolves the interface language for the whole app: `ctx.locale` (provided
 * by `@deepseek-ai/dsh-client-locale`) hands out the active locale, and a plugin
 * is expected to read it rather than to guess from the browser. This module owns
 * that single read plus the dictionaries; every component calls `t()`.
 *
 * Three deliberate choices:
 *
 *  - **English is the fallback**, not Chinese. Anyone whose locale is neither
 *    gets the language the plugin's README is written in first.
 *  - **A missing key returns the key**, so a typo shows up as `recall.plan` in
 *    the interface instead of silently rendering an empty element. The registry
 *    below is therefore also the complete list of copy the plugin ships.
 *  - **No `ctx.locale.register`.** That would publish these strings under a
 *    namespace for *other* plugins to translate through `ctx.locale.bind`, which
 *    nothing needs: this bundle is the only consumer of its own copy, and
 *    registering would freeze the dictionaries at load time for no gain.
 */
export type LocaleId = 'zh' | 'en'

/** What `ctx.locale` is used for here: the active locale id, live. */
export interface LocaleServiceLike {
  getSnapshot(): { active: string }
}

const zh: Record<string, string> = {
  // ---- Studio panel -------------------------------------------------------
  'panel.unavailable': 'OpenViking 面板不可用',
  'panel.unavailableHint': '宿主路由未响应；确认插件已在 profile 中启用后重载界面。',
  'panel.connecting': '正在连接 OpenViking…',
  'panel.notConnected': '未连接',
  'panel.reload': '重新加载面板',
  'panel.refresh': '刷新',
  'panel.openInTab': '在新标签页打开',
  'panel.newTab': '新标签页',

  // ---- Recall tab ---------------------------------------------------------
  'recall.tabTitle': '记忆召回',
  'recall.tabDescription': '本会话检索到的记忆、资源与技能',
  'recall.bucket.memories': '记忆',
  'recall.bucket.resources': '资源',
  'recall.bucket.skills': '技能',
  'recall.queryPlaceholder': '本会话最近一次提问',
  'recall.search': '检索',
  'recall.searchAgain': '重新检索',
  'recall.searchAgainHint': '重新检索（跳过缓存）',
  'recall.sourceSession': '本会话提问',
  'recall.sourceManual': '手动输入',
  'recall.count': '{count} 条',
  'recall.peerScoped': 'peer 检索',
  'recall.loadingFirst': '检索中…（服务端会做查询扩展，首次通常要几秒）',
  'recall.noQuery': '这个会话还没有可检索的提问。在上面输入内容后回车，即可看到会召回哪些记忆。',
  'recall.plan': '检索计划',
  'recall.showAll': '显示全部（另有 {count} 条）',
  'recall.targets': '检索范围（{count}）',
  'recall.searching': '检索中…',
  'recall.noHits': '无命中',
  'recall.loadingEntry': '载入中…',
  'recall.truncated': '内容过长，已截断显示。',

  // ---- Commit pill --------------------------------------------------------
  'pill.session': '会话',
  'pill.pending': '待提交',
  'pill.lastCommit': '最近提交',
  'pill.inProgress': '进行中',
  'pill.readFailed': '读取失败：{error}',
  'pill.failedExtractions': '记忆抽取失败 {count} 次',
  'pill.failedExtractionsHint': '归档已写入，但这几次提交的记忆没有被抽取出来。',
  'pill.moreFailures': '…另有 {count} 次失败',
  'pill.commits': '提交记录',
  'pill.commitsNewest': '（最近 {shown} / 共 {total} 次）',
  'pill.commitsTotal': '（{total} 次）',
  'pill.noCommits': '本会话尚无提交。达到 token 阈值或会话结束时自动提交。',
  'pill.affected': '影响 →',
  'pill.showAll': '显示全部 {total} 次',
  'pill.readingDiff': '正在读取 {archive}…',
  'pill.diffMissing': '该归档还没有 memory_diff.json —— 抽取仍在进行。',
  'pill.diffSummary': '影响记忆：新增 {adds} · 更新 {updates} · 删除 {deletes}',
  'pill.group.adds': '新增',
  'pill.group.updates': '更新',
  'pill.group.deletes': '删除',
  'pill.noMemoryChange': '本次提交未改变任何记忆。',
  'pill.detailTitle': 'OpenViking 提交详情',
  'pill.detailHeading': 'OpenViking 提交',
  'pill.commitCount': '{count} 次',
  'pill.phase.extracting': '抽取中…',
  'pill.phase.noDetail': '无明细',
  'pill.phase.unchanged': '未改变记忆',
  'pill.phase.unavailable': '不可用',
  'pill.phaseAdds': '{count} 新增',
  'pill.phaseUpdates': '{count} 更新',
  'pill.phaseDeletes': '{count} 删除',
  'pill.aria': 'OpenViking：{text}',
  'pill.groupTitle': '{title}（{count}）',
  'pill.label.failed': '不可用',
  'pill.label.errored': '抽取失败',
  'pill.label.extracting': '抽取中…',
  'pill.label.commits': '{count} 次提交',
  'pill.label.pending': '待提交',
  'pill.label.idle': '未提交',
  'pill.stageReason': '抽取失败（阶段：{stage}）',
  'pill.noReason': '抽取失败（服务端未给出原因）',
  'pill.tip.readFailed': 'OpenViking 读取失败：{error}',
  'pill.tip.reading': '正在读取 OpenViking 提交状态',
  'pill.tip.failure': '最近一次记忆抽取失败：{reason}',
  'pill.tip.session': 'OpenViking 会话：{id}',
  'pill.tip.commits': '已提交 {count} 次（其中 {failed} 次抽取失败）',
  'pill.tip.pending': '待提交 tokens：{tokens}',
  'pill.tip.commitCount': '提交次数：{count}',
  'pill.tip.lastCommit': '最近提交：{time}',

  // ---- Configuration page -------------------------------------------------
  'config.endpoint': 'OpenViking 地址',
  'config.endpointHint': '留空则读 ~/.openviking/ovcli.conf，再退回 http://127.0.0.1:1933',
  'config.apiKey': 'API Key',
  'config.apiKeyHint': '服务端开启鉴权时才需要；建议写在 ovcli.conf 里',
  'config.account': 'Account',
  'config.accountHint': '留空 = default',
  'config.user': 'User',
  'config.userHint': '留空 = default',
  'config.studioPath': 'Studio 路径',
  'config.studioPathHint': '默认 /studio/',
  'config.cacheTtl': '状态缓存（毫秒）',
  'config.cacheTtlHint': '默认 2500',
  'config.recallCacheTtl': '召回缓存（毫秒）',
  'config.recallCacheTtlHint': '默认 15000',
  'config.summaryUnset': 'OpenViking · 未配置地址',
  'config.loading': '正在读取配置…',
  'config.unavailable': '这个部署没有把本插件的配置暴露给客户端（远程 Web，或未挂载 settings），请在 profile 的 cordis.patch.yml 里配置。',
  'config.readonly': '当前 profile 不接受写入，下面只能查看。',
  'config.overridden': '已覆盖',
  'config.check': '检测',
  'config.default': '默认',
  'config.defaultHint': '清空该字段，恢复为默认',
  'config.checking': '检测中…',
  'config.probeOk': '连上了：OpenViking {version}',
  'config.probeVersionUnknown': '(版本未知)',
  'config.probeFailed': '连不上：{error}',
  'config.unknownError': '未知错误',
  'config.needNumber': '{label} 需要一个数字',
  'config.noChanges': '没有改动。',
  'config.saved': '已保存。宿主会在下一次组合时用上新值。',
  'config.refused': '宿主拒绝了这次修改（可能已被别处改动），你的改动还留在表单里。',
  'config.save': '保存',
  'notice.unreachable': 'OpenViking 不可达（{endpoint}）：{error}',
  'notice.noMemoryPlugin': '@openviking/dsh-memory-plugin 未挂载：会话 id 退回 "dsh-<session>"，提交阈值也读不到。',
  'notice.sessionFailed': '读取会话信息失败：{error}',
  'notice.noPrompt': '会话日志里没有找到最近的用户提问，请手动输入检索内容。',
  'notice.targetFailed': '检索 {target} 失败：{error}',
  'config.probeRefused': '地址必须是本机（loopback）的 http(s) 地址',
  'config.discard': '放弃改动',
}

const en: Record<string, string> = {
  // ---- Studio panel -------------------------------------------------------
  'panel.unavailable': 'OpenViking panel unavailable',
  'panel.unavailableHint': 'The host routes did not answer. Check that the plugin is enabled in your profile, then reload the window.',
  'panel.connecting': 'Connecting to OpenViking…',
  'panel.notConnected': 'not connected',
  'panel.reload': 'Reload the panel',
  'panel.refresh': 'Refresh',
  'panel.openInTab': 'Open in a new tab',
  'panel.newTab': 'New tab',

  // ---- Recall tab ---------------------------------------------------------
  'recall.tabTitle': 'Memory recall',
  'recall.tabDescription': 'What this session retrieves: memories, resources and skills',
  'recall.bucket.memories': 'Memories',
  'recall.bucket.resources': 'Resources',
  'recall.bucket.skills': 'Skills',
  'recall.queryPlaceholder': "This session's last prompt",
  'recall.search': 'Search',
  'recall.searchAgain': 'Search again',
  'recall.searchAgainHint': 'Search again (skip the cache)',
  'recall.sourceSession': 'from this session',
  'recall.sourceManual': 'typed',
  'recall.count': '{count} entries',
  'recall.peerScoped': 'peer-scoped',
  'recall.loadingFirst': 'Searching… the server expands the query, so the first answer usually takes a few seconds',
  'recall.noQuery': 'This session has no prompt to search with yet. Type one above and press Enter to see what would be recalled.',
  'recall.plan': 'Retrieval plan',
  'recall.showAll': 'Show all ({count} more)',
  'recall.targets': 'Searched ({count})',
  'recall.searching': 'Searching…',
  'recall.noHits': 'no hits',
  'recall.loadingEntry': 'Loading…',
  'recall.truncated': 'Truncated: the entry is longer than the viewer shows.',

  // ---- Commit pill --------------------------------------------------------
  'pill.session': 'Session',
  'pill.pending': 'Pending',
  'pill.lastCommit': 'Last commit',
  'pill.inProgress': 'Running',
  'pill.readFailed': 'Could not read: {error}',
  'pill.failedExtractions': '{count} failed extractions',
  'pill.failedExtractionsHint': 'The archives were written, but those commits were never turned into memories.',
  'pill.moreFailures': '…and {count} more failures',
  'pill.commits': 'Commits',
  'pill.commitsNewest': '(newest {shown} of {total})',
  'pill.commitsTotal': '({total})',
  'pill.noCommits': 'Nothing committed yet. A commit happens at the token threshold or when the session ends.',
  'pill.affected': 'Affected →',
  'pill.showAll': 'Show all {total}',
  'pill.readingDiff': 'Reading {archive}…',
  'pill.diffMissing': 'This archive has no memory_diff.json yet — extraction is still running.',
  'pill.diffSummary': 'Memories affected: {adds} added · {updates} updated · {deletes} deleted',
  'pill.group.adds': 'Added',
  'pill.group.updates': 'Updated',
  'pill.group.deletes': 'Deleted',
  'pill.noMemoryChange': 'This commit changed no memories.',
  'pill.detailTitle': 'OpenViking commit details',
  'pill.detailHeading': 'OpenViking commit',
  'pill.commitCount': '{count} commits',
  'pill.phase.extracting': 'extracting…',
  'pill.phase.noDetail': 'no detail',
  'pill.phase.unchanged': 'no memories changed',
  'pill.phase.unavailable': 'unavailable',
  'pill.phaseAdds': '{count} added',
  'pill.phaseUpdates': '{count} updated',
  'pill.phaseDeletes': '{count} deleted',
  'pill.aria': 'OpenViking: {text}',
  'pill.groupTitle': '{title} ({count})',
  'pill.label.failed': 'unavailable',
  'pill.label.errored': 'extraction failed',
  'pill.label.extracting': 'extracting…',
  'pill.label.commits': '{count} commits',
  'pill.label.pending': 'pending',
  'pill.label.idle': 'not committed',
  'pill.stageReason': 'extraction failed (stage: {stage})',
  'pill.noReason': 'extraction failed (the server gave no reason)',
  'pill.tip.readFailed': 'Could not read OpenViking: {error}',
  'pill.tip.reading': 'Reading OpenViking commit status',
  'pill.tip.failure': 'The last memory extraction failed: {reason}',
  'pill.tip.session': 'OpenViking session: {id}',
  'pill.tip.commits': '{count} commits ({failed} failed extractions)',
  'pill.tip.pending': 'Pending tokens: {tokens}',
  'pill.tip.commitCount': 'Commits: {count}',
  'pill.tip.lastCommit': 'Last commit: {time}',

  // ---- Configuration page -------------------------------------------------
  'config.endpoint': 'OpenViking address',
  'config.endpointHint': 'Empty reads ~/.openviking/ovcli.conf, then falls back to http://127.0.0.1:1933',
  'config.apiKey': 'API key',
  'config.apiKeyHint': 'Only needed when the server requires authentication; prefer keeping it in ovcli.conf',
  'config.account': 'Account',
  'config.accountHint': 'Empty = default',
  'config.user': 'User',
  'config.userHint': 'Empty = default',
  'config.studioPath': 'Studio path',
  'config.studioPathHint': 'Default /studio/',
  'config.cacheTtl': 'Status cache (ms)',
  'config.cacheTtlHint': 'Default 2500',
  'config.recallCacheTtl': 'Recall cache (ms)',
  'config.recallCacheTtlHint': 'Default 15000',
  'config.summaryUnset': 'OpenViking · no address set',
  'config.loading': 'Reading configuration…',
  'config.unavailable': "This deployment does not expose the plugin's configuration to the client (remote Web, or settings is not mounted). Configure it in the profile's cordis.patch.yml instead.",
  'config.readonly': 'This profile does not accept writes, so these fields are read-only.',
  'config.overridden': 'overridden',
  'config.check': 'Check',
  'config.default': 'Default',
  'config.defaultHint': 'Clear this field and fall back to the default',
  'config.checking': 'Checking…',
  'config.probeOk': 'Reachable: OpenViking {version}',
  'config.probeVersionUnknown': '(version unknown)',
  'config.probeFailed': 'Not reachable: {error}',
  'config.unknownError': 'unknown error',
  'config.needNumber': '{label} must be a number',
  'config.noChanges': 'Nothing changed.',
  'config.saved': 'Saved. The host applies the new values on its next composition.',
  'config.refused': 'The host refused the write (something else may have changed it); your edits are still in the form.',
  'config.save': 'Save',
  'notice.unreachable': 'OpenViking is not reachable at {endpoint}: {error}',
  'notice.noMemoryPlugin': '@openviking/dsh-memory-plugin is not mounted: session ids fall back to "dsh-<session>" and the commit threshold is unknown.',
  'notice.sessionFailed': 'Could not read the session: {error}',
  'notice.noPrompt': 'The session log has no recent prompt; type one to search with.',
  'notice.targetFailed': 'Searching {target} failed: {error}',
  'config.probeRefused': 'The address must be an http(s) URL on this machine (loopback)',
  'config.discard': 'Discard',
}

/** Every key the plugin ships, per language. */
export const DICTS: Record<LocaleId, Record<string, string>> = { zh, en }

let service: LocaleServiceLike | undefined
let resolved: Record<string, string> | undefined

/** Take the locale service; call once per `apply()` with `ctx.locale`. */
export function attachLocale(next: LocaleServiceLike | undefined): void {
  service = next
  resolved = undefined
}

/** `zh`/`en` from an id that may be `zh-CN`, `en-US`, or anything else. */
function normalize(id: string | undefined): LocaleId {
  const value = (id ?? '').toLowerCase()
  if (value.startsWith('zh')) return 'zh'
  if (value.startsWith('en')) return 'en'
  return 'en'
}

/**
 * The language in force: the app's own choice when the service is there, else the
 * browser's, else English. Read live rather than cached, because the user can
 * change the app's language without reloading the plugin.
 */
export function activeLocale(): LocaleId {
  const snapshot = service?.getSnapshot()
  if (snapshot !== undefined) return normalize(snapshot.active)
  const navigatorLanguage = typeof navigator === 'undefined' ? undefined : navigator.language
  return navigatorLanguage === undefined ? 'en' : normalize(navigatorLanguage)
}

function dict(): Record<string, string> {
  const locale = activeLocale()
  // The dictionary is looked up per call: `activeLocale()` is live, so caching it
  // would pin the language until a reload.
  resolved = DICTS[locale]
  return resolved
}

/**
 * Translates one key, interpolating `{name}` placeholders.
 *
 * A key that is missing from the dictionary is returned unchanged — visible in
 * the interface, and impossible to mistake for copy.
 */
/**
 * A host notice, in the reader's language.
 *
 * The host reports what happened; the wording lives here, under `notice.<code>`.
 * An unknown code renders as the code, which is what a newer host talking to an
 * older client gets instead of an empty line.
 */
export function noticeText(notice: { code: string; params?: Record<string, string | number> }): string {
  return t(`notice.${notice.code}`, notice.params)
}

export function t(key: string, params?: Record<string, string | number>): string {
  const text = dict()[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}
