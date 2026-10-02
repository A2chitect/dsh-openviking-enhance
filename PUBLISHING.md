# 发布清单

面向维护者。目标：**一个陌生人能装上这个插件**，并且它能被收录进
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（规范原文
`contributing.md`，2026-10-02 读取，223 行）。

用词：☑ 完成（附证据） · ◐ 进行中 · ☐ 未做 · ⊘ 需你拍板

## 一、规范硬性要求对照

| 规范要求 | 现状 | |
| --- | --- | --- |
| 仓库声明 `dsh.bundle` manifest（只声明 `dsh.client` 会被拒，是"最常见的被拒原因"） | `dsh.bundle.patch = ./cordis.patch.yml`，patch 形状与规范示例一致 | ☑ |
| 有真实可用代码 | 46 单测 + 客户端产物断言 + 真机冒烟 | ☑ |
| 官方 `@deepseek-ai/*` 用 peerDependencies，不用 dependencies | 已无运行时 dependencies；peer 为 `@deepseek-ai/dsh` + `react` | ☑ |
| peer 范围带显式预发布分支（否则静默排除所有 rc 构建） | `@deepseek-ai/dsh: ^0.2.0-rc.1`（0.2.0 元组上带预发布标签，可匹配 rc.2） | ☑ |
| 仓库创建满 1 天（CI 自动查） | **仓库今天才建，且还没有 GitHub 远端** | ☐ |
| 加 `dsh-plugin` topic | 需要先有远端 | ☐ |
| 描述属实、无营销词、可被对着代码核 | 待写 | ☐ |
| 分类选最贴切的 | 建议 `memory`（备选 `ui`） | ⊘ |
| npm 包 `repository` 字段指回本仓库 | 需要仓库 URL | ⊘ |
| 推荐：发 npm（预构建安装免 `allowBuilds` 授权） | `private` 已移除，`pnpm pack` 产物完整 | ◐ |
| 推荐/必要时：GitHub Release tarball | 未做 | ☐ |
| 可选：`screenshots.json`（1–8 张） | 未做 | ☐ |

## 二、已完成

### 1. LICENSE 文件 ☑

声明了 `"license": "MIT"` 但仓库里没有 LICENSE 文件。已补，并加进 `files`。
署名暂写 `dsh-openviking-enhance contributors` ——⊘ 你可以换成自己的名字或 GitHub handle。

### 2. package.json 合规 ☑

- 移除 `private: true`（否则 npm 拒绝发布）
- 补 `keywords`；`description` 改写为市场会展示的那一句话（只陈述功能）
- `files` 补 `LICENSE`
- **删掉运行时 `dependencies`**（原为 `@deepseek-ai/schemastery`）
- `peerDependencies` = `@deepseek-ai/dsh: ^0.2.0-rc.1` + `react: ^18.2.0`

证据：`pnpm pack` 产物含 `package/LICENSE`、`lib/index.js`、`lib/client.js`、
`cordis.patch.yml`、`icon.svg`、两个 README、CHANGELOG；包内 manifest 显示
`private: false`、`deps: {}`。

### 3. 宿主半部分自包含（不再依赖 harness 提供 schemastery）☑

原状态：宿主半部分 `import '@deepseek-ai/schemastery'` 是**运行时**依赖，而本机的 profile 里
有它**只是因为本插件自己把它装了进来**（`dsh-base` / `dsh-web-app` 都没声明它）。
把它改成 peer 只是把失败推给用户的第一次安装，所以改为**打进自己的 bundle**。

证据：`lib/index.js` 现在只 `import` node 内置模块（`node:fs` / `node:os` / `node:path`），
体积 34 KB → 68 KB；`pnpm test` 全绿（宿主冒烟会真的 `apply()` 这个 bundle）。
注：esbuild 的 `external` 不支持 `!` 取反，所以 `build.mjs` 用的是显式白名单 `HOST_EXTERNAL`。

### 4. GUI 配置页（你点名的那条）☑

**原先的事实**：地址并不写死（`Config.endpoint` 等 7 个字段 + 读 `~/.openviking/ovcli.conf`
兜底），但**只能在 profile 的 `cordis.patch.yml` 里改**。DSH **不会**按 schema 自动渲染表单——
插件管理器 README 写得很明确：*a row's page exists only while a `plugins.row.config` entry
names the row*。

**做法**（全部走官方通道，没有自造 transport）：

| 层 | 做了什么 |
| --- | --- |
| Host Config | 7 个字段加 `.volatile()` —— settings 只投影 volatile 字段，不标就没有表单项 |
| Client | 注册 `plugins.row.config`，key = `dsh-openviking-enhance#openviking-enhance`；页面把 `PluginConfigViewProps`（含 `form`）直接交给组件 |
| 读写 | 页面给的 `form.mutate(ops, revision)`；op 形状 `{op:'set'|'unset', path, value}`；清空字段 = `unset`，恢复继承而不是写入空串 |
| 冲突 | 提交时带上读到的 revision；被拒时**保留草稿**（页面契约） |
| 检测连接 | 新增宿主路由 `/probe`：只接受 loopback 的 http(s) 地址，否则 400 ——否则这个路由就是一个人人可用的 URL 抓取器 |

证据：`pnpm test` 全绿；实时冒烟 `[smoke] probe reachable=true version=0.4.22`、
`[smoke] probe guard ok non-loopback endpoint refused`；客户端冒烟断言配置座位被注册且 key 与
manifest 的包名一致（浏览器半部分读不到 package.json，所以包名是写死的，靠断言防漂移）。

## 三、待办

| # | 工作 | 说明 |
| --- | --- | --- |
| 1 | i18n | 界面文字目前全中文（面板、胶囊、召回面板、配置页）。规范面向英文读者；同类插件都带 `locale/`。宿主侧的消息（`warnings`）也要从"中文句子"改成"码 + 参数"，由客户端翻译 |
| 2 | 可安装性实测 | 在干净 profile 里真装一次，确认 `lib/` 到位、插件能挂上。**这是"陌生人能不能装上"的唯一证据**，也是验证 `prepare` 到底跑不跑的唯一办法 |
| 3 | 截图 + `screenshots.json` | 需要真机截图（左侧 Studio、提交胶囊+时间线、右侧召回面板、插件配置页） |
| 4 | README 更新 | 加截图、市场安装方式、兼容性说明（依赖 `@openviking/dsh-memory-plugin` 的内部结构这件事要写明） |
| 5 | 条目 yml | `data/plugins/<owner>__<repo>.yml`，一个文件 |
| 6 | 版本 0.2.0 | 这次是新增功能，按 RELEASING.md 走 minor；用 `pnpm run release` 本地打标签（**不发 npm**） |

## 四、需要你拍板

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | 分类 `memory` 还是 `ui` | 只影响列表归类，选错维护者会改 |
| 2 | GitHub owner / 仓库名 | `url` 必须与仓库完全一致；也是 `repository` 字段的值 |
| 3 | npm 包名 | `dsh-openviking-enhance` 在 registry 上 404（未被占用）；是否加 scope |
| 4 | 分发方式 | npm + tarball 双保险 / 只 npm / 再试 `prepare` 源码安装 |
| 5 | LICENSE 署名 | 现在写的是 `dsh-openviking-enhance contributors` |
| 6 | i18n 范围 | 界面中英双语，还是先只做英文 README |

## 五、证据索引

| 结论 | 怎么看 |
| --- | --- |
| 打包产物完整 | `pnpm pack --pack-destination /tmp && tar tzf /tmp/dsh-openviking-enhance-0.1.0.tgz` |
| 宿主半部分自包含 | `grep -oE 'from "[^"]+"' lib/index.js \| sort -u` |
| 配置页座位已注册 | `node scripts/smoke-client.mjs`（`plugins.row.config` 那两条） |
| probe 只认 loopback | `node --test test/host-units.test.mjs`（`parseLoopbackEndpoint` 那条） |
| 全量回归 | `pnpm test` |
