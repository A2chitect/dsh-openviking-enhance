# dsh-openviking-enhance

[English](README.md) | 中文

**v0.3.0** · [更新记录](CHANGELOG.md) · [路线图](ROADMAP.md)

> 下面的 v0.4 Act、v0.5 Collaborate、v0.6 Trust and verify 与 v0.7 Native 变更
> 位于 `Unreleased`；版本行与包版本保持 0.3.0，直到发布脚本按版本逐个提升并打标签。

把本地 [OpenViking](https://docs.openviking.ai) 记忆服务接进 DeepSeek Harness
（DSH）的 Web 界面：左侧边栏的 OpenViking Studio 面板、输入框下方的 commit 状态
胶囊与 diff 浏览器、每条回复下方的召回解释、回答「记忆为什么没生效」的
「记忆健康」页、`viking://` 预览、`/viking` 命令和探索页（统一搜索 +
规则/技能/Experience 浏览），以及 v0.5 新增的协作层：**手动开启**的记忆策展
（输入确认 + 快照撤销）、强制提交、第五个「活动」tab，和带常驻作用域提示的
命名身份配置档。

不需要给 DSH 或 OpenViking 插件打补丁——它就是一个普通的 DSH bundle。

## 功能

**在 DSH 里直接读记忆。** 左侧边栏底部新增一行，打开一个**原生阅读面板**：概览、懒加载的 `viking://` 浏览树（带预览窗格）、分页会话浏览、有界最近提交浏览与统计。核心阅读任务不再需要 iframe；OpenViking 自带的 Studio 仍是一个显式视图（以及一个"在新标签页打开"），把 `showNativeViews` 设为 `false` 则精确回到 v0.6 的 Studio 页面。全部只读。

### 原生阅读面板（v0.7）

一行侧边栏入口、一个主面板、六个内部视图——不新增 shell 座位：

| 视图 | 读取内容 | 说明 |
| --- | --- | --- |
| **概览** | 一次组合请求：配置、身份作用域、健康/版本、记忆总量、能力探测与 Studio 可嵌入性 | 默认视图；各部分独立降级 |
| **浏览** | 按身份解析的根（记忆、peer、共享/个人资源、个人/Agent 技能、规则/会话快捷入口）加只读预览窗格 | 每展开一个目录一次 `fs/ls` 页（50 行、160 字符摘要、标签），按服务端游标翻页；显式「展开子树」最多 2 层 / 100 节点 |
| **会话** | 会话目录，每页 50，按修改时间倒序 | 服务端会话列表没有分页；详情复用有界会话日志（状态、待提交 token、任务、归档时间线、逐归档 diff）——**不读消息正文** |
| **提交** | 有界最近扇出：最新 8 个会话、并发 4、10 s 截止、30 s 缓存 | 服务端没有全局提交历史接口；不完整时会明确提示（"扫描 N 个会话后在 T ms 截止"），刷新重试。从不轮询 |
| **统计** | 与「活动」tab 相同的 REST 控制台/观察者/统计接口，共用指标卡片 | 从不探测 Prometheus `/metrics` |
| **Studio** | 原 v0.6 iframe，未改动 | 显式回退；宿主侧响应头探测会解释嵌入被拒，而不是让面板默默空白 |

- **导航只在内存中。** 后退/前进走有界（20 条）历史；面板重开回到概览。DSH 没有主面板选择的 URL 路由 API，因此没有浏览器 URL 路由。
- **深链不会抢占主栏。** 顺手的 `viking://` 点击仍打开右侧预览 tab；只有显式动作（预览 tab 里的"在原生面板中打开"、胶囊的会话上下文等）才通过结构化能力探测的 `ctx.layout.selectPanel('openviking')` 切换主面板；缺少该动作的旧 DSH 世代回退到预览 tab（面板工具栏会提示）。
- **首次运行检查。** 只读 Setup 卡片出现在概览与插件页的第二个 section：端点/健康/身份/官方记忆插件/能力/建议第一步。"运行完整检查"复用 Doctor；收起/完成状态按 DSH home 存在 0600 本地文件（见隐私）。
- **右侧边栏的 tab 不变。** 召回、记忆健康、预览、探索、活动仍是会话上下文入口；原生面板是全局阅读入口，并链接到它们（规则/经验仍在探索 tab）。

OpenViking 服务自带的 Studio 界面，浏览记忆、会话、检索都不用离开 DSH 或另开浏览器。

**每个会话的 commit 状态。** OpenViking 是按「提交（commit）」写入记忆的：会话的
对话轮次累积到 token 阈值（或会话结束）时归档一次，并抽取其中的记忆。输入框下方的
胶囊告诉你当前会话处在哪一步：

| 胶囊 | 含义 |
| --- | --- |
| `OV · 未提交` | 本会话还没有内容被提交 |
| `OV · 12.3k/20k` | 正在累积，接近提交阈值 |
| `OV · 抽取中…` | 正在归档并抽取记忆 |
| `OV · 3 次提交` | 已提交 3 次 |
| `OV · 抽取失败` | 最新一次提交已归档，但记忆抽取失败 |
| `OV · 已取消` | 最新一次提交在抽取记忆前被取消 |
| `OV · 不可用` | 连不上本地 OpenViking 服务 |

点开胶囊可以看到：

- **时间线**：最近 3 次提交分别发生在什么时候、抽取成功还是失败、各新增/更新/删除了多少条记忆
  （其余一次点击展开）；
- 点某一次提交，打开 **diff 浏览器**：按新增/更新/删除筛选，展开任意变更看前后文本与
  行级 diff，复制 `viking://` URI，或把整次提交导出为 JSON：

  ![提交 diff 浏览器中展开的一条更新](assets/v03-after-commit-updated.png)
- **抽取失败**的时间、服务端错误和 task id（task 记录尚未被清理时），并可复制错误。
  比最新提交更早的失败仍会列在这里，但不会改变胶囊状态。

胶囊与面板只读。打开 `enableWrites`（v0.5+）后，只有上文描述的策展弹窗与写入命令路径会改动数据；这里不做任何写入。

**这个会话检索到了什么。** 右侧边栏多一个「记忆召回」tab：显示当前会话会被
OpenViking 拉进上下文的记忆——检索用的那句话（默认是本会话最近一次提问，也可以自己输入）、
三个来源（记忆 / 资源 / 技能）里每条命中的分数（按高低从红到橙到绿分级）、文件名、
类型（`entity`、`event` 等）与摘要——完整 `viking://` 路径悬停可见，点开任意一条可看全文——
以及服务端给出的检索计划。从右侧边栏的 `+` 引导页打开，和该栏本身一样是按会话的。

![已完成回复下方的「记忆来源」卡片](assets/v03-after-explain.png)

**这条回复为什么用了那条记忆？** 每条已完成的回复下方多一个「记忆来源」入口。展开后
会用该轮提问重放服务端的上下文接口，显示提问、每条命中的分数、类别、`viking://` URI、
读取层级与来源、token 预算（已用/上限）、配额、层级统计、排除、跨轮去重、检索计划，
以及服务端组装的注入块。

卡片会明确说明这是**重放**：DSH 不保留记忆插件注入的原始文本，假装展示历史注入只会
误导人。没有上下文接口的旧服务端会退回逐目标检索，并说明原因。

![右侧边栏的「记忆健康」页：会话日志与 Doctor](assets/v03-after-health.png)

**这个会话到底被捕获了吗？** 右侧边栏新增「记忆健康」页，区分五种过去只能靠猜的状态：
没有捕获到消息、已捕获但未提交、提交后抽取中、抽取失败、写入正在本地排队（以及正常的
已提交）。页面显示消息数、待提交 token 与阈值、提交次数、最近提交/自动提交、最近任务，
以及一条带时间戳的活动时间线。它还会读取官方插件本地 pending 队列的**数量、类型和时间**
（绝不读取 payload）。

**为什么记忆不生效？** 同一个页面里有 **Doctor**：地址、健康、服务端版本、身份、
已挂载记忆插件的版本与生效的召回/捕获/提交设置、每个连接字段来自哪一层（profile 覆盖、
环境变量、`ovcli.conf`/`.local` 或默认值），以及上下文接口、规则检索、技能、`fs/stat`
与召回观测的真实探测，并列出模型可见的 `mcp__openviking__*` 工具。每项检查都会指出
可能的修复方向，诊断 JSON 和 `curl /health`
一键复制；API key 不会出现在任何报告里。

![Doctor 的检查项与能力探测](assets/v03-after-doctor.png)

插件在 **Plugins** 页的详情里也有一块健康摘要，不打开会话就能先回答「它正常吗」。

![嵌在 DSH 界面里的 OpenViking Studio 面板](assets/studio-panel.png)

Studio 面板、打开它的侧边栏行，以及输入框下方的提交状态胶囊。

![viking:// 预览页](assets/v04-after-preview.png)

**点开任意 `viking://` 路径。** 插件各详情视图里的每个 URI 现在都是链接——已加载的
召回行详情、召回解释卡、提交 diff 行、探索页命中行。点击会在右侧栏打开 *预览* 页
（已打开时直接切换目标），
显示条目的元数据（名称、文件/目录、上下文类型与记忆类型、分类、大小、修改时间、
锁定状态、标签），以及服务端三层读取内容：L0 摘要、L1 概览、L2 全文，每层都标明
是否可用、是否被截断。L0/L1 是 OpenViking 的**目录级 sidecar**，所以文件的这两层
描述的是它所在目录（面板会写明）；L2 只对文件可用，目录上会给出提示。全部按纯文本
渲染——记忆正文永远不会变成 HTML。面板里可以复制 URI、在 Studio 中打开条目，
也可以把 `viking://` 路径粘贴进地址栏直接跳转。

![/viking 命令输出 status](assets/v04-after-viking-status.png)

**在输入框里直接问。** `/viking status` 输出 endpoint、健康状态、服务端版本、身份、
已挂载的记忆插件、DSH 版本和当前会话的提交状态；`/viking doctor` 输出 Doctor 的检查项；
`/viking recall <query>` 用当前会话跑一次召回并列出带分数的命中；`/viking open <uri>`
输出元数据与有长度上限的 L0/L1。这些读取动词不会改动记忆库；v0.5 的写入动词见下文，
需要 `enableWrites`。`enableCommands` 可以关闭整个命令。

![探索页的统一搜索结果](assets/v04-after-explore-search.png)

**探索整个记忆库。** 右侧栏新增的 *探索* tab 有四个只读区块：**搜索**（一次查询覆盖记忆、
资源、技能并合并规则命中，按 bucket 分组显示分数与摘要，点行打开预览）、**规则**
（列出这个 OpenViking 提供的规则；一个只读试跑器展示规则为什么命中——要求、
`applies_when`、例外、概率与正文）、**技能**（已安装技能目录，点行打开其 `SKILL.md`）、
**Experience**（Agent Evolution experience 文件的轨迹与结果分布）。规则需要
OpenViking **0.5.3+** 并且会先做能力探测，旧版本显示明确的「不可用」而不是报错；
Experience 通常是空的，不是坏了。搜索只走语义检索：当前服务端拒绝关键词模式，
因此没有切换开关。

![开启写入后的预览操作栏](assets/v05-after-preview-actions.png)

**策展记忆——需要手动开启。** 默认不写 OpenViking 数据：必须在 **Configure** 里显式打开
`enableWrites`；关闭时插件就是上面的只读查看器。开启后，可策展的记忆文件在「预览」tab 里
多出操作栏——**编辑**、**标签**、**删除**——提交胶囊和「活动」tab 里多出**立即提交**。

- **只有记忆正文可策展**，且仅限 `viking://user/<u>/memories/{entities,events,preferences}/…`
  （以及可见的 peer 对应目录）。目录 sidecar、规则、会话归档、资源、技能和根部的
  `profile.md`/`identity.md`/`soul.md` 一律排除。
- **编辑**显示当前版本（hash、大小、修改时间）、字符数和可选 diff；保存时先读文件、
  对路径做快照、写入、回读校验，再做写入后快照。OpenViking 0.5.3 的内容写入没有 CAS，
  所以并发修改会在回读校验时暴露为冲突，提示重新载入。
- **删除**要求输入文件名，并明确提示服务端没有回收站。**标签**支持整体替换、追加、清空
  （`key=value` 语法），走同样的快照/撤销路径。每个走快照的动作都以**所在目录**为快照与
  恢复范围——两半使用同一个范围，因为测试过的服务端不保证文件级恢复可用。
- **撤销**是写入后的 toast 操作：先做一次过滤到本次路径的快照恢复 dry-run；当计划会连带
  还原无关文件，**或同名文件在动作之后被改写**时，会要求二次确认。没有写入前快照时拒绝
  撤销，切换身份后也拒绝撤销。磁盘上不保存记忆正文的第二份副本。
- **所有尝试都会审计**（包括被拒绝的），写在
  `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/audit.jsonl`（0600，1 MiB 轮转、
  保留两个旧文件）：时间、动作、URI、身份指纹、request id、结果和撤销句柄——不含正文、
  令牌或密钥。

![带版本与 diff 的编辑弹窗](assets/v05-after-edit.png)

**立即提交——以及捕获控制做不到什么。** 「立即提交」请求服务端归档本会话未提交消息并
抽取记忆：同一时间只允许一个，提交前先显示待提交 token / 未归档消息 / 已有提交数，
必须确认，异步执行并可在「活动」tab 跟进。抽取本身不可回滚。面板会显示官方记忆插件
报告的捕获状态（是否捕获、自动提交、阈值），但**暂停/恢复捕获尚未提供**：官方插件没有
对应运行时 API（上游需要有 `runtime.setCaptureEnabled(session, boolean)`）。抽取失败会
显示服务端错误、归档 URI 和可导出的任务，但**没有重试按钮**——这里测试的 OpenViking
版本（0.5.1.1–0.5.3）没有重试接口。

![带任务和指标的活动 tab](assets/v05-after-activity.png)

**活动：任务、指标与最近操作。** 右侧栏第五个 tab 按类型/状态筛选并游标分页列出后台任务；
点开可见执行事件、协作式取消（不会回滚已完成的写入）和安全字段的 JSON 导出。四张互相
独立的指标卡分别覆盖服务端概览、写入队列、记忆统计和本会话统计，各自独立降级；最近审计
操作也列在这里。插件从不探测 `/metrics`（多数服务端默认关闭）。

![身份配置与常驻作用域提示](assets/v05-after-scope.png)

**多服务端、多身份。** 命名配置档（label、endpoint、auth mode、API key、account、user、peer）
存放在插件自己的 `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/profiles.json`（0600），
编辑器就在同一个 **Configure** 表单里。key 是只写的：不会回传给浏览器，也不会写日志。
激活配置档优先于旧的 `endpoint`/`apiKey`/`account`/`user`、环境变量和 `ovcli.conf`；
没有激活配置档时旧字段仍然生效。常驻作用域 chip 显示 endpoint、鉴权模式、account、user、
peer 和身份指纹，并对远程端点给出警告；写入弹窗无论 chip 是否隐藏都会重复完整作用域。
身份不明确时拒绝写入，撤销绑定执行写入的身份，确认令牌未消费时禁止切换身份——界面会阻止
切换；若设置保存与待确认令牌发生竞争，宿主会以 `identity-changed` 失败关闭。`dev`/`trusted`
模式下发送身份头；`api_key` 模式下身份由 key 决定，不发送身份头。ACL 只显示明确的
「未启用」状态，不做管理员枚举。

![写入命令的富确认卡片](assets/v05-after-command-confirm.png)

**输入框里的写入命令。** `/viking forget <uri>`、`tag <uri> …`、`commit` 先准备动作，再在
对话里返回带确认/取消的卡片（删除要输入文件名、标签以 chip 呈现、提交有警告）。没有该卡片
的老客户端会收到两行纯文本兜底，提示 `--confirm <token>`。令牌对应的动作会在**写入之前**
由宿主校验：用标签令牌确认删除会被拒绝，而不是先执行标签写入再报错。`edit` 只打开预览
编辑器（由它的弹窗负责准备与确认）；`undo <handle>` 先跑 dry-run 计划、随后立即应用
（计划包含额外改动时仍需弹窗确认）；`audit` 是纯读取。对话里的删除需要输入文件名，命令
路径则以一次性令牌作为确认。确认令牌一次性、120 秒有效、绑定身份/动作/目标：最多 8 个
待确认；每分钟最多 3 次**写入**（在执行令牌时校验，先准备多个也无法绕过）；准备会真实创建
快照，因此单独限制每分钟 10 次（取消不会退还配额）。同一时间只有一个写入；关闭弹窗会释放
待确认令牌，被拒绝的尝试也会审计。

## 宿主契约与兼容性

这一章是本插件的宿主契约：支持范围、安装方式、进程模型、读写边界、时限、降级路径、
不承担的能力，以及隐私边界。带日期的验证证据在 [`VERIFICATION.md`](VERIFICATION.md)。

### 支持范围

| 组件 | 支持范围 | 实测 / 说明 |
| --- | --- | --- |
| DSH（只读） | `>=0.2.0-rc.2 <1.0.0-0 || >=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`（`engines.dsh`，每条预发布线上界都锁在 1.0 之前） | 按 0.2.2-rc.1 构建与类型检查；在 0.2.0-rc.2、0.2.1-rc.3/rc.5、0.2.2-rc.1 实测 |
| DSH（写入） | **0.2.2-rc.1+** | 需要认证的 `ctx.connection.fetch`；旧版本保留全部只读界面，写入带原因禁用 |
| OpenViking | 实测 0.5.1.1 – 0.5.3 | 0.5.2 未验证，0.5.4 未探测。预览/搜索/技能/Experience 在 0.5.1.1+ 可用（Experience 在 0.5.3 验证）；**规则需要 0.5.3+**；上下文接口为 0.5.3 |
| 官方记忆插件 | `@openviking/dsh-memory-plugin`（可选） | 在维护者机器上验证 0.5.32；它进程内的状态是**被读取**的接口事实，不是上游发布的稳定契约（见“已知缺口”） |
| Node | `^22.19.0 || >=24`（`engines.node`） | CI 使用 Node 22 |
| 操作系统 | Linux CI；macOS 15 手工验证；**Windows 未验证** | 本版本没有 macOS/Windows 的 CI 自动化 |

本版本声称的 OpenViking 实测范围是 **OpenViking 0.5.1.1 – 0.5.3**（0.5.2 未验证，
0.5.4 未探测）。

DSH 范围按预发布版本线分别声明（0.2.0 / 0.2.1 / 0.2.2 各一段，上界都在 1.0 之前）：
npm 风格的 semver 不会让单个 `>=0.2.0-rc.2` 区间接受 `0.2.2-rc.1`，而 DSH 自己的
兼容检查是包含预发布的。`engines.dsh` 与 `peerDependencies` 使用同一字符串，
清单与 peer 检查因此一致，且每一段都有上界。

### 安装 / 升级 / 卸载

**CLI / web profile**（npm 安装的 `dsh`）：

```bash
# 从 npm 装
dsh plugin --profile web add dsh-openviking-enhance

# 或最新 release 的预构建 tarball / 本地打包
dsh plugin --profile web add https://github.com/A2chitect/dsh-openviking-enhance/releases/latest/download/dsh-openviking-enhance.tgz
pnpm pack && dsh plugin --profile web add ./dsh-openviking-enhance-<版本>.tgz

# 卸载
dsh plugin --profile web remove dsh-openviking-enhance
```

**Desktop 应用**：从 Plugins 页安装（**Add plugin** → 包名或 tarball），或用 Desktop
自带的启动器安装。npm 安装的 `dsh` **拒绝**保留的 `desktop` profile——这是官方 DSH 的
行为，不是本插件的限制。

**升级** = 安装新版本后重启应用。*宿主部分*（`lib/index.js`）在启动时加载，改宿主必须重启；
*客户端部分*（`lib/client.js`）在页面加载时取用，只改客户端重载窗口即可。**卸载** = 移除
包后重启；行、路由与组合出的客户端产物都会消失（`pnpm run verify:install` 会验证这一点）。

客户端半部分是**预构建产物**：从源码目录直接安装（没有 `pnpm pack`）等于给壳一个加载不了的东西。

### 进程模型、输入与输出

- **进程内宿主插件 + 浏览器 bundle**：没有守护进程、没有 worker、没有常驻后台定时器
  （只有已挂载面板的轮询）。
- **没有生命周期 hook、没有 MCP proxy、没有工具、没有 URI guard、没有 Skill 下发**
  （这些属于官方记忆插件，见下面的 N/A 矩阵）。唯一的可选命令 `/viking` 通过
  `ctx.commands` 注册。
- **DSH web server 上的路由**：只读 GET，加三个 POST——统一搜索与规则测试（只读查询），
  以及插件自己的新手状态写入（只落一个 0600 本地 JSON 文件，**零** OpenViking 调用）。
  只响应 loopback + 同源请求，JSON body 上限 64 KiB，且从不写入 OpenViking。
- **变更只能走认证的 `ctx.connection.fetch` 传输**（DSH 0.2.2-rc.1+）；刻意不提供
  loopback POST 写入通道。会话认证由该 DSH 传输负责，不由本插件负责；插件自己的 HTTP
  服务端不暴露任何写入路由——对任何插件路由直接发未认证 POST 只会得到只读查询或 404
  （冒烟测试断言所有 `/write/*` 路径都是 404）。
- **从官方插件读取**：按会话的运行时配置/状态、pending queue 目录（只读文件名/时间，
  从不读 payload）、能力 memo，以及服务端产出的提交/归档文件；从不写它们。
- **本插件自己写的东西**：`${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/` 下的
  `profiles.json`、`audit.jsonl` 与 `onboarding.json`，以及用户手动触发的 OpenViking
  策展请求。新手状态 POST 走与只读路由相同的本机/同源 JSON 围栏，而不是鉴权写入通道，
  因为它不是 OpenViking 写入。
- **启动不阻塞、失败被隔离**：激活失败只记日志、该条目不提供任何东西，不会拖垮 profile；
  OpenViking 不在线只影响路由答案，不影响宿主。

### 原生读取路由（v0.7）

全部是 loopback + 同源的只读 GET，从不写入；唯一例外是本地新手状态 POST：

| 路由 | 契约 |
| --- | --- |
| `GET /api/openviking-enhance/overview?fresh=0` | 组合 config + scope + metrics + 插件事实 + Studio 状态 + 新手检查；各部分独立 `available/error`，缓存 5 s |
| `GET /api/openviking-enhance/browse/roots` | 按身份解析的 `viking://` 根（不列目录） |
| `GET /api/openviking-enhance/browse?uri=&offset=&limit=` | 一页 `fs/ls`：50 行、160 字符摘要、标签、服务端游标；404 = 空页 + 提示；非允许/内部作用域直接拒绝 |
| `GET /api/openviking-enhance/browse/subtree?uri=&levels=&nodes=` | 显式有界 `fs/tree`（≤2 层 / ≤100 节点） |
| `GET /api/openviking-enhance/sessions?offset=&limit=` | 分页会话目录（每页 50，按 mtime 倒序），带 DSH/非 DSH 类型 |
| `GET /api/openviking-enhance/recent-commits?limit=&fresh=0` | 有界扇出（≤8 会话、并发 4、10 s 截止、30 s 缓存），带 `partial`/`limitedBy`/`progress` |
| `GET /api/openviking-enhance/studio-status?fresh=0` | 无凭据响应头探测：`frameable` yes/no/unknown + 原因，缓存 60 s |
| `POST /api/openviking-enhance/onboarding/state` | `{action:'dismiss'|'reset'|'complete-step'|'full-check', …}` → 只写 0600 本地 `onboarding.json`，零 OpenViking 调用 |

### 时限与上限

下表的数值都来自 `src/shared/limits.ts`；`test/v06-docs.test.mjs` 会从两份 README 中
解析这个代码块，所以文档契约不会与代码漂移。时间单位毫秒，大小未特别注明时为字节。

<!-- contract:limits -->
| constant | value |
| --- | --- |
| DEFAULT_REQUEST_TIMEOUT_MS | 8000 |
| HEALTH_TIMEOUT_MS | 4000 |
| STATUS_TIMEOUT_MS | 5000 |
| FS_TIMEOUT_MS | 8000 |
| LIST_SEARCH_TIMEOUT_MS | 12000 |
| CONTEXT_SEARCH_TIMEOUT_MS | 20000 |
| RECALL_CONTENT_TIMEOUT_MS | 10000 |
| WRITE_TIMEOUT_MS | 20000 |
| SET_TAGS_TIMEOUT_MS | 10000 |
| SNAPSHOT_TIMEOUT_MS | 30000 |
| DOCTOR_CONTEXT_PROBE_TIMEOUT_MS | 10000 |
| DOCTOR_RULES_PROBE_TIMEOUT_MS | 8000 |
| DOCTOR_FS_PROBE_TIMEOUT_MS | 5000 |
| RULES_CAPABILITY_TTL_MS | 600000 |
| WRITE_TOKEN_TTL_MS | 120000 |
| WRITE_BODY_MAX_BYTES | 65536 |
| WRITE_CONTENT_MAX_CHARS | 65536 |
| RULE_LIST_DEADLINE_MS | 15000 |
| RULE_LIST_CONCURRENCY | 4 |
| PREVIEW_BODY_MAX_LINES | 400 |
| PREVIEW_BODY_MAX_LINES_RESPONSE | 1000 |
| PREVIEW_MAX_CHARS | 20000 |
| AUDIT_MAX_BYTES | 1048576 |
| AUDIT_MAX_LIMIT | 100 |
| AUDIT_KEEP_ROTATIONS | 2 |
| ACTIVITY_TASKS_MAX_LIMIT | 50 |
| BROWSE_PAGE_SIZE | 50 |
| BROWSE_ABSTRACT_MAX_CHARS | 160 |
| BROWSE_SUBTREE_MAX_LEVELS | 2 |
| BROWSE_SUBTREE_MAX_NODES | 100 |
| BROWSE_CACHE_TTL_MS | 15000 |
| BROWSE_CACHE_MAX_DIRECTORIES | 100 |
| SESSIONS_PAGE_SIZE | 50 |
| SESSION_DETAIL_CACHE_TTL_MS | 15000 |
| RECENT_COMMITS_SESSION_CAP | 8 |
| RECENT_COMMITS_CONCURRENCY | 4 |
| RECENT_COMMITS_DEADLINE_MS | 10000 |
| RECENT_COMMITS_CACHE_TTL_MS | 30000 |
| OVERVIEW_CACHE_TTL_MS | 5000 |
| STUDIO_STATUS_TIMEOUT_MS | 4000 |
| STUDIO_STATUS_TTL_MS | 60000 |
| NATIVE_HISTORY_MAX | 20 |
<!-- /contract:limits -->

规则列表的截止时间是**调度**截止：已经发出的请求仍按各自的单请求超时跑完，所以慢服务端最多会让实际耗时再多一个在途请求的时间；每次部分结果都会在 `progress` 里给出实际耗时。

另外固定：每个召回桶/搜索请求最多 25 条，召回解释与单次正文载入各 20 000 字符，
规则列表上限 100 条规则 / 20 个场景，L2 预览一页最多返回 1 000 行。

### 能力探测与降级

| 能力 | 探测 / 闸门 | 可用条件 | 降级方式 |
| --- | --- | --- | --- |
| 只读界面（预览、搜索、技能、会话日志、提交） | 每次请求的 HTTP 结果 | OpenViking 0.5.1.1+ | 明确的「不可用」状态，不堆错误 |
| 上下文接口（召回解释） | 一次 `search/search` + `mode:"context"`（仅 Doctor） | 服务端支持上下文接口 | 退回逐目标检索，并在统计里说明是旧路径 |
| 规则列表 / 规则测试 | 校验用的 `POST rules/search {}`（不产生 embedding/judge 开销） | OpenViking 0.5.3+ | 一行翻译好的「需要 0.5.3+」 |
| Experience | `fs/ls` + `agent-evolution` 接口 | 在 0.5.3 验证 | 空状态或「该服务端不可用」 |
| 快照撤销 | `GET /snapshot/log` 分类 | 路由存在（新账号报「无历史」） | 编辑/删除带原因禁用 |
| 写入 | `enableWrites` **且** 认证传输 **且** 探测到健康身份 | DSH 0.2.2-rc.1+ | 只读并说明原因；所有变更 fail closed |
| Activity 任务/指标 | `GET /tasks` 与逐卡片探测 | 路由存在 | 逐卡片「不可用」；`/metrics` 从不探测 |
| ACL | 不探测 | 从不 | 明确的「未启用」行 |
| Studio | `endpoint + studioPath` 的 iframe | 服务端提供 `/studio/` | 新标签页/浏览器兜底；X-Frame-Options/CSP 拒绝会如实显示 |

### 不适用（由官方记忆插件承担）

| 职责 | 归属 | 本插件 |
| --- | --- | --- |
| 自动召回、捕获、提交 | `@openviking/dsh-memory-plugin` | 解释、诊断、（手动开启后）强制提交；从不替代记忆管道 |
| 生命周期 hook、MCP proxy/工具、URI guard、Skill 下发 | 官方插件 / 服务端 | 不存在；不向模型暴露任何工具 |
| pending queue 写入、重试、恢复 | 官方插件 | 只读诊断（只看文件名/时间） |
| 捕获暂停/恢复、归档重试 | 实测的构建里没有上游 API | 明确不提供，并在展示状态处说明 |

### 数据、隐私与安全边界

- **本地优先**：插件只与配置的 OpenViking 地址通信（默认 loopback），**没有任何遥测**
  或其他外发请求。允许配置远程地址，但作用域 chip 会警告。
- **只读路由仅限 loopback，而 loopback 不是用户边界。** 围栏会检查 socket、`Host`、
  同源请求头和请求形状，但在多用户机器上本机其他进程仍可 `curl` 这些只读数据。变更从不
  走这些路由：它们走框架认证的 `connection.fetch`。
- **原生读取就是经过围栏的普通 GET；Studio 仍是服务端自己的 UI 装在 iframe 里。**
  原生面板不代理也不重绘 Studio：它通过与其他路由相同的本机/同源围栏读取文档化的
  `viking://` 路由。如果服务端拒绝嵌入（`X-Frame-Options`/CSP frame-ancestors），
  宿主侧响应头探测会报告原因并提供新标签页打开；面板绝不从浏览器猜（被阻止的跨域
  frame 对父页面没有任何错误事件）。
- **凭据优先级**：`~/.openviking/ovcli.conf` → `OPENVIKING_*` 环境变量 → 插件自己的
  `profiles.json` 命名配置档。旧版 `apiKey` 配置字段已声明为 `role('secret')`，但保存它
  会把明文 key 写进你的 profile 补丁——只当兜底。`profiles.json` 是命名配置档的
  凭据存储（0600），插件不备份、不随包分发；密钥从不写日志，也不进入
  Doctor/diagnostics。
- **日志里没有对话或记忆正文**：本地审计文件只记录动作/身份/URI/结果，从不记录正文。
  冒烟脚本默认脱敏（`SMOKE_VERBOSE=1` 是仅供本机调试的显式开关）。
- **插件持久化的内容**：`profiles.json`（0600）、`audit.jsonl`（0600，1 MiB 轮转、
  保留 2 份）与 `onboarding.json`（0600，原子写），都在
  `${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/` 下。`onboarding.json` 只含检查
  id/状态时间戳与上次检查计数——绝不含端点、账户、用户、密钥、peer、记忆 URI 或记忆正文。

### 插件会发什么（以及代价）

「只读」**不等于免费**：有些只读动作会让服务端做真实工作。全局动作与代价：

| 动作 | 服务端工作 |
| --- | --- |
| 预览、召回列表、会话日志、技能目录、Experience 列表 | 便宜的 `fs`/`content` 读取 |
| 回忆解释 | 一次上下文接口检索（embedding + 服务端的查询扩展/重写阶段） |
| 探索搜索（默认） | 一次 `search/search` list 调用（embedding），覆盖记忆/资源/技能 |
| 探索搜索——**勾选包含规则** | 额外一次 `rules/search`：场景向量召回；若配置了规则评审模型，还会增加模型调用 |
| 规则测试 **Run** | 同样的 `rules/search` 代价（按钮旁有说明） |
| Activity tab 可见时 | `tasks`/指标轮询；**tab 隐藏时不轮询** |
| 写入、强制提交 | 仅用户触发，一次一个已确认动作 |
| 原生概览（首屏） | 一次组合请求：配置健康 + 能力探测 + 四项指标读取 + 缓存的 Studio 响应头探测；缓存 5 s |
| 浏览展开 | 一页 `fs/ls`：50 条、160 字符摘要、标签；缓存 15 s（LRU 100），收起/切视图时取消 |
| 浏览「展开子树」 | 一次 `fs/tree`，最多 2 层/100 节点——仅显式按钮 |
| 会话列表 | 一页 50 个会话目录的 `fs/ls`；详情只在选中时复用既有的有界会话日志（不轮询） |
| 提交视图 | 最多 8 个会话 × 3–4 次廉价读取，并发 4、10 s 截止、缓存 30 s，从不轮询 |
| 统计视图 | 与「活动」tab 相同的 REST 指标读取；显式刷新 |
| 新手「运行完整检查」 | 既有 Doctor 探测，仅用户触发 |

打开规则列表**不会**花一次规则检索：能力闸门是校验用的 `POST rules/search {}`
（服务端在 body 校验阶段就拒绝，先于任何召回/judge 工作），列表本身是有界文件读取
（15 s 总截止、并发 4、100 条规则/20 个场景上限，部分结果保留并显示
「显示 N 条（上限 M）」）。

### 已知缺口

- 官方插件进程内的配置/状态对象**不是上游发布的稳定契约**；它的大版本升级可能改变形状。
  本插件会降级为「unknown/skipped」，而不是猜测。
- 兼容性只对上面列出的 DSH/OpenViking 版本负责；0.5.4 未探测，Windows 未验证。
- 写入需要 DSH 0.2.2-rc.1+；更老的版本按设计只读。
- 仓库级验证是 CI（Linux）+ macOS 手工；Desktop 载体是手工安装验证，不在 CI 里。
- **旧 DSH 的深链回退到预览 tab。** 主面板切换需要 `ctx.layout.selectPanel`
  （0.2.2-rc.1 已验证），缺少它的世代保留全部只读入口，但无法以程序方式打开原生面板。
- **没有全局提交历史。** 归档按会话存放、任务记录会被清理，所以「提交」只是最新 8 个
  会话的有界列表；更早的记录在会话详情中查看。
- **不读消息正文。** 会话的 `messages.jsonl` 从不读取：会话视图只展示计数/标记/diff，
  Studio 仍是正文阅读器。
- **导航不持久化、没有浏览器后退。** 面板内历史按设计只在内存中；DSH 没有主面板选择的
  URL 路由。
- 本插件由社区维护，**不是 OpenViking 官方项目**。

## 配置

默认值适配标准本地环境，**开箱无需配置**。要改的话，打开侧边栏的 **Plugins** 页，找到本插件，
点它那一行的 **Configure**：表单包含下表的全部字段，地址旁边有 **检测** 按钮可以在保存前先试连，
每个字段还有 **默认** 按钮——它是清除覆盖、恢复继承，而不是写入一个空值。

同样的设置也仍然可以手写在 profile 的 patch 文件
（`~/.dsh/profiles/<profile>/cordis.patch.yml`；CLI 用 `web`，Desktop 应用用 `desktop`）里 `openviking-enhance` 这一行下面：

```yaml
- id: openviking-enhance
  name: 'dsh-openviking-enhance'
  config:
    endpoint: http://127.0.0.1:1933
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | 读 `~/.openviking/ovcli.conf`，否则 `http://127.0.0.1:1933` | OpenViking 地址 |
| `apiKey` | 读 `ovcli.conf` | 仅当服务端要求鉴权时的最后兜底：保存该字段会把明文 key 写进 profile 补丁。优先用 `ovcli.conf`、`OPENVIKING_*` 环境变量或命名配置档 |
| `account` / `user` | `default` / `default` | 读取记忆所用的身份 |
| `studioPath` | `/studio/` | Studio 在该地址下的路径 |
| `cacheTtlMs` | `2500` | 状态结果的缓存时长 |
| `recallCacheTtlMs` | `15000` | 单次检索结果的缓存时长 |
| `showSidebarEntry` | `true` | 界面开关：左侧边栏里的 OpenViking 入口 |
| `showCommitStatus` | `true` | 界面开关：输入框下方的提交状态胶囊 |
| `showRecallPanel` | `true` | 界面开关：右侧边栏的「记忆召回」tab |
| `showRecallExplain` | `true` | 界面开关：每条回复下方的「记忆来源」入口 |
| `showHealthPanel` | `true` | 界面开关：右侧边栏的「记忆健康」tab 与插件详情页健康摘要 |
| `showPreview` | `true` | 界面开关：右侧边栏的 `viking://` 预览 tab |
| `showExplore` | `true` | 界面开关：探索 tab（搜索、规则、技能、Experience） |
| `enableCommands` | `true` | 宿主开关：`/viking` 命令（读取与写入动词） |
| `enableWrites` | `false` | 手动开启：策展（编辑/删除/标签）、强制提交与写入命令 |
| `enableActivity` | `true` | 界面开关：「活动」tab（任务、指标、最近操作） |
| `showScopeBanner` | `true` | 界面开关：常驻作用域 chip；写入弹窗无论是否隐藏都会重复完整作用域 |
| `showNativeViews` | `true` | 界面开关：原生阅读面板（概览/浏览/会话/提交/统计）。关闭 = v0.6 的 Studio iframe 页面 |
| `showOnboarding` | `true` | 界面开关：首次运行检查（概览卡片 + 插件页 Setup 卡片）；关闭只隐藏卡片，不清除本地状态 |
| `activeProfile` | `''` | 要使用的命名配置档；留空 = 使用下面的旧连接字段 |

![插件配置表单里的界面开关](assets/v04-after-settings.png)

这些**界面开关**分别控制各个入口，**保存后立即生效**——界面会当场挂载或卸载对应入口，
不需要重载窗口或重启应用。**Configure** 表单本身永远不会被隐藏，所以关掉的入口随时可以
在这里重新打开。隐藏左侧入口会一并卸载 Studio 页面（重新打开后重新加载）；隐藏召回 tab
后不再提供该页，已打开的召回页会在回到对话时自动收起（若它在后台分屏里、不是激活页，
则需要手动关闭——框架没有提供枚举标签页的接口）。「活动」tab 同理。`showNativeViews`
只切换主面板的身体（原生面板 ↔ v0.6 Studio 页面），不重挂面板；`showOnboarding`
同时移除两张检查卡片。`enableCommands`、
`enableWrites` 和 `activeProfile` 由宿主半部分读取，所以它们在下次插件应用（会重载插件的
保存或重启）时生效，并在 Loader 广播 volatile 配置更新时立即生效；不支持该事件的旧 Loader
只能等到下次应用。它们不是靠挂载/卸载生效的。

**配置档与密钥。** 同一表单里的配置档编辑器写
`${DSH_HOME:-~/.dsh}/state/dsh-openviking-enhance/profiles.json`（0600），其中的 API key
在界面层面是只写的。没有激活配置档时上表的旧字段仍然生效。本地审计文件也在同一目录。

## 常见问题

**侧边栏没有 OpenViking 行，或输入框下方没有胶囊。**
先看插件自己的开关（Plugins → 本插件 → **Configure** → 「界面」）：某个入口可能被关掉了，
而且这些开关互相独立。否则是客户端部分没加载：重载窗口（⌘R）即可，仍然没有就重启应用。

**我把 OpenViking 行 / 胶囊 / 召回 tab / 记忆来源 / 记忆健康 / 预览 / 探索 tab 关掉了，想找回来。**
打开 **Plugins** → *dsh-openviking-enhance* → 它那一行的 **Configure**，把开关打开再保存。
即使所有入口都隐藏，这个配置表单也始终可用。

**看不见策展按钮，或提示写入已关闭。**
`enableWrites` 默认关闭，先在 **Configure** 里打开。写入还需要 DSH 0.2.2-rc.1+
（认证 fetch 传输）和可解析的身份：没有激活配置档时由旧字段/`ovcli.conf` 决定，
服务端没有报告鉴权模式时插件会以「身份不明确」拒绝。上述情况下读取都仍然可用。

**撤销不可用，或撤销计划里出现了我没改过的文件。**
撤销只在当前插件会话的写入窗口内、且由执行写入的同一身份可用。快照恢复以目录为范围，
所以 dry-run 计划可能包含同级路径，此时弹窗会要求二次确认后才应用。如果文件在动作之后
被改写，弹窗同样会要求二次确认（不会静默回滚同名文件）。

**立即提交没反应 / 强制提交失败。**
每个配置档同时只允许一个提交在途，插件不会自动重试。结果为「skipped」表示没有未提交消息。
抽取失败会显示服务端错误与归档；插件无法重试，因为测试过的服务端版本没有重试接口。

**`/viking` 命令不生效。**
该命令由宿主半部分注册，可以在插件的 **Configure** 表单里用 `enableCommands` 关掉。
保存后的改动在下次插件应用（会重载插件的保存或重启）时生效，并在 Loader 广播 volatile
配置更新时立即生效；不支持该事件的旧 Loader 只能等到下次应用。如果表单里它已经是开着的，
重启一次 DSH——宿主半部分在启动时加载。

**「规则」区块提示服务端没有规则列表，或规则检索失败。**
规则是 OpenViking **0.5.3+** 的能力；0.5.1.1/0.5.2 会明确提示不可用。在 0.5.3 上规则库为空
是正常的（还没有 compile 过），试跑器仍然可用。

**预览页提示「这一层还没有生成」。**
OpenViking 的 L0/L1 sidecar 是惰性生成的（按目录、在 compile 时），所以全新的或从未 compile
过的目录出现占位文本是正常的。L2（存储的文件正文）不走 sidecar 机制。

**面板提示连不上 OpenViking。**
先起服务并直接验证：`curl http://127.0.0.1:1933/health`。面板会显示它尝试的地址，
`endpoint` 不是默认值时这个信息很有用。

**胶囊显示「抽取失败」。**
归档成功了，但 OpenViking 没能把它变成记忆——那部分记忆不在你的库里。点开胶囊看
服务端返回的原因，通常是 `~/.openviking/ov.conf` 里抽取所用模型的问题。

**回复里没有出现某条记忆，或召回为空。**
打开「记忆健康」→ **Doctor**：它会区分服务不可达、记忆插件未挂载或被禁用、召回/捕获
被关闭、提交阈值未知、旧服务端没有上下文接口、以及本地写入队列。然后到「记忆召回」
tab 用同一句话再检索一次，看服务端自己的排序。

**胶囊显示 token 数而不是提交次数。**
说明没装 `@openviking/dsh-memory-plugin`，插件无从得知提交阈值。提交本身照常发生，
只是少了进度分母。

**时间线只有 3 条。**
这是默认值，点「显示全部」展开。

**右侧边栏里没有召回 / 记忆健康 tab。**
该 tab 从右侧边栏自己的 `+` 引导页进入，且需要重载窗口后才会出现（客户端部分是页面加载时
取用的文件）。若 DSH 低于 0.2.0-rc.2，它没有右侧边栏可供挂载：这些行会被跳过，
Studio 面板和胶囊照常工作。

**改了代码但界面没变化。**
两半的加载方式不同：客户端部分重载窗口即可，宿主部分必须重启应用。

## 说明

- 本插件自身的界面文字**跟随应用语言**：内置中英两套文案，读取 DSH 设置的语言，
  切换应用语言即切换本插件的文案；其他语言退回英文。
- OpenViking 会定期清理 commit 任务记录，所以失败列表只覆盖最近的提交；归档文件
  本身是永久的。
- 插件的内部**读取**接口只接受本机 loopback 请求；防护会校验套接字、`Host` 头与同源头，
  但故意允许不带 `Origin` 的本机 `curl`。仅有的 POST 路由是只读的搜索与规则试跑查询，
  并且要求 JSON 请求体不超过 64 KiB。**写入从不使用这些路由**：写入走框架认证的
  `connection.fetch` 服务。
- **默认只读，写入需要手动开启。** v0.4 与 v0.5 的只读部分不会改动 OpenViking 数据。
  打开 `enableWrites` 后，唯一的写入路径就是上文所述的策展、强制提交与写入命令；每一次
  都有确认、写入后校验、快照撤销（抽取与强制提交除外，服务端无法回滚）和本地审计。
  离开本机的只有发给 OpenViking 的请求本身——若激活配置档指向远程端点，请求就发给那台
  服务器。
- **写入需要 DSH 0.2.2-rc.1+。** 写入走框架认证的 `ctx.connection.fetch` 服务；插件从不
  暴露 loopback POST 写入路由（冒烟脚本断言这些变更路径在本机服务上返回 404）。谁能调用
  这些路由由 DSH 连接传输自己的会话认证决定——插件负责确认令牌、身份绑定与审计，但不负责
  网络层认证。旧 DSH 版本保留所有只读界面，并说明写入为什么不可用。
- **配置档的「检测」按钮不是通用 URL 探测器。** 它不发送凭据，只读取 `/health`；拒绝
  非 `http(s)`、link-local/云元数据（`169.254.0.0/16`、常见元数据域名、`fd00:ec2::254`、
  IPv6 link-local `fe80::/10`、IPv4-mapped IPv6 形式）、未指定、广播与多播地址。loopback 与局域网地址是**故意允许**的（私有 OpenViking 服务是
  受支持的部署形态）；如果远程配置档的检测被拒绝，保存后看作用域/健康状态即可。
- **捕获暂停/恢复与归档重试尚未提供。** 官方记忆插件没有运行时暂停 API，测试过的
  OpenViking 版本也没有归档重试接口；插件如实说明，而不是假装支持。
- 测试范围：OpenViking 0.5.1.1–0.5.3（0.5.2 未验证、0.5.4 未探测）；DSH 读取 0.2.0-rc.2+，
  写入 0.2.2-rc.1。桌面端的写入一致性只在 web profile 验证过，桌面端写入在实测前视为未验证。
- 撤销来自快照，不是正文备份：快照被清理或插件会话结束后就无法再撤销。强制提交没有撤销，
  它触发的抽取无法回滚。
- `/viking` 的输出是简短的英文纯文本：宿主半部分拿不到应用语言，且 GUI 的命令结果
  不渲染 Markdown。
- 规则是 OpenViking 0.5.3+ 的能力；0.5.1.1/0.5.2 上「规则」区块会说明不可用。
  统一搜索只走语义检索，因为当前后端拒绝关键词模式。
- `assets/` 里的截图来自 `scripts/screenshot-fixture.mjs` 的替身服务（v0.4 起覆盖新增读取
  接口，v0.5 起用内存状态模拟写入路径）与 mock 模型，浅色主题、1440×900 视口；
  `v05-before-*` 是截图时尚未发布的 v0.4 分支构建，同一 DSH 0.2.2 web profile。截图不含
  真实记忆数据或账号。

## 开发

```bash
pnpm install
pnpm run build      # lib/index.js（宿主）+ lib/client.js（浏览器）
pnpm test           # 类型检查、构建、发布要求核对、单测、冒烟
pnpm run watch      # 改动后自动重建
```

冒烟脚本不需要开界面就能打印提交时间线；OpenViking 没在跑时它会跳过实时数据部分
（`SMOKE_REQUIRE_SERVER=1` 可让跳过变成失败）。独立召回契约所依据的文档摘录记录在
[CONTRACT.md](CONTRACT.md)，独立性声明的行为清单在 [PROVENANCE.md](PROVENANCE.md)，
各部分的实现细节见源码注释。

版本号写在 `package.json`，每次发布在 git 里打 `vX.Y.Z` 标签；`0.x` 期间内部实现
仍可能调整。每个版本包含什么见 [CHANGELOG.md](CHANGELOG.md)，发版步骤和必须在界面里
过一遍的验收清单见 [RELEASING.md](RELEASING.md)。
