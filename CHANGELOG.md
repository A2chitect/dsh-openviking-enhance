# Changelog

Notable changes to `dsh-openviking-enhance`. The `version` field in
[`package.json`](package.json) is the source of truth; every release is tagged
`vX.Y.Z` in git. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Notes for the next release go under `## Unreleased`, which `pnpm run release`
promotes to a dated section — see [RELEASING.md](RELEASING.md).

## Unreleased

### Added

- **Recall detail in the right sidebar** — a per-session *记忆召回* tab showing what
  OpenViking retrieves for the session in view: the query it searched with (the
  session's own most recent user turn, or one you type), every hit in each of the
  three sources with its score, `viking://` path and abstract, the server's own
  retrieval plan, and one entry's full text on click. It asks the same
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
