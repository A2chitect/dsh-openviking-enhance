# dsh-openviking-enhance

[English](README.md) | 中文

**v0.1.0** · [更新记录](CHANGELOG.md)

把本地 [OpenViking](https://docs.openviking.ai) 记忆服务接进 DeepSeek Harness
（DSH）的 Web 界面：左侧边栏多一个 OpenViking Studio 面板，输入框下方多一个
commit 状态胶囊，随时能看到每次提交对本会话记忆做了什么。

不需要给 DSH 或 OpenViking 插件打补丁——它就是一个普通的 DSH bundle。

## 功能

**在 DSH 里用 OpenViking Studio。** 左侧边栏最后一行点开，主区域直接加载
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
| `OV · 抽取失败` | 归档了，但记忆抽取失败 |
| `OV · 不可用` | 连不上本地 OpenViking 服务 |

点开胶囊可以看到：

- **时间线**：最近 3 次提交分别发生在什么时候、各新增/更新/删除了多少条记忆
  （其余一次点击展开）；
- 点某一次提交，列出它**具体改了哪些记忆**，含 `viking://` 路径；
- **抽取失败**的时间、耗时，以及服务端给出的原因。

面板和胶囊都只读——本插件不会向 OpenViking 提交、写入或删除任何东西。

**这个会话检索到了什么。** 右侧边栏多一个「记忆召回」tab：显示当前会话会被
OpenViking 拉进上下文的记忆——检索用的那句话（默认是本会话最近一次提问，也可以自己输入）、
三个来源（记忆 / 资源 / 技能）里每条命中的分数（按高低从红到橙到绿分级）、文件名、
类型（`entity`、`event` 等）与摘要——完整 `viking://` 路径悬停可见，点开任意一条可看全文——
以及服务端给出的检索计划。从右侧边栏的 `+` 引导页打开，和该栏本身一样是按会话的。

![嵌在 DSH 界面里的 OpenViking Studio 面板](assets/studio-panel.png)

Studio 面板、打开它的侧边栏行，以及输入框下方的提交状态胶囊。

## 前置条件

| | |
| --- | --- |
| DSH | 0.2.0-rc.2 或更新（desktop / web profile 均可） |
| OpenViking | 需要一个本地服务，实测 0.4.22。Studio 由同一端口的 `/studio/` 提供 |
| 记忆插件 | 建议装 `@openviking/dsh-memory-plugin`——会话提交由它完成。不装也能用，只是看不到提交阈值进度 |

## 安装

从 Plugins 页安装（Add plugin → 填包名或 tarball），或：

```bash
# 已发布的版本
dsh plugin --profile desktop add dsh-openviking-enhance
```

直接用 Git 地址安装会被 pnpm 拒绝（这个包声明了构建脚本，pnpm 在得到允许前一律不放行），
所以源码目录要打成 tarball 再装——客户端半部分是**预构建产物**，源码安装等于装了个没东西可加载的壳：

```bash
pnpm pack && dsh plugin --profile desktop add ./dsh-openviking-enhance-<版本>.tgz
```

安装后**重启一次 DSH 应用**（宿主部分在启动时加载）。卸载：

```bash
dsh plugin --profile desktop remove dsh-openviking-enhance
```

## 配置

默认值适配标准本地环境，**开箱无需配置**。要改的话，打开侧边栏的 **Plugins** 页，找到本插件，
点它那一行的 **Configure**：表单包含下表的全部字段，地址旁边有 **检测** 按钮可以在保存前先试连，
每个字段还有 **默认** 按钮——它是清除覆盖、恢复继承，而不是写入一个空值。

同样的设置也仍然可以手写在 profile 的 patch 文件
（`~/.dsh/profiles/desktop/cordis.patch.yml`）里 `openviking-enhance` 这一行下面：

```yaml
- id: openviking-enhance
  name: 'dsh-openviking-enhance'
  config:
    endpoint: http://127.0.0.1:1933
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | 读 `~/.openviking/ovcli.conf`，否则 `http://127.0.0.1:1933` | OpenViking 地址 |
| `apiKey` | 读 `ovcli.conf` | 仅在服务端开启鉴权时需要 |
| `account` / `user` | `default` / `default` | 读取记忆所用的身份 |
| `studioPath` | `/studio/` | Studio 在该地址下的路径 |
| `cacheTtlMs` | `2500` | 状态结果的缓存时长 |

## 常见问题

**侧边栏没有 OpenViking 行，或输入框下方没有胶囊。**
客户端部分是页面加载时取用的资源文件，重载窗口（⌘R）即可。仍然没有就重启应用。

**面板提示连不上 OpenViking。**
先起服务并直接验证：`curl http://127.0.0.1:1933/health`。面板会显示它尝试的地址，
`endpoint` 不是默认值时这个信息很有用。

**胶囊显示「抽取失败」。**
归档成功了，但 OpenViking 没能把它变成记忆——那部分记忆不在你的库里。点开胶囊看
服务端返回的原因，通常是 `~/.openviking/ov.conf` 里抽取所用模型的问题。

**胶囊显示 token 数而不是提交次数。**
说明没装 `@openviking/dsh-memory-plugin`，插件无从得知提交阈值。提交本身照常发生，
只是少了进度分母。

**时间线只有 3 条。**
这是默认值，点「显示全部」展开。

**右侧边栏里没有召回 tab。**
该 tab 从右侧边栏自己的 `+` 引导页进入，且需要重载窗口后才会出现（客户端部分是页面加载时
取用的文件）。若 DSH 低于 0.2.0-rc.2，它没有右侧边栏可供挂载：这一行会被跳过，
Studio 面板和胶囊照常工作。

**改了代码但界面没变化。**
两半的加载方式不同：客户端部分重载窗口即可，宿主部分必须重启应用。

## 说明

- 本插件自身的界面文字**跟随应用语言**：内置中英两套文案，读取 DSH 设置的语言，
  切换应用语言即切换本插件的文案；其他语言退回英文。
- OpenViking 会定期清理 commit 任务记录，所以失败列表只覆盖最近的提交；归档文件
  本身是永久的。
- 插件的内部接口只接受本机 loopback 且来自 DSH 窗口自身来源的请求。

## 开发

```bash
pnpm install
pnpm run build      # lib/index.js（宿主）+ lib/client.js（浏览器）
pnpm test           # 类型检查、构建、发布要求核对、单测、冒烟
pnpm run watch      # 改动后自动重建
```

冒烟脚本不需要开界面就能打印提交时间线；OpenViking 没在跑时它会跳过实时数据部分
（`SMOKE_REQUIRE_SERVER=1` 可让跳过变成失败）。各部分的实现细节见源码注释。

版本号写在 `package.json`，每次发布在 git 里打 `vX.Y.Z` 标签；`0.x` 期间内部实现
仍可能调整。每个版本包含什么见 [CHANGELOG.md](CHANGELOG.md)，发版步骤和必须在界面里
过一遍的验收清单见 [RELEASING.md](RELEASING.md)。
