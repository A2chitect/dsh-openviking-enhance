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
