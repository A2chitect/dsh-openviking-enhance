# Changelog

Notable changes to `dsh-openviking-enhance`. The `version` field in
[`package.json`](package.json) is the source of truth; every release is tagged
`vX.Y.Z` in git. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Notes for the next release go under `## Unreleased`, which `pnpm run release`
promotes to a dated section — see [RELEASING.md](RELEASING.md).

## Unreleased

Explain. v0.3 turns the dashboard from "what is the memory state" into "why is
the memory in this state", and every new surface is read-only.

### Added

- **A recall explanation under every completed turn.** The conversation gains a
  `Memory sources` trigger whose card replays the turn's prompt against the
  server's context face (`POST /api/v1/search/search` with `mode: "context"`).
  It shows the query, every hit with score/category/URI/read tier/provenance,
  the server's token budget (used/max), quotas, tier counts, exclusion and
  cross-turn de-duplication accounting, provenance, the retrieval plan, the
  assembled injection block, and latency. The card says it is a replay: DSH does
  not retain the memory plugin's injected block, so a historical "exactly what
  was injected" claim would be a lie. Servers without the context face fall back
  to the existing per-target search and say so.
- **A commit diff browser in the commit pill.** Each commit can be filtered by
  added/updated/deleted, every change expands to its before/after text with a
  line diff, deletes show their deleted content, and one click copies a URI or
  exports the commit as JSON. Failed commits show the server error, time and the
  task id when the record has not been pruned yet, with a copy-error control.
- **A Memory health tab in the right sidebar.** It distinguishes the five states
  that matter — nothing captured, captured but not committed, extracting after
  a commit, extraction failed, writes queued locally — plus the normal committed
  state, with message/pending/commit counts, threshold, last commit and last
  auto-commit times, recent tasks, recent commits and a timestamped activity
  timeline. It also reads the official plugin's local pending queue (counts,
  types and times only, never payloads) and labels that state as cross-plugin.
- **A Doctor.** Endpoint, health, version, identity, the mounted memory plugin's
  version and effective recall/capture/commit settings, per-field connection
  sources (profile override, environment, `ovcli.conf`/`.local`, default), and
  live probes for the context face, rule search, skills, `fs/stat` and retrieval
  metrics. It also lists the model-visible `mcp__openviking__*` tools, so "why is
  there no tool?" has an answer: plugin not mounted, tools not exposed, or the
  registry unreachable. Every check names the likely fix, the DSH version is checked against
  the manifest range, and the diagnostic JSON and `curl /health` command are one
  click away. API keys are never included in any report or copied diagnostic.
- **A compact health summary on the plugin's own Plugins page**, so "is it
  working?" has an answer before opening a session.
- **Two more interface switches:** `showRecallExplain` and `showHealthPanel`,
  both default `true`, applied live like the existing three.
- `test/v03-units.test.mjs` pins the context/fallback wire shapes, the request
  mirroring, the five session states, connection sources, the pending-queue
  reader and the text diff. The host smoke harness now exercises
  `/recall/explain`, `/session-log` and `/doctor` against a live server.

### Changed

- **DSH 0.2.2 support, and 0.2.0/0.2.1 are no longer supported.** The Chat transcript
  seats this release uses (`conversation.chat.turnTail`, `conversation.chat.assistant-actions`)
  only exist in the 0.2.2 generation, so `engines.dsh` and the manifest now require
  `>=0.2.2-rc.1`; 0.2.3 remains the last release for the old shells. Development
  is type-checked and built against `@deepseek-ai/dsh-*@0.2.2-rc.1` (including the
  Chat package that owns `conversation.chat.turnTail`).
- **The recall replay follows the official request more closely.** Its HTTP
  deadline is derived from the memory plugin's expansion/rewrite fuses (15 s /
  45 s, or `recallContextTimeoutMs`), and the request now mirrors
  `recallEventsDecayProtection` and `rewrite=auto`; the card also shows the
  plugin's effective recall settings. The Doctor's context probe is session-free
  and sends `query_expansion: "off"`, so opening the health page cannot trigger
  an expansion LLM call or touch a session's de-duplication bookkeeping.
- **The commit popover is wider and the timeline links into the full diff**;
  the old paths-only list is gone.
- The sidebar tab closing path now handles the recall and health pages
  independently and no longer arms a deferred close when the right column is
  mounted with no tab of ours on screen.

### Verified

- DSH 0.2.2-rc.1 (web profile), OpenViking 0.5.3 (`/health`, context face,
  rules, skills, observer) and the 0.5.1.1–0.5.3 fallback paths. The live host
  smoke reports the context face available and the Doctor's probes available.
- The pending queue was empty on the verification machine; the reader is covered
  by a temp-directory unit test instead.

### 新增

- **每条已完成回复下方的召回解释。** 对话里新增「记忆来源」入口，展开后会用该轮提问
  重放服务端的上下文接口（`POST /api/v1/search/search`，`mode: "context"`），显示
  命中条目的分数、类别、URI、读取层级与来源，以及 token 预算（已用/上限）、配额、
  层级统计、排除与跨轮去重、检索计划、服务端组装的注入块和耗时。卡片明确说明这是
  "重放"：DSH 不保留记忆插件注入的原始文本，因此不会假装展示历史注入。没有上下文
  接口的旧服务端退回逐目标检索，并注明原因。
- **提交胶囊里的 diff 浏览器。** 可按新增/更新/删除筛选，每个变更展开后显示前后文本
  与行级 diff，删除项显示被删内容；可复制 URI 或把本次提交导出为 JSON。失败提交显示
  服务端错误、时间和仍保留的 task id，并可复制错误。
- **右侧边栏的「记忆健康」页。** 区分五种状态——没有消息、已捕获未提交、提交后抽取中、
  抽取失败、本地队列中——以及正常已提交；显示消息数、待提交 token、阈值、提交次数、
  最近提交/自动提交时间、最近任务、归档和活动时间线。它还会读取官方插件本地 pending
  队列的数量、类型与时间（绝不读取 payload），并标注这是跨插件本地状态。
- **Doctor。** 显示地址、健康、版本、身份、已挂载记忆插件的版本与生效的召回/捕获/提交
  设置，以及每个连接字段的来源（profile 覆盖、环境变量、`ovcli.conf`/`.local`、默认）；
  并对上下文接口、规则检索、技能、`fs/stat` 与召回观测做真实探测。它还会列出模型可见的
  `mcp__openviking__*` 工具，让「为什么没有工具」有答案：插件未挂载、工具未暴露，还是
  工具注册表不可读。每项检查给出可能的
  修复方向，DSH 版本会与清单声明区间比对，诊断 JSON 与 `curl /health` 一键复制；API key
  不会出现在任何报告或导出里。
- **插件详情页的健康摘要**，不必先打开会话就能看到"是否正常"。
- **两个新的界面开关：** `showRecallExplain`、`showHealthPanel`，默认都打开，和原有
  三个开关一样保存后立即生效。

### 变更

- **支持 DSH 0.2.2；不再支持 0.2.0/0.2.1。** 本版本使用的 Chat 转录槽位
  （`conversation.chat.turnTail`、`conversation.chat.assistant-actions`）只存在于 0.2.2 代，
  因此 `engines.dsh` 与清单改为 `>=0.2.2-rc.1`；旧 shell 的最后一个版本是 0.2.3。
  开发依赖升级到 `@deepseek-ai/dsh-*@0.2.2-rc.1`（包括拥有 `conversation.chat.turnTail`
  的 Chat 包）。
- **召回重放更贴近官方请求。** HTTP 超时按官方插件查询扩展 / 重写的熔断时间推导
  （15 秒 / 45 秒，或 `recallContextTimeoutMs`），请求也会带上
  `recallEventsDecayProtection` 与 `rewrite=auto`；卡片同时显示记忆插件的生效召回设置。
  Doctor 的上下文探测不再携带 session，并显式 `query_expansion: "off"`，打开健康页
  不会触发扩展 LLM 调用，也不会碰会话的跨轮去重状态。
- **提交弹窗加宽**，时间线直接进入完整 diff，不再只列路径。
- 右侧边栏的关闭逻辑按召回页与健康页分别处理；右栏已挂载但当前页不是本插件页面时
  不再安排无意义的延迟关闭。

### 验证

- DSH 0.2.2-rc.1（web profile）、OpenViking 0.5.3（`/health`、上下文接口、规则、技能、
  观测）以及 0.5.1.1–0.5.3 的回退路径。真实宿主 smoke 显示上下文接口与 Doctor 探测
  均可用。
- 验证机器上的 pending 队列为空；读取逻辑由临时目录单测覆盖。


## 0.2.3 — 2026-11-04

### Fixed

- **The commit pill no longer lets a pruned task or an old failure decide the
  current state.** OpenViking keeps `session_commit` task records for about 24
  hours (`completed`/`cancelled`) and 7 days (`failed`). Once a later success's
  task aged out, an older failed task became the newest remaining one and the
  pill flipped back to "extraction failed"; after 7 days a real failure vanished
  from the UI while its archive still recorded it. The host now reads the
  durable per-archive markers (`.done` / `.failed.json`) and derives the phase
  from the newest archive: a failure after a newer successful commit stays only
  in the popover, a partial `memory_diff.json` no longer masks a failure, and a
  cancelled commit reads as "cancelled" rather than "failed". Servers without
  markers fall back to a failed task only when no later `last_commit_at`
  supersedes it.
- **Polling no longer runs at a fixed 5 seconds.** The pill polls at 5 s only
  while a commit is being extracted, at 30 s when idle and visible, pauses in a
  hidden tab, and backs off exponentially (5→60 s) after failures. Opening the
  popover, refocusing the window or switching sessions refreshes immediately.
  Requests are aborted on session change/unmount and guarded against overlap;
  the host coalesces concurrent status reads. Idle traffic drops from 36 to
  about 6 upstream requests per minute per tab.

### 修复

- **提交状态胶囊不再被已清理的 task 或旧失败 "复活"。** OpenViking 对
  `session_commit` task 的保留是：`completed`/`cancelled` 约 24 小时、`failed` 约 7 天。
  后续成功提交的 task 先过期后，更早的失败 task 会重新变成"最新"，胶囊又翻回
  "抽取失败"；7 天后真实失败又会从界面消失，而归档里的标记还在。现在宿主读取归档目录
  的持久标记（`.done` / `.failed.json`），用**最新一个归档**的终态判定阶段：后续成功提交
  之后的旧失败只留在弹窗里，部分写出的 `memory_diff.json` 不再掩盖失败，手动取消显示为
  "已取消"而非"失败"。没有标记的旧服务端则回退到 task，但只在失败未被更晚的
  `last_commit_at` 覆盖时才生效。
- **轮询不再固定 5 秒。** 只有抽取进行中才 5 秒一次；空闲且可见时 30 秒；标签页隐藏时暂停；
  请求失败按 5→60 秒指数退避。打开弹窗、窗口重新获得焦点、切换 session 都立即刷新。
  切换/卸载会取消旧请求并防止重叠；宿主对同一 session 的并发状态读取做单飞。
  空闲时的上游请求从 36 次/分钟降到约 6 次/分钟。

## 0.2.2 — 2026-10-27

### Added

- **Three interface switches on the plugin's settings form.** `showSidebarEntry`,
  `showCommitStatus` and `showRecallPanel` (all default `true`) independently hide
  the Studio entry in the left sidebar, the per-session commit pill under the
  composer, and the Memory recall tab in the right sidebar. They are persisted by
  the same **Configure** form and applied live through `ctx.configForms` — saving
  mounts or unmounts the surface with no reload or restart. The form itself is
  never hidden: a switched-off surface can always be switched back on there.
  Hiding the sidebar entry unmounts the Studio page (it loads fresh when shown
  again); hiding the recall tab closes an open recall page once the conversation
  is back on screen (a page open in a background pane has to be closed by hand,
  because the harness exposes no tab enumeration). A deployment
  without the settings client keeps every surface visible, exactly as before the
  switches existed. The release was exercised in the running desktop GUI: the host
  Config was hot-reloaded without an app restart, each surface disappeared and
  returned on save, and switching the recall tab off closed an already-open recall
  page once the conversation came back; the test-written overrides were then
  removed, so the defaults are in force.

### 新增

- **插件设置里新增三个界面开关。** `showSidebarEntry`、`showCommitStatus`、
  `showRecallPanel`（默认都是 `true`）分别控制左侧边栏的 Studio 入口、输入框下方的
  提交状态胶囊、右侧边栏的「记忆召回」tab。开关与连接参数在同一个 **Configure** 表单里
  保存，客户端通过 `ctx.configForms` 实时生效——保存即挂载或卸载对应界面，不需要重载
  窗口或重启应用。配置表单本身永远可见，关掉的入口随时能在这里开回来。隐藏左侧入口会
  一并卸载 Studio 页面（重新打开后重新加载）；隐藏召回 tab 后不再提供该页，已打开的召回页
  会在回到对话时自动收起（若它在后台分屏里、不是激活页，则需手动关闭——框架没有提供枚举
  标签页的接口）。没有 settings 客户端的部署保持三个入口全部显示，与加开关之前完全一致。
  本版本在运行中的桌面 GUI 里实测过：宿主 Config 无需重启 App 即热重载，三个入口在保存后
  当场消失/恢复，关掉召回开关后已打开的召回页会在回到对话时自动关闭；随后清除了测试写入的
  覆盖值，默认值（全开）生效。

### Changed

- **Verified against DSH 0.2.1-rc.3.** The desktop app moved one prerelease
  forward on the 0.2.1 line. No plugin code changed: the same sources type-check
  against the 0.2.1-rc.3 type packages and the whole suite passes on rc.3 — 88
  unit/component tests, 160 client-smoke checks, 24 packaging-contract checks, the
  live OpenViking smoke (status, commits, timeline, probe, recall, diff) and the
  six-request route fence. The development dependencies now pin 0.2.1-rc.3; the
  peer range and both `engines.dsh` entries already admitted that release (same
  0.2.1 tuple), so no new range branch was needed. The running app confirms it:
  the sidebar row, Studio panel, commit pill and recall tab all mount on the rc.3
  GUI, and the host routes answer `ok: true` / `healthy: true`. The requirements
  table now names OpenViking 0.5.1.1, the server the live smoke ran against.

### 变更

- **已在 DSH 0.2.1-rc.3 上验证。** 桌面端在 0.2.1 线上又前进一个预发布版本。
  插件代码没有改动：同一份源码对 0.2.1-rc.3 类型包通过类型检查，整套测试也在
  rc.3 上全绿——88 项单测/组件测试、160 项客户端冒烟、24 项打包契约、真实
  OpenViking 在线冒烟（状态、提交、时间线、探测、召回、差异）与 6 项路由 fence。
  开发依赖现在钉到 `0.2.1-rc.3`；peer 范围与两处 `engines.dsh` 本就覆盖该版本
  （同为 0.2.1 元组），无需新增范围分支。运行中的 app 也确认：左侧栏行、
  Studio 面板、提交状态胶囊与召回 tab 都在 rc.3 界面上正常挂载，宿主路由返回
  `ok: true` / `healthy: true`。前置条件表里的 OpenViking 实测版本更新为
  0.5.1.1（本次在线冒烟所用服务端）。

## 0.2.1 — 2026-10-18

### Changed

- **Declared compatibility with DSH 0.2.1-rc.2.** The development dependencies
  now track the 0.2.1 line (`0.2.1-rc.2`, `@deepseek-ai/cordis` 4.0.5,
  `@deepseek-ai/schemastery` 3.18.5), and both the peer range and `engines.dsh`
  name that prerelease line as well as 0.2.0's. No plugin code changed: the same
  sources type-check against both versions, and the full suite — including the
  live OpenViking smoke — passes on 0.2.1-rc.2.

### 变更

- **声明支持 DSH 0.2.1-rc.2。** 开发依赖升到 0.2.1 线（`0.2.1-rc.2`、
  `@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/schemastery` 3.18.5），peer 范围与
  `engines.dsh` 同时标出 0.2.1 预发布线与 0.2.0 线。插件代码没有改动：同一份
  源码在两套类型下都通过类型检查，并在 0.2.1-rc.2 上跑完整套测试（含真实
  OpenViking 在线冒烟）。

## 0.2.0 — 2026-10-02

### Added

- **Recall detail in the right sidebar** — a per-session *记忆召回* tab showing what
  OpenViking retrieves for the session in view: the query it searched with (the
  session's own most recent user turn, or one you type), every hit in each of the
  three sources with its score (graded red through green), file name, kind and
  abstract, the server's own retrieval plan, and one entry's full text on click. It asks the same
  session-aware route the memory plugin calls, so the ranking is the server's
  rather than a second implementation of it. Reached through the right sidebar's
  guide; nothing is written.
- Two routes behind the same trust fence: `/recall` and `/recall/content` (the
  latter refuses anything that is not a `viking://` path, and truncates).

### Changed

- **The interface is bilingual.** Every string this plugin renders — the panel,
  the pill and its popover, the recall tab, the configuration form — now follows
  the language DSH is set to, with Chinese and English dictionaries and English as
  the fallback. Host-side messages became codes plus parameters, so the half that
  has no language no longer decides the wording.
- **The plugin's settings are editable in the GUI.** Its row on the **Plugins**
  page now has a **Configure** form — endpoint, key, identity, Studio path and the
  two cache lifetimes — with a *check* button that probes the address before
  saving, and a per-field reset that clears the override instead of writing an
  empty value. The same values can still be written by hand in the profile patch.
- The host half is self-contained: `@deepseek-ai/schemastery` is bundled instead
  of being imported at runtime, so the plugin no longer assumes a harness hands it
  a schema library the profile may not have.
- The package is publishable: `private` removed, `LICENSE` added, and the official
  `@deepseek-ai/*` dependency replaced by an explicit `@deepseek-ai/dsh` peer.

### 变更

- **界面中英双语**：本插件渲染的每一处文字（面板、胶囊及其弹窗、召回面板、配置表单）现在都跟随
  DSH 的语言设置，内置中英两套字典，其他语言退回英文。宿主侧消息改成"码 + 参数"，
  不再由那个没有语言概念的半部分决定措辞。
- **插件设置可以在界面里改了**：**Plugins** 页里本插件那一行多了 **Configure** 表单
  （地址、Key、身份、Studio 路径、两个缓存时长），地址旁有 **检测** 按钮可在保存前试连，
  每个字段的 **默认** 按钮是清除覆盖、恢复继承，而不是写入空值。同样的值仍可手写在 profile patch 里。
- 宿主半部分自包含：`@deepseek-ai/schemastery` 改为打进 bundle，不再假设 harness 会提供它。
- 包已可发布：移除 `private`、补 `LICENSE`、把官方 `@deepseek-ai/*` 依赖换成显式的
  `@deepseek-ai/dsh` peer。

### 新增

- **右侧边栏的记忆召回面板**：按会话显示 OpenViking 为当前会话召回了什么——检索用的那句话
  （默认本会话最近一次提问，也可自己输入）、三个来源里每条命中的分数与 `viking://` 路径及摘要、
  服务端自己的检索计划，以及点开任意一条看全文。它调用的是记忆插件本身所用的那条会话感知接口，
  所以看到的是服务端的真实排序，而不是另写一套检索。从右侧边栏的引导页进入，全程不写入。
- 新增两个走同一道信任围栏的接口：`/recall` 与 `/recall/content`（后者只接受 `viking://`
  路径，并做长度截断）。

## 0.1.0 — 2026-10-02

First release. Read-only throughout: the plugin never commits, writes or deletes
anything in OpenViking.

### Added

- **OpenViking Studio panel** — a new row at the end of the left sidebar that
  loads the OpenViking server's own Studio UI in the main area (`/studio/` by
  default), with a reload button when the frame goes stale.
- **Per-session commit pill** under the message box, matching the built-in pills
  in type and colour: `未提交`, `12.3k/20k`, `抽取中…`, `N 次提交`, `抽取失败`,
  `不可用`. It carries the sidebar's OpenViking glyph and an `OV ·` prefix so it
  cannot be mistaken for a git commit.
- **Commit timeline** in the pill's popover — the newest 3 commits with their time
  and added/updated/deleted counts; *show all* expands the rest (up to 50).
- **Per-commit memory diff** — clicking a commit lists the exact `viking://`
  paths it changed, read from that archive's own `memory_diff.json`.
- **Failed extraction reporting** — time, duration and the server's own error.
  The commit counter alone cannot show this, because the archive is written even
  when extraction fails.
- **Four loopback-only routes** (`/config`, `/status`, `/commits`, `/diff`) behind
  a trust fence: loopback socket *and* loopback `Host` *and* same-origin
  `Sec-Fetch-Site`/`Origin`. `X-Forwarded-For` is never trusted; non-GET is `405`.
- **Configuration** — `endpoint`, `apiKey`, `account`, `user`, `studioPath`,
  `cacheTtlMs`, all defaulted and readable from `~/.openviking/ovcli.conf`, so a
  standard local setup needs none.
- **Tests** — 22 unit tests against the host logic (including a stub-server wire
  test that pins the session-history URL), a client bundle smoke harness with 26
  invariants, and a host smoke harness that prints the live timeline.

### Known limitations

- The plugin's own interface text is Chinese only; it does not follow the DSH
  locale setting yet.
- OpenViking prunes its commit task records, so the failure list covers recent
  commits only. The archives themselves are permanent.
- Extraction failures undercount `memories_extracted`; the interface trusts each
  commit's own diff summary instead.

---

## 0.1.0 — 2026-10-02（中文）

首个版本。全程只读：本插件不会向 OpenViking 提交、写入或删除任何东西。

### 新增

- **OpenViking Studio 面板**：左侧边栏最后一行，主区域加载 OpenViking 服务自带的
  Studio 界面（默认 `/studio/`），并提供重新加载按钮。
- **会话 commit 状态胶囊**：输入框下方，字体字号与内置胶囊一致，显示
  `未提交` / `12.3k/20k` / `抽取中…` / `N 次提交` / `抽取失败` / `不可用`；
  使用侧边栏同款 OpenViking 图标并带 `OV ·` 前缀，不会与 git commit 混淆。
- **提交时间线**：点开胶囊可见最近 3 次提交的时间与新增/更新/删除条数，
  「显示全部」可展开至 50 条。
- **单次提交的记忆明细**：点某次提交列出它改动的具体 `viking://` 路径，
  数据来自该次归档自己的 `memory_diff.json`。
- **抽取失败可见**：显示失败时间、耗时与服务端原始错误。仅看提交次数无法发现
  这类失败——抽取失败时归档同样会写入。
- **四个仅本机可达的内部接口**（`/config`、`/status`、`/commits`、`/diff`），
  同时校验 loopback 套接字、loopback `Host` 与同源 `Sec-Fetch-Site`/`Origin`；
  不信任 `X-Forwarded-For`，非 GET 返回 `405`。
- **配置项**：`endpoint`、`apiKey`、`account`、`user`、`studioPath`、
  `cacheTtlMs`，均有默认值并可读取 `~/.openviking/ovcli.conf`，标准本地环境无需配置。
- **测试**：22 个宿主逻辑单测（含固定会话历史 URL 的桩服务端联调测试）、
  26 项客户端产物冒烟断言、以及可打印实时时间线的宿主冒烟脚本。

### 已知限制

- 插件自身界面文字目前只有中文，尚未跟随 DSH 的语言设置。
- OpenViking 会定期清理 commit 任务记录，失败列表只覆盖最近的提交；归档文件本身永久。
- 抽取失败时 `memories_extracted` 会少计，界面以每次提交自己的 diff 摘要为准。
