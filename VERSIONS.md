# 版本功能总览（v0.3 → v1.0）

`dsh-openviking-enhance` 是 DeepSeek Harness（DSH）的本地 [OpenViking](https://docs.openviking.ai) 记忆插件：
把「记忆为什么没生效 / 一条记忆长什么样 / 能不能安全地改」都搬进 DSH 界面，v1.0 起核心阅读与受控操作不再需要
OpenViking 自带 Studio，Studio 只作为可选的兜底/高级界面保留。

本文件按版本汇总「每个版本分别更新了什么功能」，面向评审与非开发读者；逐条细节见
[CHANGELOG.md](CHANGELOG.md)，安装与兼容说明见 [README.md](README.md) / [README.zh.md](README.zh.md)，
发布与回滚见 [RELEASING.md](RELEASING.md)，最终验收记录见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 总览

| 版本 | 主题 | PR | 一句话 |
| --- | --- | --- | --- |
| v0.3.0 | Explain（已上线基线） | #1 | 召回解释、提交差异、会话日志、Doctor 诊断 |
| v0.4.0 | Act I：原生阅读 | #2 | `viking://` 预览、只读 `/viking` 命令、Explore 搜索/规则/技能/Experience |
| v0.5.0 | Collaborate：安全写作 | #3 | 可选策展写入（准备→确认→审计→可撤销）、强制提交、Activity、身份配置档 |
| v0.6.0 | Trust & verify：可验证 | #4 | 独立召回契约 + 独立性门禁、干净安装验证入 CI、兼容矩阵、隐私加固 |
| v0.7.0 | Native I：原生阅读面板 | #5 | Overview/Browse/Sessions/Commits/Stats 多视图 + Studio 兜底，不再需要 iframe 阅读 |
| v0.8.0 | Operate：受控操作 | #6 | 快照创建/恢复+撤销、编译触发/监控、OVPack 仅导出、任务中心与证据导出、可观测性 |
| v0.9.0 | Native II：多作用域 | #7 | 多服务器/多身份切换、作用域隔离与切换保护、只读 ACL/共享视图 |
| v1.0.0 | Native Complete：完成 | #8 | 无障碍、双语/预算/降级统一、最终兼容矩阵与许可证/API 稳定性决策、验收记录 |

## v0.4 Act I：原生阅读（PR #2）

- **`viking://` 预览**：在 DSH 里直接打开任意记忆/资源/技能 URI，分页查看 L0 摘要、L1 概览、L2 全文；右侧栏新增 Preview 标签页。
- **只读 `/viking` 命令**：在会话输入框用命令查看记忆、健康状态与诊断，无需离开对话。
- **Explore 标签页**：一次查询覆盖记忆/资源/技能三个来源；只读规则列表与规则试跑器（解释为什么命中/不命中）；Experience 记录浏览；技能列表。所有读取走回环 + 同源栅栏的只读 GET，不写任何数据。
- 读取路径全部鉴权无关：不刷新、不轮询、失败时降级说明。

## v0.5 Collaborate：可选的安全写作（PR #3）

- **策展写入（默认关闭，`enableWrites` 打开）**：编辑/打标签/删除记忆，一律走「准备 → 人工确认 → 执行 → 校验 → 审计」，单次使用、限时、与身份绑定的确认令牌；执行后可用快照撤销（undo），撤销同样受确认与身份绑定保护。
- **强制提交**：手动触发一次记忆提取（force commit），完成后回到 `v0.3` 已有的差异浏览器查看结果。
- **Activity 活动页**：全局任务/操作历史，含状态、耗时、失败原因与审计关联。
- **身份配置档**：命名配置档保存端点与身份（`profiles.json`，0600），支持 `dev/trusted/api_key` 等认证方式；作用域横幅显示当前身份。
- **写入命令**：会话内 `/viking remember|update|delete` 等命令与弹窗共享同一套确认/审计/撤销协议。
- 本地审计 `audit.jsonl`（0600、轮转）记录动作/身份/URI/结果，绝不记录正文或密钥。

## v0.6 Trust & verify：可验证的信任（PR #4）

- **独立召回契约**：把「为什么召回这些」所依赖的配额、请求体、超时/阶段预算写成本仓库可审计的契约（`CONTRACT.md`），实现为独立代码，并有 `scripts/check-independence.mjs` 在 `pnpm test`/CI 中防止拷贝上游 AGPL 代码与措辞。
- **干净安装验证入 CI**：`scripts/verify-install.mjs` 用 tarball 在干净 DSH profile 里安装/卸载/重装，27 步（含 tarball 版本 = 已安装版本、Host 头栅栏、离线路径），CI 固定 DSH 版本执行。
- **宿主契约与兼容矩阵**：README 记录宿主动作、权限、超时/限值、能力门控与不适用项；`engines.dsh`/peer 区间语义化并由测试断言。
- **隐私与身份加固**：冒烟输出默认脱敏、`apiKey` 声明为 `secret`、版本 UA 只含版本事实、Doctor 展示构建信息与实际追踪、配置源健康（只报状态不报值）。
- 所有 v0.4/v0.5 行为保持；新增测试与文档 parity 检查。

## v0.7 Native I：原生阅读面板（PR #5）

- **原生多视图面板**（同一侧边栏入口）：**Overview**（一次组合请求：配置、身份、健康/版本、记忆总量、能力、Studio 可嵌入性、入门清单）、**Browse**（按身份解析根目录的懒加载 `viking://` 树 + 只读预览窗格）、**Sessions**（会话目录分页 + 复用会话日志/归档差异的详情，不读 transcript）、**Commits**（有界最近提交浏览，明确标注「只扫描最新 N 个会话」的部分结果）、**Stats**（与 Activity 共用的指标卡片）、以及 **Studio** 显式兜底视图。
- **不再需要 iframe 阅读**：核心阅读任务全部原生；Studio 保持原样作为高级/兜底界面（含宿主侧 frameability 探测与「在新标签页打开」）。
- **首次运行入门清单**：Overview 卡片 + 插件页 Setup 卡；检查项只读，本地状态 0600，绝不出网。
- **深链**：显式「在面板中打开」动作 + 旧 DSH 回退到 Preview 标签页；普通 `viking://` 点击不抢占主面板。
- 新增 `showNativeViews` / `showOnboarding` 开关（默认开）。

## v0.8 Operate：受控操作（PR #6）

- **Operate 操作组**（默认关闭，`enableOps` 打开；阅读始终可用）：
  - **Snapshots**：快照日志/详情/文件内容/单文件差异（0.5.3+ 还含 diff-paths/versions/ignore）；**创建快照**（追加式，不可撤销）；**目录恢复**：dry-run 计划、逐字确认、额外变更二次确认、重建索引任务、部分写回如实报告，撤销 = 向恢复前父状态的前向恢复；0.5.3+ 编译产物**文件版本恢复**（CAS + 可撤销）。
  - **Compile**：能力/配置/操作/输出/提交读取；**确认后触发编译**（配置目标或显式 to/from/skill/instruction，排除 `skill:"memory"` 与任意 args），宿主生成幂等键、超时用提交检查恢复、只轮询可见任务、协作式取消、只能「作为新编译重跑」——**没有 Retry 按钮**（服务端无重试 API）。
  - **Packs**：OVPack **仅导出**（64 MiB 上限、0600 临时文件、一次性令牌下载、只记元数据审计；`include_vectors` 默认关）；备份/导入/恢复明确延期并说明原因。
  - **Tasks**：全局任务列表/事件/取消 + `GET /task/evidence` 证据附件（≤512 KiB，无正文/令牌）。
  - **Observability**：Stats 内 Metrics/Observability 分段，按需组合观察者与 console 数据，永不探测 `/metrics`。
- 与 v0.5 写入共享一个「单写入闸门」和确认存储；所有操作路由只在已认证的 `connection.fetch` 传输上注册，失败一律命名原因（`ops-disabled`/`compile-not-configured`/…）。

## v0.9 Native II：多作用域（PR #7）

- **作用域模型**：作用域 = 当前服务器配置档 + 可选的应用内身份覆写；身份指纹作键（不含密钥），0600 `scope-state.json` 持久化活动档与 account/user/peer 读取覆写，启动优先级 Config → scope-state → profiles 头 → 旧连接。
- **身份切换**：`dev`/`trusted` 可切换 account/user 头（trusted 需成对；插件从不设置 role）；`api_key` 由密钥绑定，相关字段禁用并给出原因；OIDC/LDAP 与不可达服务器按规则禁用。**peer 只是阅读视角**（会话捕获/提交仍走官方插件的 actor peer），作用域块始终显示实际生效 peer。
- **切换器与作用域横幅**：工具栏 + Overview 作用域菜单（按服务器分组：端点/认证/探测到的健康/版本/延迟/能力/警告、活动行、身份区、测试连接、管理配置档）；每个原生视图与右侧栏标签页都持续显示作用域横幅；新增 `showScopeSwitcher` 开关。
- **切换保护**：存在待确认/执行中的写入或操作时拒绝切换；切换会中止/丢弃在途读取、面板回 Overview、关闭插件侧栏页面；旧身份令牌/撤销保留但以 `identity-changed` 拒绝；审计记录 from/to。
- **隔离**：每个请求带作用域指纹头，宿主对不匹配返回 `409 scope-changed` 并给响应打标；组合缓存/能力矩阵/ACL 缓存按作用域；无联邦搜索，结果 URI 按当前可读根校验；本地 0600 `session-scopes.json` 最佳努力记录会话上次所在作用域并提示不匹配+禁用该会话写入；官方插件连接不一致仅告警（永不读取/改写其密钥）；**零 `/admin` 调用**（有测试）。
- **只读 ACL/共享视图**：仅对 `viking://resources/**` 的访问标签页，四种显式状态（可用 / 需要 manage-权限歧义 / 仅 resources / 不支持），显示直接/继承/生效权限；共享以可见性分类呈现，并明确「被测构建没有共享/邀请 API」；不做任何 ACL 修改。

## v1.0 Native Complete：完成版（PR #8）

- **无障碍（插件控件对齐 WCAG 2.2 AA）**：Browse 成为真正的 ARIA 树（roving tabindex、上下/Home/End/展开/选择，aria-level/selected/expanded/busy）；所有标签页 tablist/tab/tabpanel + `aria-labelledby` + 方向键；对话框焦点陷阱与恢复、错误 `role=alert`；toast/状态显式 live region；作用域菜单 menu/menuitem + Esc 焦点归还；`:focus-visible`、`prefers-reduced-motion`、200% 缩放、明暗主题 AA 回退色。DOM/组件测试覆盖键盘/ARIA 行为，渲染层对比度/读屏/缩放列为人工清单。
- **双语一致性**：渲染级 EN+ZH 审计（不允许原始 key/硬编码英文）、日期/数字 Intl 本地化、文案补齐；`/viking` 命令输出保持英文（已声明）。
- **请求与性能预算测试化**：组合 `/overview` 单请求（single-flight + TTL + 局部降级）；轮询统一走可见性调度器（隐藏页面不创建定时器、无重叠、退避），带假时钟测试；有界扇出/缓存断言。
- **统一降级/错误文案**：所有 55 个宿主错误码与信封错误码都有 EN+ZH 文案（源码扫描测试），并给出失败矩阵与恢复动作。
- **最终文档与决策**：README 增「原生完整性」章节（F1–F14 清单、Studio/CLI 仅剩项及原因、12 步 Studio-off 操作走查、最终兼容矩阵含诚实 U/D 标注）；新增 [DECISIONS.md](DECISIONS.md)（MIT + 独立契约实现、API 稳定性 = 实测范围+运行时探测、post-1.0 semver、发布/升级/回滚规则、证据诚实原则）；新增 [ACCEPTANCE.md](ACCEPTANCE.md)（判定分类、路线图目标/退出标准映射、12 项日常检查清单[频率未测量]、5 位真实用户研究协议[外部未验证]、人工检查清单与签署块）；RELEASING 增加 1.0.0 主/备发布路径与不回滚标签策略。

## 各版本验证与证据

- **自动化**：每个 PR 都通过 `pnpm test`（typecheck → build → 包契约 → 独立性门禁 → 单元/路由/渲染测试 → client/host smoke）与 CI 的「干净 profile 安装验证」（27 步）。测试数量随版本累积：v0.6 347、v0.7 406、v0.8 457、v0.9 528、v1.0 587。
- **视觉证据**：所有改 UI 的 PR 都带「修改前 / 修改后」截图对，标注基线版本、变更版本、tarball/commit 与冻结 fixture；每个半场 59/59 无回归检查、0 个非预期错误；v0.9 的 ACL 标签页截图是唯一声明的证据缺口（路由/状态有测试）。
- **人工/外部项**：真实浏览器读屏与对比度、用户研究、Windows/desktop 写入、OpenViking 0.5.2/0.5.4、非 dev 认证实测等在 ACCEPTANCE.md 中如实标为未验证（U）/仅设计验证（D），没有伪造结论。

## 合并与发布顺序

PR 是堆叠的，需按顺序合并（合并提交，勿 squash、勿提前改基）：

`#2 → 0.4.0 → #3 → 0.5.0 → #4 → 0.6.0 → #5 → 0.7.0 → #6 → 0.8.0 → #7 → 0.9.0 → #8 → 1.0.0`

若整条堆叠在任何发布前一起合并，则文档化的回退方案是发布一个 1.0.0，把 v0.4–v1.0 的全部 `Unreleased` 内容并入同一段发布说明。
每个 PR 由人评审并合并；npm 发布是人的 2FA 动作；1.0.0 打标签前需完成 ACCEPTANCE.md 的人工签署。

## 已知限制（v1.0 时点）

- 受上游 API 限制而**不做**：捕获暂停/恢复、归档重试（无服务端 API）、共享/邀请（无 API）、OVPack 备份/导入/恢复（后续版本单独安全设计）、transcript 阅读器（隐私/同意与无 API，非目标）、管理/账户操作。
- Studio 仍保留为可选高级/兜底界面（例如二进制下载之外的服务器自有 UI）；它不是核心流程的必需项。
- 多服务器/联邦搜索、图表/趋势、移动端适配不在 1.0 范围。
