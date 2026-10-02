# 发版流程

面向维护者。这个仓库只有一条发版路径：**先把变更写清楚，再跑一条命令。**

本包是 `private: true`，以 `link:` / 路径方式装进 DSH profile，所以"发布"不是 `npm publish`：
一次发布 = 一个 git 标签 + 一条 changelog 记录，没有上传步骤。

## 一、版本号怎么定

处于 `0.x` 阶段，但这里按比 semver 更严的约定执行：

| 改了什么 | 版本位 | 例子 |
| --- | --- | --- |
| 修 bug、改文案、调样式，对外行为不变 | patch | `0.1.0` → `0.1.1` |
| 新增功能、新增配置项 | minor | `0.1.1` → `0.2.0` |
| 已有配置项含义改变、接口契约变化、抬高 DSH/OpenViking 最低版本 | major | `0.2.0` → `1.0.0` |

## 二、发版

### 第 1 步：写变更

把这次要发布的内容写到 `CHANGELOG.md` 顶部的 `## Unreleased` 下面，中英两段都写。
空着发不出去——脚本会拒绝：一个没有说明的版本，以后没人能还原它改了什么。

### 第 2 步：跑命令

```bash
pnpm run release patch     # 或 minor / major，也可以直接写 0.2.0
```

（`pnpm run release -- patch` 这种写法同样认：pnpm 会把 `--` 原样传给脚本，npm 会把它吃掉，脚本两种都接受。）

它按顺序做这些事：

1. **前置检查**：工作区干净、新版本号严格大于当前、`v<新版本>` 标签不存在；
2. **检查变更说明**：`## Unreleased` 必须存在且有内容；
3. **改 changelog**：把 `## Unreleased` 改名成 `## <版本> — <日期>`，并在最上面重新放回一个空的 `## Unreleased`；
4. **写版本号**：更新 `package.json` 的 `version`；
5. **跑门禁**：`pnpm test`（类型检查 + 构建 + 单测 + 客户端产物断言 + 两条冒烟），并且**要求真实 OpenViking 在线**（自动带上 `SMOKE_REQUIRE_SERVER=1`）——否则实时冒烟会静默跳过，等于没验；
6. **提交并打标签**：`git commit -m "release <版本>"`，再打注解标签 `v<版本>`，标签正文就是本次 changelog 说明。

第 3 步之后、提交之前的任何失败，都会把 `package.json` 和 `CHANGELOG.md` 还原回 HEAD：
**一次失败的发布不会留下半成品**，工作区还是它原来的样子。

### 排练与逃生口

```bash
pnpm run release minor --dry-run    # 只做检查、打印计划，不写任何东西
pnpm run release minor --no-live    # 服务不在线时跳过实时冒烟
```

`--no-live` 是例外而非常态：它意味着这个标签**没有真实服务的验证证据**，脚本会把这句话写进标签说明里。

### 第 3 步：验收

见第四节。

## 三、自动化在守什么

`pnpm test` 里包含 `test/release-meta.test.mjs`，它保证：

- `package.json` 的版本是合法 semver；
- `CHANGELOG.md` 必须有该版本的段落，且**最新一段的版本号等于 `package.json`**；
- 顶部必须留着 `## Unreleased` 落点；
- 版本号推算（`bumpVersion`）和 changelog 改名（`promoteUnreleased`）这两个函数本身也有测试——它们一次发布才跑一次，不测就等于从没跑过。

也就是说："改了版本忘了写 changelog"会直接让 CI 变红。CI 在 push、PR 以及 `v*` 标签上跑同一套 `pnpm test`。

## 四、脚本管不到的部分：手工验收

自动化只能验证宿主逻辑和产物不变量。"界面里到底长什么样、有没有真的挂上去"只能在 DSH 里看：

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 重载窗口 `⌘R` | 客户端部分生效（`lib/client.js` 是页面加载时取用的） |
| 2 | 重启 DSH 应用 | 宿主部分生效（`lib/index.js` 只在启动时加载）——**改了宿主必须重启，重载没用** |
| 3 | 看左侧边栏 | OpenViking 一行在**所有选项卡最后** |
| 4 | 点开该行 | 主区域加载出 Studio，刷新按钮可用 |
| 5 | 看输入框下方 | 胶囊排在内置胶囊之后，字号 / 行高 / 配色与内置一致 |
| 6 | 点开胶囊 | 显示最近 3 次提交的时间线，「显示全部」能展开 |
| 7 | 点其中一次提交 | 列出该次提交改动的 `viking://` 记忆路径 |
| 8 | 若有「抽取失败」 | 显示失败时间、耗时和服务端原始原因 |

## 五、手工发版（脚本坏了时的退路）

```bash
# 1. 改 package.json 的 version
# 2. 把 CHANGELOG.md 的 ## Unreleased 改名成 ## <版本> — <日期>，并补回空的 ## Unreleased
pnpm test                                # 门禁必须全绿
SMOKE_REQUIRE_SERVER=1 pnpm run smoke    # 确认实时通路真的跑了，而不是 SKIP
git add package.json CHANGELOG.md
git commit -m "release <版本>"
git tag -a v<版本> -m "<版本> — <日期>（说明写这里）"
```

手工做的时候别跳第四节的验收清单。

## 六、发布之后

- **远端**：仓库目前没有 remote，所以没有 push 这一步。将来加了远端就是 `git push --follow-tags`。
- **不需要重装**：插件以 `link:` 装在 `desktop` profile 里，版本号不参与依赖解析。
- **要重启**：宿主半部分的改动只有重启 DSH 应用才生效（客户端半部分重载窗口即可）。
- **下一次**：把新内容写回 `## Unreleased`，重复第二节。

## 附：本文件为什么只有中文

它是维护者文档，读者只有你；面向最终用户的两份 `README` 才是中英双语（`README.md` / `README.zh.md`）。
