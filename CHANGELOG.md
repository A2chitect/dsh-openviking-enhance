# Changelog

Notable changes to `dsh-openviking-enhance`. The `version` field in
[`package.json`](package.json) is the source of truth; every release is tagged
`vX.Y.Z` in git. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Notes for the next release go under `## Unreleased`, which `pnpm run release`
promotes to a dated section — see [RELEASING.md](RELEASING.md).

## Unreleased

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
