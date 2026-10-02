# 发布清单

> 维护者文档，中文；面向用户的是两份 README（`README.md` / `README.zh.md`）。

目标：**一个陌生人能装上这个插件**，并且它能被收录进
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
| 仓库创建满 1 天（CI 自动查） | 仓库建于 2026-10-02 14:46 (+0800)，**2026-10-03 14:46 之后可提 PR** | ◐ |
| 加 `dsh-plugin` topic | 已加（连同 `openviking`、`deepseek-harness`） | ☑ |
| 描述属实、无营销词、可被对着代码核 | 待写 | ☐ |
| 分类选最贴切的 | 建议 `memory`（备选 `ui`） | ⊘ |
| npm 包 `repository` 字段指回本仓库 | 已填 `git+https://github.com/A2chitect/dsh-openviking-enhance.git` | ☑ |
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

### 5. 可安装性：tarball 路径已验证 ☑

把 `pnpm pack` 产物装进一个空工程（`/tmp/install-test`）：

```
node_modules/            -> 只有 dsh-openviking-enhance（peer 没有被真实安装）
dsh-openviking-enhance/  -> lib/ cordis.patch.yml icon.svg LICENSE README*.md CHANGELOG.md
import("dsh-openviking-enhance")
  -> exports: Config, apply, inject, name
  -> Config fields: endpoint apiKey account user studioPath cacheTtlMs recallCacheTtlMs
```

也就是说：**宿主半部分在完全没有依赖的树里也能加载**（这正是第 3 条把它做成自包含的意义），
而 `@deepseek-ai/dsh` 这个 peer 在 pnpm 下只是提示、不会被拉进来（profile 里也确实没有它）。

### 6. 源码安装：实测过，四种形态 ☑

规范说"如果你的仓库根本无法从源码安装，tarball 这一项是必需的"。用本地 git 依赖实测了四种形态
（`pnpm add git+file:///tmp/clone-probe`，每次都是全新 clone）：

| 仓库形态 | `dsh plugin add <github-url>` 的结果 |
| --- | --- |
| **现状**：`lib/` 未跟踪、无 `prepare` | 安装**成功**，但包里没有 `lib/` —— 插件是坏的，而且**没有任何报错**（最糟） |
| 加 `prepare` | 安装**直接失败**：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，提示把包加进 `allowBuilds` |
| 加 `prepack` | 同上，失败并提示 `allowBuilds` |
| 把 `lib/` 提交进仓库 | 装成功且可用（无构建步骤）——⊘ 见下 |

结论：**主路径必须是 npm 包或 Release tarball**（规范也正是这么推荐的："预构建安装免
`allowBuilds` 构建授权"）。已加 `prepack: node build.mjs`：删掉 `lib/` 后 `pnpm pack` 会自动重建，
所以**发布产物不可能缺构建结果**（实测：删掉 lib → pack → tarball 里 4 个 lib 条目）。
副作用是 raw git 安装从"静默装坏"变成"响亮报错"，这比让用户装上一个坏插件好。

### 8. 真装一次：`dsh plugin add` 到临时 profile ☑

用官方 CLI（`npm install --prefix /tmp/dshcli @deepseek-ai/dsh@0.2.0-rc.2`）配
`DSH_HOME=/tmp/dsh-home`（**完全不碰 `~/.dsh`**）走了一遍真实安装：

```sh
DSH_HOME=/tmp/dsh-home dsh plugin --profile probe add /tmp/dsh-openviking-enhance-0.1.0.tgz
# -> dependencies: + dsh-openviking-enhance 0.1.0   （只有 peer 警告，没有构建授权拦截）
# -> profile 记录: dsh.profile.bundles: ["dsh-openviking-enhance"]
# -> 装出来的包里有 lib/
DSH_HOME=/tmp/dsh-home dsh --profile probe --dump-config | grep -A 2 'dsh-openviking-enhance'
# == dsh-openviking-enhance
# - id: openviking-enhance
#   name: dsh-openviking-enhance
```

最后那三行是关键：**Loader 读了我们的 `dsh.bundle.patch` 并把那一行插进了组合树**——这正是规范
CI 要检查（`dsh.bundle`）和市场上"装上就能用"的那一步。tarball 路径全绿。

### 9. 首次运行（没有 OpenViking）也验了 ☑

原先冒烟的"服务端不可达"分支只打印 SKIP，**什么也没验**——而那正是陌生人装上插件后的第一次运行。
现在该分支会逐个调用全部 7 条路由（config/status/commits/recall/diff/probe/content），断言：

```
[offline] ok   config   answers JSON          （7 条路由都要返回带 ok 字段的 JSON，不是抛异常）
[offline] ok   config names the unreachable endpoint as a code
[offline] ok   probe reports a dead address as unreachable
```

本地复现：`SMOKE_ENDPOINT=http://127.0.0.1:9 node scripts/smoke-host.mjs`；
CI 上不需要任何参数——那里本来就没有 OpenViking，走的正是这条分支。

### 10. 发布要求进了 CI：`scripts/check-package.mjs` ☑

上面这些要求原先只存在于这份清单和我的一次性核对里，会漂。现在它们是 `pnpm test` 的一部分，
逐条断言（20 项）：`dsh.bundle.patch` 已声明且文件存在、patch 里确实有 `insert:` 行并写了包名、
`dsh.client.platform = web` 且 inject 非空、**不是 `private`**、有 LICENSE 且进了 `files`、
有 description 与 keywords、**没有任何 `@deepseek-ai/*` 运行时依赖**、harness 是 peer、
`engines` 齐、`lib/index.js` 与 `lib/client.js` 都已构建且在 `files` 里、`prepack` 存在。

**不是空转**：故意把 `private` 设回 true、删掉 `files` 里的 LICENSE、把 schemastery 放回
`dependencies` 之后，三条都如实报红；恢复后全绿。

### 11. 组件真的渲染过（SSR 渲染测试）☑

配置页是我这一路上**从来没亲眼见过渲染结果**的一块。用 `react-dom/server` 把真实组件渲染成
markup 来验（`test/component-render.test.mjs`，5 个用例）——加载的是真实 `lib/client.js`，
走的是和 shell 一样的 `window.__ModuleLoader__` 交接，没有任何 mock-up：

- 5 个座位全部注册，并且**每一个都能渲染不抛异常**（配置表单、召回 tab、胶囊、Studio 面板）
- 配置表单在英文下渲染出全部 7 个字段标签 + 自己的 Save 控件 + `overridden` 标记
- 同一表单切到中文：7 个中文标签 + 「保存」+「已覆盖」，且**没有任何一处退回英文**
- `writable: false` 时说明只读；`status: 'unavailable'` 时提示去 `cordis.patch.yml` 配
- `view: 'summary'` 时给出当前地址那一行

顺带把表单的写入语义抽成 `src/client/config-ops.ts` 并单测（6 个用例）：**清空 = `unset`
（恢复继承）而不是写空串**、数字字段按数字提交、非法数字在发请求前就被拒并指出是哪个字段、
未知键被忽略而不是猜一个路径去写。

### 12. 截图：仍然只有你能拍 ⊘

我试过两条路都不通：
- **无头 Chrome**：本机沙箱里不稳（同一套参数上一次出过图，这次连 `--dump-dom` 都挂死）。
- **真机**：GUI 页面是 401（DSH 的鉴权握在 Electron 窗口里），而插件路由虽然免鉴权，
  页面本身进不去；另外 `/probe` 现在返回 401，说明**运行中的应用还是我加 probe 之前那次重启**。

所以截图仍卡在：① 你重启一次 DSH 应用（`/probe`、volatile 配置字段、配置页都才生效）；
② 一个能进 GUI 的浏览器会话。在那之前我不会拿静态重建图冒充真机截图。

## 三、待办

| # | 工作 | 说明 |
| --- | --- | --- |
| 1 | ~~i18n~~ | ☑ 已完成，见下面第 7 条 |
| 2 | ~~可安装性实测~~ | ☑ 已完成，见下面第 5、6 条与第 8 条 |
| 3 | 截图 + `screenshots.json` | 需要真机截图（左侧 Studio、提交胶囊+时间线、右侧召回面板、插件配置页） |
| 4 | README 更新 | 加截图、市场安装方式、兼容性说明（依赖 `@openviking/dsh-memory-plugin` 的内部结构这件事要写明） |
| 5 | 条目 yml | `data/plugins/<owner>__<repo>.yml`，一个文件 |
| 6 | 版本 0.2.0 | 这次是新增功能，按 RELEASING.md 走 minor；用 `pnpm run release` 本地打标签（**不发 npm**） |

### 7. 界面中英双语 ☑

**客户端**：新增 `src/client/locale.ts` —— 中英两套字典（各 112 个键），`attachLocale(ctx.locale)`
读取应用语言，`t()` 取词。三个刻意的取舍写在文件头：英文是兜底（不是中文）、缺键时返回键本身
（错字会在界面上显形）、**不调用 `ctx.locale.register`**（本插件是自己文案的唯一消费者，
注册只是把字典冻结在加载时刻）。

**宿主**：宿主跑在没有语言概念的 Node 里，原先它直接拼中文句子。现在协议里加了
`PluginNotice { code, params }`：宿主只报告"发生了什么"，客户端按 `notice.<code>` 出词，
未知码退化成码本身（新宿主 + 旧客户端不会渲染出空白）。

**防回归**（`test/locale.test.mjs`，5 个用例）：中英字典键集必须完全一致；组件用到的每个键
都必须存在（扫描 `t('…')` 与字段表）；同一键在两套语言里的占位符必须一致（否则会漏出 `{count}`）；
语言解析顺序（应用 → 浏览器 → 英文）；缺键与多余参数的行为。

顺带把 `describeFailure` 的兜底文案从 `shared/commit-state.ts` 移走——那个模块两半都 import，
只有一半有语言；现在它只返回服务端自己的消息，措辞由客户端决定。

### 13. 修掉一个"陌生人根本装不上"的问题 ☑

CI 逐字执行的第一条命令是 `pnpm install --frozen-lockfile`。我复现它时**退出码 1**：

```
Error: ERR_PNPM_IGNORED_BUILDS
  ╰─▶ Ignored build scripts: @deepseek-ai/dsh-subprocess-local, @google/genai,
      koffi, node-pty, protobufjs
```

根因是 `pnpm-workspace.yaml` 里那五个包的值是 pnpm 交互式授权**写回去的占位文字**
（`set this to true or false`）——既不是 true 也不是 false，于是 pnpm 判定"未决定"并直接失败。
也就是说：**任何人 clone 下来都装不上**，第一次 push CI 就红。

修法是把每个脚本都明确表态，并写清理由：esbuild 需要（构建要它 stage 平台二进制），
另外五个是随 DSH 类型包一起进来的传递依赖，本仓库**一个都不跑**——为它们放开原生扩展的
构建授权，等于要一份没人用得上的权限。修完 `pnpm install --frozen-lockfile` 退出 0。

顺带把 CI 的 pnpm 从 11 提到 **12**：锁文件与本机、以及桌面端装插件用的都是 12，
而 `allowBuilds` 是 12 的配置键——钉在 11 上有可能因为这个键不被识别而再次 `ERR_PNPM_IGNORED_BUILDS`。
CI 的五步我现在都在本地逐条复现过（checkout → node 22 → pnpm 12 → frozen install → `pnpm test`）。

**防回归**：`scripts/check-package.mjs` 增加两条断言——`allowBuilds` 里不允许出现未决定的值
（已验证：把一条改回占位文字，检查如实报红），以及 esbuild 必须是 `true`。

### 14. 依赖注入面核对 ☑

`dsh.client.inject` 里的每一个包都必须在运行中的 shell 里存在，否则客户端半部分可能根本加载不上。
逐个核对（asar 内 `/dsh/package.json` 与 `dsh-web-app/package.json`）：

| 包 | 出处 |
| --- | --- |
| `dsh-client-locale` | web-app package.json + patch 里的 `locale` 行 |
| `dsh-client-ui-slots` | 应用自己的 `/dsh/package.json` |
| `dsh-client-ui-layout` / `-sidebar` / `-sidebar-right` / `-conversation` | web-app package.json |

六个全部存在。另外 `pnpm publish --dry-run` 会先跑 `prepack`——发布路径上一定会重建 `lib/`。

### 17. GitHub 仓库已建并推送 ☑

- 账号 `A2chitect`（`gh auth status` 确认 token 带 `repo` scope），仓库
  **https://github.com/A2chitect/dsh-openviking-enhance**，公开，描述用的就是 `package.json`
  那句；topic 已加 `dsh-plugin`（收录要求）、`openviking`、`deepseek-harness`。
- `main` 分支与 `v0.1.0` 标签都已推送。
- **推送触发的 CI 首次运行就通过了**（20 秒，node 22 + pnpm 12 + `pnpm install --frozen-lockfile`
  + `pnpm test`）。上一轮修掉的"build script 未决定导致装不上"如果没修，这一次就是红的。
- 推送前做了一次隐私扫查：跟踪文件里没有 `/Users/a2chitect` 之类个人路径、没有 token/key
  （命中的只是包名 `dsh-llm-deepseek-api-key` 与测试夹具 `192.168.1.10`）；`docs/`（我的工作笔记）、
  `.backup/`（profile 清单备份）、`.scratch/` 都在 `.gitignore` 里，不会被推上去。
- **1 天门槛**：仓库 createdAt 为 `2026-10-02T06:46:47Z`，即本地时间 14:46:47，
  所以 **2026-10-03 14:46 之后**才可以提收录 PR。

### 18. 从公开仓库直接安装会发生什么（实测）☑

仓库公开之后，陌生人完全可能直接 `dsh plugin add https://github.com/A2chitect/dsh-openviking-enhance`。
拿真实的公开地址实测：

```
pnpm add git+https://github.com/A2chitect/dsh-openviking-enhance
  → 退出码 1：build scripts but is not in the "allowBuilds" allowlist
  → node_modules 里什么都没装
```

也就是说：**它会响亮地失败，而不是静默装一个没有 `lib/` 的壳**——这正是上一条 `prepack` 带来的
行为。规范对这种情况给的解法就是"挂一个预构建 tarball 并用 `tarball:` 字段指向它（如果你的仓库
根本无法从源码安装，这一项是必需的）"。所以 **npm / tarball 是规范prescribe 的路径**，
"把 `lib/` 提交进仓库"只是可选便利，不是必需项。README 的安装段已按这个事实改写。

## 三点五、仓库建好之后（照抄即可）

名字定下来后，除了建仓库/加 topic，剩下的都是填空。

**1. package.json 补一个字段**（npm 与仓库的关联只认它）：

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" },
```

**2. 投稿文件**：往 awesome-dsh-plugin 提交**一个**文件
`data/plugins/A2chitect__dsh-openviking-enhance.yml`（内容已备好，可直接用）：

```yaml
url: https://github.com/A2chitect/dsh-openviking-enhance
name: A2chitect/dsh-openviking-enhance
category: ui              # 见第 21 条：它不提供记忆能力，只是把 OpenViking 的状态画进界面
description:
  en: 'OpenViking in the DSH web GUI: a Studio panel, a per-session memory-commit status pill with its commit timeline, and a right-sidebar tab showing what the current session retrieves.'
  zh: '把本地 OpenViking 记忆服务接进 DSH 界面：左侧边栏的 Studio 面板、输入框下方的会话提交状态胶囊与提交时间线，以及右侧边栏查看当前会话检索到哪些记忆的面板。'
```

这份内容已经**用他们的真校验器验过**（见下面第 19 条）；本机也存了一份在
`.scratch/A2chitect__dsh-openviking-enhance.yml`（该目录被 .gitignore 忽略，不会进我们的仓库），
到时候直接复制过去即可。

若最后选择发 npm 而不是挂 tarball，条目里**不要**写 `npm:` 字段——规范明确说会被校验拒绝，
映射由 registry 自动采集（前提是 `repository` 指回本仓库，已填）。

描述就是 `package.json` 里那一句，已按规范核对过：只说功能、无营销词、提到的每一个东西
（Studio 面板 / commit 胶囊 + 时间线 / 右侧召回 tab）都能在代码里指出来。
注意含 `: ` 必须加引号（规范专门警告过 YAML 会把它当嵌套键）。

**3. 发布**：先发 npm（`pnpm publish`，`prepack` 会自动重建 `lib/`），或者给一个 GitHub Release
挂 tarball 并在条目里加 `tarball:`（资产名**不要带版本号**，否则下次发版静默 404）。
发 npm 的话，`repository` 指回仓库这一条是硬要求——否则市场不会把包和仓库关联起来。

## 三点六、你拍截图时照这个来

重启应用后，四张图（尺寸随意，但要能看清）：

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | 左侧边栏 → OpenViking | Studio 面板（能看出是嵌在 DSH 里的） |
| 2 | 输入框下方胶囊 → 点开 | 时间线（最近 3 次提交）+ 展开某次看记忆清单 |
| 3 | 右侧边栏 → `+` → 记忆召回 | 召回结果（三个来源、分数着色、展开一条看全文） |
| 4 | Plugins 页 → 本插件 → Configure | 配置表单（地址 + 检测按钮 + 默认按钮） |

存到 `assets/`，然后在 `package.json` 旁边放 `screenshots.json`（路径相对该文件，1–8 张）：

```jsonc
// <repo>/screenshots.json
["assets/panel.png", "assets/timeline.png", "assets/recall.png", "assets/config.png"]
```

市场会照这个顺序展示；不声明也行——它会从 README 里抽，但你这个 README 里目前没有图。
图片进仓库时记得**别把隐私截进去**（会话标题、路径），必要时打码。

### 15. 陌生人路径完整跑通 ☑

把 CI 的五步在**全新 clone** 上逐条复现（不是在有 node_modules 的工作区里）：

```
git clone <repo> /tmp/ci-probe && cd /tmp/ci-probe
ls                      → 只剩该跟踪的文件（docs/ 与 .scratch/ 已被 .gitignore 排除）
pnpm install --frozen-lockfile   → exit 0
pnpm test                        → exit 0：62 测试 + 20 项发布契约 + 客户端产物断言 + fence + 冒烟
```

也就是说，一个陌生人 clone 下来就能装、能跑、能验证——这正是收录页那句话（"装上他挑中的插件后，
它确实做描述里写的那件事"）在本仓库这一侧对应的部分。

### 16. PR 说明（英文，可直接粘贴）

> Adds `data/plugins/<owner>__<repo>.yml` for **dsh-openviking-enhance**.
>
> The list already carries three OpenViking entries — the official memory plugin, a tool-surface
> plugin, and a configuration UI for the official plugin. This one is none of those: it provides no
> memory capability and writes nothing. It is the visibility surface — the server's own Studio inside
> the left sidebar, a per-session commit pill with its timeline of what each commit changed, and a
> right-sidebar tab showing which memories the current session retrieves.
>
> It brings a local [OpenViking](https://docs.openviking.ai) memory server into the DSH
> web GUI: a Studio panel in the left sidebar, a per-session memory-commit status pill
> with its commit timeline under the message box, and a tab in the right sidebar showing
> what the current session retrieves. The plugin is read-only — it never commits, writes
> or deletes anything in OpenViking.
>
> The repository declares `dsh.bundle` with a `cordis.patch.yml`, ships a prebuilt client
> bundle, has no runtime dependencies (the one official package it needs is bundled at
> build time), and declares the harness as a peer. Settings are edited on the plugin's row
> on the Plugins page. The interface follows the app's language (Chinese and English).

（按你的偏好，公开 PR 一律英文。实际提交时把 `<owner>__<repo>` 换成真实文件名。）

## 三点七、发布那一步的命令（我先不做，等你）

**共同第一步**——出 0.2.0：本次是新增功能，按 RELEASING.md 走 minor。

```bash
pnpm run release minor      # 把 ## Unreleased 提成 ## 0.2.0 — <日期>、写 package.json、跑门禁、commit、打 v0.2.0
git push --follow-tags
```

门禁会带 `SMOKE_REQUIRE_SERVER=1`，所以跑这条之前 OpenViking 要在运行。

**路线 A：发 npm（推荐，市场能显示下载量）**

```bash
pnpm publish                # prepack 自动重建 lib/；private 已移除；repository 已指回仓库
```

需要你先 `npm login`（我无法代做）。发布后**条目 yml 里不要加 `npm:` 字段**——规范明确说会被校验拒绝，
映射由 registry 自动采集，前提正是 `repository` 指回仓库（已填）。

**路线 B：GitHub Release 挂 tarball（不发 npm 时）**

**优先用钉住 tag 的写法**——列表里最新两条条目都是这么写的，它 URL 自带版本、发下一个版本不会让
旧链接悄悄失效：

```bash
pnpm pack --pack-destination /tmp
gh release create v0.2.0 /tmp/dsh-openviking-enhance-0.2.0.tgz \
  --title "v0.2.0" --notes-from-tag
```

```yaml
tarball: https://github.com/A2chitect/dsh-openviking-enhance/releases/download/v0.2.0/dsh-openviking-enhance-0.2.0.tgz
```

另一种是 `latest/download/`，**那时文件名必须去掉版本号**：`latest` 只在请求时解析，
文件名是照字面取的，带版本号的话链接提交当天有效、下一次发版就 404，而且没人会发现。

```bash
cp /tmp/dsh-openviking-enhance-0.2.0.tgz /tmp/dsh-openviking-enhance.tgz   # 去掉版本号
gh release create v0.2.0 /tmp/dsh-openviking-enhance.tgz --title "v0.2.0" --notes-from-tag
```

### 19. 投稿文件已过他们的真校验器 ☑

条目不能只靠读规范猜格式，所以我把收录仓库 clone 到 /tmp，放上我的条目，跑了他们 CI 用的那支
`scripts/check-submission.mjs`（真实 token、真实 GitHub API）：

```
checking 1 entry
::error file=data/plugins/A2chitect__dsh-openviking-enhance.yml::
  https://github.com/A2chitect/dsh-openviking-enhance — repository is 0.0 days old (needs 1)
  — nothing to do: this check re-runs by itself and should clear in about 24h.
    No need to resubmit, push, or close and reopen; the age bar is the only thing failing here.
```

读法：条目**解析通过**、`dsh.bundle` 检查**通过**、仓库存在且未归档**通过**——
**唯一没过的是年龄**（它自己算了是 0.0 天）。输出末尾那段 "A bundle manifest looks like…"
是所有失败都会打印的页脚，不是 manifest 没过（`check-submission.mjs:572-575`）。

顺带跑了他们的 `scripts/generate-readme.mjs`：我的条目在两个 README 里各生成一行，`: ` 处理正确，
中文行也正常（补了 `zh` 描述后，README.zh.md 显示中文而不是回退英文）。

**它还说年龄这项会自己重跑**——所以现在开 PR 也不会被拒，24 小时内自己变绿；
不过更体面的做法还是过了门槛再提。

复现命令（clone 后装个 js-yaml 即可，不需要 `npm ci`）：

```bash
git clone --depth 2 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin /tmp/list-probe
cd /tmp/list-probe && npm i js-yaml --no-save
cp <我们的>.scratch/A2chitect__dsh-openviking-enhance.yml data/plugins/
git add -A && git commit -m "add entry"
GITHUB_TOKEN=$(gh auth token) node scripts/check-submission.mjs --base HEAD~1
node scripts/generate-readme.mjs
```

### 20. 描述与代码对齐（规范最较真的一条）☑

规范把"描述必须属实、会被对着代码核"列为**打回主因**，所以我把 README / CHANGELOG 里对召回面板的
描述逐句对着实现核了一遍，抓到一处漂移：文档写的是每条命中显示 "`viking://` path"，
而面板**实际只显示文件名**（完整路径在悬停与展开时才有）。已按实际行为改写两份 README 与 CHANGELOG，
顺带把两处用户看得见但没写进去的行为补上：分数是**红→橙→绿分级**的，标签里有**类型**
（`entity` / `event` 等）。

同时补齐 npm 元数据清单里剩下三项：`author`、`homepage`、`bugs`（此前只有 `repository` 与
`keywords`）。`check-package.mjs` 已断言 `repository` 是 URL，`pnpm test` 仍全绿。

### 21. 分类从 `memory` 改成 `ui`，以及一次竞品扫描 ☑

规范第 4 条是"是否已被现有条目覆盖"，所以投稿前把列表扫了一遍：

**列表里已有三个 OpenViking 条目**，都在 `memory`：
- `volcengine/OpenViking#examples/dsh-memory-plugin`——官方记忆插件本体；
- `Rxiain/dsh-openviking`——`memsearch`/`memfind`/`memcommit` 等一堆**工具面**；
- `xbzbing/dsh-openviking-manager`——"**Configuration UI** for the official OpenViking memory plugin：
  连接与用户 Key 配置、本机连接诊断、会话级记忆开关、召回调优"。

第三个和我在这一轮加的**配置页 + 连接检测**功能面重叠。但整体不构成覆盖：我没有提供任何记忆能力、
也不写任何东西，我做的是另外三件列表里没有的——**服务端 Studio 内嵌进左侧边栏**、
**会话提交状态胶囊 + 提交时间线（含每次提交改了哪些记忆）**、**右侧边栏的召回可视化**。

**分类因此改判**：`memory` 类 206 条、全部是"提供记忆"的后端插件；`ui` 类 764 条里正是我这种形态
（"HUD status panel"、"Anatomy panel"、"sidebar entry opens a note panel"——把某种状态画进界面）。
按规范那句"选贴合插件**实际做的事**的分类，而不是你希望它出现在哪里"，想跟另外三个做邻居正是后半句，
所以定为 `ui`。已用他们的校验器重验通过，README 生成器把条目放进了 **### UI Enhancements** 段。

PR 说明里补了一段主动说明差异（评审第 4 条正是看这个）：

> The list already carries three OpenViking entries — the official memory plugin, a tool-surface
> plugin, and a configuration UI for the official plugin. This one is none of those: it provides no
> memory capability and writes nothing. It is the visibility surface — the server's own Studio inside
> the left sidebar, a per-session commit pill with its timeline of what each commit changed, and a
> right-sidebar tab showing which memories the current session retrieves.

### 22. 字段完整性与功能面撞车（各有硬证据）☑

**字段**：把 4412 条条目全扫了一遍，用到的顶层字段只有四个——`url`、`name`、`description`、
`category`，另有 346 条带可选的 `tarball`。**没有别的字段**（没有 `added` 日期、没有 `npm`、
没有截图键），所以我的条目是完整的，不需要等维护者补任何东西。

**功能面**：按功能而不是按 OpenViking 再扫一遍——谁还占了"右侧边栏 + 记忆"、"输入框下方的记忆/提交
状态"、"把某个本地服务自己的 UI 嵌进 DSH"：
- 右侧边栏 + 记忆：只有 `dsh-quick-open`、`dsh-minimal-UI-panels` 两个通用面板顺带提到记忆；
- 提交/状态胶囊：命中的四条都是引用消息、移动端、附加组件之类，与记忆提交无关；
- 嵌入第三方 UI：只有 `Copree--dsh-copree`（把 Copree 以侧边栏形式嵌入），是另一种产品。

结论：**我那三个界面在列表里没有对应物**，与另外三个 OpenViking 条目的重叠只在"配置连接"这一小块。

**顺带纠正我文档里的一个推荐**：最新两条条目用的是**钉住 tag** 的 tarball 写法
（`releases/download/v0.2.0/pkg-0.2.0.tgz`），它比 `latest/download/` + 去掉版本号文件名更省事也更稳
（URL 自带版本，发下一个版本不会让旧链接悄悄失效）。下面第 3 节已按这个顺序改写。

### 23. 他们 CI 的四步，我在本地复现了三步 ☑

| CI 步骤 | 本地复现 | 结果 |
| --- | --- | --- |
| `check-submission.mjs`（条目数 / `dsh.bundle` / 仓库年龄 / 非 DSH） | ✔ | 只有年龄未过，其余全过（第 19 条） |
| `generate-readme.mjs` + 两 README 的 locale parity | ✔ | 条目在两个 README 各生成一行，中英都有（第 19 条） |
| 站点数据（4412 条条目的字段集） | ✔ | 字段只有 `url`/`name`/`description`/`category`（+可选 `tarball`），我的条目完整（第 22 条） |
| `build-site.mjs` | ✖ 本地不可复现 | 见下 |

站点构建在本地跑不起来，报的是：

```
refusing to publish: only 1442/4412 entries (32.7%) have a star count, below the 66% floor.
data/stars.json is empty or truncated — almost always probe-stars.mjs hitting an exhausted
GitHub API quota on a cold cache.
```

跑了**对照实验**：把条目移走再构建，**报错完全相同**（exit 1）。也就是说这个失败来自他们自己的
star 探测数据（要联网刷 GitHub 配额），与我的投稿无关，我这边无法在本地补齐。

### 24. 发布命令整条演练过（在公开仓库的克隆里）☑

`pnpm run release minor` 是你只会跑一次的命令，之前只用桩数据排练过、没拿**真实的 CHANGELOG**
跑。这次把公开仓库 clone 到 /tmp，装好依赖，**原样跑了一遍**（没有推送）：

```
[release] 0.1.0 -> 0.2.0
[release] notes       51 line(s) from "## Unreleased"
[release] gate        pnpm test with SMOKE_REQUIRE_SERVER=1
[release] changelog   "## Unreleased" promoted to "## 0.2.0 — 2026-10-02"
[package] all checks passed        # tests 62  pass 62  fail 0   client 全过   实时冒烟过
[release] commit      e326af4 release 0.2.0
[release] tag         v0.2.0
exit=0
```

产物逐项核对：

| 检查 | 结果 |
| --- | --- |
| `package.json` | `0.2.0` |
| CHANGELOG 顶部 | 重新放回一个空的 `## Unreleased` |
| 新段落 | `## 0.2.0 — 2026-10-02`，**中英两半都在里面**（`### Added` 与 `### 变更`/`### 新增`） |
| 旧段落 | `## 0.1.0`（英）与 `## 0.1.0（中文）` 都原样保留 |
| 标签正文 | 就是这段发布说明（含中文部分） |
| 工作区 | 干净，提交为 `release 0.2.0` |
| 再跑一次 | 正确拒绝：`"## Unreleased" is empty`——稳态成立 |

也就是说你那条命令的行为已被完整验证，包括"发布后不会误发第二次"。剩下的只有 `git push --follow-tags`
与 npm 发布本身，那两步按约定归你。

### 25. 一次真实的线上事故：插件重启后起不来 ☑

你重启应用后插件激活失败：`TypeError: (path ?? "").trim is not a function at normalizeStudioPath`。

**根因**（现场实测，不是推测）：schemastery 的 `.volatile()`——我为了让配置字段出现在 Plugins 页的
表单里而加的那个标记——**让字段解析成引用对象而不是值**：

```
z.object({ studioPath: z.string().default('/studio/').volatile() })({})
  → { studioPath: {} }        // 只有一个 get()，.trim 自然不存在
未加 volatile 的字段 → '/studio/'（原值）
```

`apply()` 里 `config.studioPath` 拿到的是 `{ get }`，`(path ?? '').trim` 立刻抛，整个条目激活失败。

**修法**：`ConfigField<T> = T | { get(): T }` 作为**参数类型**（让编译器以后挡住原始读取），
所有 5 处读取都走 `configText()` / `configNumber()` 解包；非 volatile 的普通值同样接受。

**证据链**（这次事故暴露的真正问题是"测试没覆盖应用实际走的那条路"）：

| 检查 | 结果 |
| --- | --- |
| 新增激活回归测试（用 schema 解析出的配置调 `apply`） | 拿掉修复→**如实报出与你截图逐字相同的** `(path ?? "").trim is not a function`；装回→通过 |
| 为什么原先没抓到 | 冒烟调的是 `apply(context)`（**不传配置**）——从未走过 Loader 真实传参的形状。已改为 `Config({...})` 解析后再传，并对覆盖值做断言 |
| 全量 | 64 测试 + 发布契约 + 客户端断言 + fence + 实时冒烟 + 降级，全绿 |

教训记在这里：**"能装"和"能被应用激活"是两件事**，而后者只有当参数形状与 Loader 一致时才算验过。

### 26. 插件再也不会把应用搞挂（并顺带确认了它现在真的能起来）☑

第 25 条那个 bug 让你重启后应用起不来（`web boot: 1 entry did not activate / dsh-openviking-enhance: failed`）。
除了修根因，还补了一条**工程约束**：

```ts
export function apply(ctx, config = {}) {
  try { start(ctx, config) }
  catch (error) { logger?.error?.(`[openviking-enhance] failed to activate, so the plugin provides nothing: ${stack}`) }
}
```

一个"看本地记忆服务的面板"没有资格让整个 profile 起不来。失败改为**完整落日志**——第一次出这事时，
唯一可见的症状就是启动对话框，原因只能靠手工重建。测试里把那句 `the service exploded` 断言进了日志内容，
不只是断言"没抛"。

**复现方法**（比读日志靠谱，以后遇到同类问题直接用）：把你的 desktop profile 整个拷到 `/tmp`，
改个 profile 名（CLI 拒绝启动 Electron 专属的 `desktop`），修掉指向本目录的相对软链，然后
`dsh --profile diag --port 8799 --no-open`。实测：

```
copy composed of: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-openviking-enhance"]
启动输出：没有任何 warning
/config -> 200   /status -> 200   /probe -> 200     ← /probe 只有新宿主半部分才有
```

顺带发现：**web UI 的鉴权是启动时打印的 `?token=`**（`dsh web: http://127.0.0.1:8799/?token=…`），
这就是裸 curl `GET /` 一直 401 的原因。

### 27. 第二次真实事故：客户端半部分整个没注册 ☑

症状：宿主半部分 `fiberPhase: active`（应用自己的插件管理器说的），但我读**当前页面**的实时 Slot 树，
左侧边栏只有 4 行，没有我那一行；胶囊、召回 tab 同样不见。用户在 Plugins 页看到：

```
dsh-openviking-enhance: Error: cannot get property "locale" without inject
```

**根因**：Cordis 禁止读取**未声明注入**的服务属性——不是警告，是抛错。i18n 那轮我在客户端
`apply` 开头写了 `attachLocale(context.locale)`，而客户端只声明了 `inject = ['slots']`。
这一行**在所有 try 之外**，于是它一抛，整个 `apply` 就死了：侧边栏行、主面板、胶囊、召回 tab 全部
注册不上，而宿主半部分照常 active、日志里什么都没有。

**修法**：改用可选访问器 `context.get('locale')`（locale 只是便利——每个字符串本来就有英文兜底，
所以也不该让条目为它等待）；并把 `ClientContext` 里那个 `locale?: LocaleServiceLike` 字段**删掉**，
免得它继续诱导直接属性访问。

**为什么冒烟没抓到（这次的真问题）**：假 context 是个普通对象，**对任何属性都返回 undefined**，
从不模拟 Cordis 这条规则。已把冒烟改成 `Proxy`，只有 `inject` 声明过的、`get()` 以及 context 自身的
动词可读，其余一律抛 `cannot get property "x" without inject`。换新断言跑**未重建的旧产物**：

```
[client] FAIL apply() does not throw: cannot get property "locale" without inject
[client] FAIL registers the left-sidebar row (sidebar.panellist)
[client] FAIL registers the matching centre panel (main)
```

与用户在界面上看到的那句逐字相同，并直接指出丢掉的注册。这类"假 context 太宽容"的坑，
和前面"假配置形状太宽容"是同一个教训：**替身必须和真家伙一样挑剔，否则测试只验证了替身。**

### 28. 截图：用一个空白 profile + 假服务器拍，不碰真实环境 ☑

你要求"别泄露真实环境"，所以没有在你的 desktop profile 里截。做法：

1. **全新临时 profile**：`DSH_HOME=/tmp/shots/dsh`，用官方 web 模板初始化（`--from-default-profile web`），
   组成只有 base + web-app + 本插件——没有工作区历史、没有真实会话、没有你的其他插件。
2. **假 OpenViking**：`scripts/screenshot-fixture.mjs`（已入库）在 loopback 上照真实端点与信封
   （`/health`、`/api/v1/sessions/{id}`、`/fs/ls`、`/content/read`、`/tasks`、`/search/search`、`/studio/`）
   应答**全部编造的内容**——记忆名、摘要、分数、图谱节点都是假的。临时 profile 的 patch 把插件指向它。
3. **无头 Chrome + DevTools 协议**脚本化点击与截图：`HOME` 指到 /tmp（否则 Chrome 会去碰
   `~/Library/Application Support/Google/Chrome` 被沙箱拦），`--headless=old`（新版 headless 在本机会挂），
   `Emulation.setDeviceMetricsOverride` 给 2x 缩放。
4. 逐张核对**没有出现任何真实信息**：工作区名是 "Default workspace"、账号是 `demo/demo`、
   记忆内容全是编造的。

产物（四张齐了）：`assets/studio-panel.png`、`assets/commit-pill.png`、`assets/recall-tab.png`、
`assets/settings-form.png` + `screenshots.json`（市场按这个顺序展示），README 中英两份各嵌了 Studio 那张。

**第四张（胶囊）怎么来的**：shell 只在"跑过一轮对话"的会话里渲染输入框下方的 dock，空会话没有容器可挂。
所以又加了 `scripts/screenshot-model.mjs`——一个假的 OpenAI 兼容模型（`/v1/chat/completions`，
SSE 逐字返回一段编造的清单和 usage），临时 profile 的 patch 里用 `llm-pi-ai` 注册它、
并用 `agent-default-model` 把它设为默认模型。于是产生**一轮真实交互**：转写、usage、dock 全部由 shell
自己渲染，胶囊（`OV · 3 commits`）和它的提交时间线自然出现。

两个坑记在这里：**把文字塞进输入框必须走 CDP 的 `Input.insertText`**（自己 `dispatchEvent` 一个
`input` 事件进不了编辑器的状态，发送按钮会当成空草稿直接忽略）；**模型选择器只列出组合里注册过的
provider**，所以 `agent-default-model` 直接指定比在界面上点更省事。

**顺带发现并修掉一个真 bug**：这次截图暴露出插件的界面语言跟随的是**浏览器**而不是**应用**——
`ctx.locale` 会抛错（第 27 条），而 `get('locale')` 也拿不到那个服务，于是退回 `navigator.language`。
改成作用域注入 `context.inject(['locale'], …)`（与召回 tab 取注册表同一套写法），并让两条测试的替身
按真实路径提供该服务。你在真机上看着正常，是因为你的浏览器语言恰好与应用一致。

## 四、需要你拍板

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | ~~分类~~ | 定为 **`ui`**（第 21 条有理由），已用他们的校验器验过；规范说选得不准维护者会直接改 |
| 2 | ~~GitHub owner / 仓库名~~ | 已建：`A2chitect/dsh-openviking-enhance`（见第 17 条） |
| 3 | npm 包名 | `dsh-openviking-enhance` 在 registry 上 404（未被占用）；是否加 scope |
| 4 | 分发方式 | **推荐 npm + GitHub Release tarball**（第 6 条已实测：源码安装要么静默装坏、要么被 `allowBuilds` 拦住）。另一个选项是**把 `lib/` 提交进仓库**——raw git 安装就能直接可用，代价是每次改 src 都要重新提交构建产物（可以用 CI 校验 `lib/` 是否与 `src/` 同步来兜底）。这条会改变仓库的跟踪内容，所以留给你定 |
| 5 | LICENSE 署名 | LICENSE 里现在写的是 `dsh-openviking-enhance contributors`，而 `package.json` 的 `author` 我在补元数据时填了 **A2chitect**。两者不一致，改哪个由你定（署名是归属声明，我不擅自改） |
| 6 | i18n 范围 | 界面中英双语，还是先只做英文 README |

## 五、证据索引

| 结论 | 怎么看 |
| --- | --- |
| 打包产物完整 | `pnpm pack --pack-destination /tmp && tar tzf /tmp/dsh-openviking-enhance-0.1.0.tgz` |
| 宿主半部分自包含 | `grep -oE 'from "[^"]+"' lib/index.js \| sort -u` |
| 配置页座位已注册 | `node scripts/smoke-client.mjs`（`plugins.row.config` 那两条） |
| probe 只认 loopback | `node --test test/host-units.test.mjs`（`parseLoopbackEndpoint` 那条） |
| tarball 装得上且零依赖可加载 | 见上面第 5 条的三条命令 |
| 源码安装的四种形态 | 见上面第 6 条；重跑：`pnpm add git+file:///<clone>` |
| 发布产物不会缺 lib/ | `rm -rf lib && pnpm pack --pack-destination /tmp && tar tzf /tmp/*.tgz \| grep lib/` |
| 中英字典一致 / 无缺键 | `node --test test/locale.test.mjs` |
| 真实安装 + 组合树 | 见上面第 8 条的三条命令（`DSH_HOME` 指向临时目录） |
| 没有 OpenViking 时的降级 | `SMOKE_ENDPOINT=http://127.0.0.1:9 node scripts/smoke-host.mjs` |
| 发布要求全部成立 | `node scripts/check-package.mjs`（也是 `pnpm test` 的一环） |
| 打出来的 tarball 里真有构建产物 | CI 新增一步：`pnpm pack` 后逐项 grep `lib/index.js`、`lib/client.js`、`cordis.patch.yml`、LICENSE、package.json |
| 组件真的能渲染 | `node --test test/component-render.test.mjs` |
| 配置表单的写入语义 | `node --test test/config-ops.test.mjs` |
| 全量回归 | `pnpm test` |
