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
category: memory          # 备选 ui；规范说选得不准维护者会直接改，不会打回
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

```bash
pnpm pack --pack-destination /tmp
cp /tmp/dsh-openviking-enhance-0.2.0.tgz /tmp/dsh-openviking-enhance.tgz   # ← 去掉版本号
gh release create v0.2.0 /tmp/dsh-openviking-enhance.tgz \
  --title "v0.2.0" --notes-from-tag
```

`cp` 那一步是规范专门警告的坑：`latest/download/` 只在请求时解析 `latest`，**文件名是照字面取的**。
资产名若带版本号，链接提交当天有效、下一次发版就 404，而且没人会发现。去掉版本号后条目写：

```yaml
tarball: https://github.com/A2chitect/dsh-openviking-enhance/releases/latest/download/dsh-openviking-enhance.tgz
```

（也可以钉住 tag、文件名带版本号：`.../releases/download/v0.2.0/dsh-openviking-enhance-0.2.0.tgz`。）

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

## 四、需要你拍板

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | 分类 `memory` 还是 `ui` | 只影响列表归类，选错维护者会改 |
| 2 | GitHub owner / 仓库名 | `url` 必须与仓库完全一致；也是 `repository` 字段的值 |
| 3 | npm 包名 | `dsh-openviking-enhance` 在 registry 上 404（未被占用）；是否加 scope |
| 4 | 分发方式 | **推荐 npm + GitHub Release tarball**（第 6 条已实测：源码安装要么静默装坏、要么被 `allowBuilds` 拦住）。另一个选项是**把 `lib/` 提交进仓库**——raw git 安装就能直接可用，代价是每次改 src 都要重新提交构建产物（可以用 CI 校验 `lib/` 是否与 `src/` 同步来兜底）。这条会改变仓库的跟踪内容，所以留给你定 |
| 5 | LICENSE 署名 | 现在写的是 `dsh-openviking-enhance contributors` |
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
| 组件真的能渲染 | `node --test test/component-render.test.mjs` |
| 配置表单的写入语义 | `node --test test/config-ops.test.mjs` |
| 全量回归 | `pnpm test` |
