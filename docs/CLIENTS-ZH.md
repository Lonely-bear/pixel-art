# 把 AI 客户端接到 dotloom-mcp

<p align="center">
  <a href="CLIENTS.md">English</a> · <a href="CLIENTS-ZH.md">中文</a>
</p>

> 本文档是客户端配置的正本。`CLIENTS.md` 是它的英文镜像:两者冲突时以本文档为准,
> 英文那份是过期副本。

`dotloom-mcp` 是一条像素画游戏资产管线 —— 精灵、动画帧、图集与瓦片地图。它以
**MCP(Model Context Protocol,模型上下文协议)服务器**的形式运行,Claude、Cursor、
OpenCode、Windsurf 这类 AI 助手就是这样学会用它画画的。

本页写给从未用过本项目的人:除了每一步真正需要的那点背景之外,不做任何其它假设。

本文提到的配置文件同时也以**字面文件**的形式存在于 [`clients/`](../clients),
按客户端分目录,你可以直接 diff 而不用手抄。本文档是自足的:不打开那个目录也能照着做完全部步骤。

---

## 你要连接的到底是什么

一个进程,一种协议。你的 AI 客户端启动 `dotloom-mcp` 时,会在你机器上拉起一个小的
Node.js 程序,并通过该程序的**标准输入与标准输出**(也就是你敲键盘时用的那两根管道)与它通信。
这种安排叫 **stdio**。不需要装成系统服务,不需要开端口,不需要粘 URL,关掉客户端时也不会
留下后台进程。

有两个后果值得先知道:

- **客户端负责启动与关闭这个服务器。** 你不用手动拉起,也不用维持它活着。
- **第一次启动会下载这个包。** `npx` 会先从 npm 取 `dotloom-mcp`,所以首次启动比之后慢几秒。
  不会有任何东西被装到全局。

连上之后,助手可以新建精灵、在上面作画、上色、读回精确像素、把结果作为图片预览,
并导出 PNG / 图集 / GIF / Tiled 地图。整个过程都在这个进程里完成 —— 代价见
[诚实的限制](#诚实的限制)。

---

## 开始之前

### 1. Node.js 22.13 或更新

这个服务器是个 Node.js 程序。先看你装的是哪个:

```bash
node --version
```

需要 **v22.13.0** 或更新。如果更旧,去 [nodejs.org](https://nodejs.org/)(或你的版本管理器)
装一个当前版本,再重新检查一次。在 Windows 上,`node` 必须在 `PATH` 里 —— 装完之后如果提示
找不到命令,重开一个终端。

`npx` 随 Node 一起安装,所以只要 `node --version` 能跑,`npx` 就已经在了。

### 2. 这个包能跑

用客户端将要使用的方式把它跑起来,看它有没有回应:

```bash
npx -y dotloom-mcp --version
```

```
dotloom-mcp 0.4.2
```

这一行就是全部的前置检查。打出版本号就说明网络通、Node 版本够。**这一行写的是 stderr,
不是 stdout** —— 这是有意为之,因为在 stdio 连接上 stdout 承载的是协议本身。
有些 shell 会把 stderr 显示得像报错,它不是。

如果它挂住不返回,那反而是正常的 —— 一个没有对端在说话的 stdio 服务器就会那样等着。
按 `Ctrl+C` 退出。

### 3. 可选:桌面应用

不装任何应用,这个服务器也能用。如果你**确实**在运行
[dotloom-mcp 桌面编辑器](https://github.com/Lonely-bear/pixel-art/releases/latest),
服务器会自动找到它,并编辑窗口里正在显示的同一批文档,共用同一份撤销历史。
两种情况下都不需要配置。

---

## 你即将填入的字段

下面每个客户端配的都是同一个服务器,所以词汇是共通的。五个字段就覆盖了全部。

| 字段 | 出现在 | 含义 |
| --- | --- | --- |
| `mcpServers` | Claude、Cursor、Windsurf | 外层对象,每个服务器一个键。 |
| `mcp` | OpenCode | 同样的职责,但**名字和嵌套都不同** —— 见 [OpenCode](#opencode)。 |
| `<服务器名>` | 两者 | 键名 `dotloom-mcp`。这是*你的客户端*显示的标签。名字本身是任意的;本指南在四个客户端里统一用它,好让名字保持一致。 |
| `command` | Claude、Cursor、Windsurf | 要启动的程序,字符串。 |
| `type` | Cursor、OpenCode | 怎么启动:`"stdio"` / `"local"` 表示由客户端自己拉起进程,或者用远程 `url` 指向一个已经在别处运行的服务器。 |
| `args` | Claude、Cursor、Windsurf | 参数,**是一个列表,并且要包含程序名**。`["/c", "npx", "-y", "dotloom-mcp"]` 读作「`cmd`,去跑 `npx`,带 `-y` 和 `dotloom-mcp`」。 |
| `command` | OpenCode | 同样的信息,但是一个列表、且没有单独的字段:`["npx", "-y", "dotloom-mcp"]`。 |
| `env` / `environment` | 全部 | 给服务器进程设置的环境变量。**这个服务器不需要任何环境变量**,留空即可。 |

`command: "npx"` 配 `args: ["-y", "dotloom-mcp"]`,读作:跑 `npx`,让它下载前不要停下来问(`-y`),
然后启动 `dotloom-mcp` 这个包。

### Windows:一处替换,以及为什么

在 Windows 上,下面每个配置都要换掉前两个字段:

| | macOS / Linux | Windows |
| --- | --- | --- |
| `command` | `"npx"` | `"cmd"` |
| `args` | `["-y", "dotloom-mcp"]` | `["/c", "npx", "-y", "dotloom-mcp"]` |

这不是风格偏好。自 CVE-2024-27980 的修复起(Node 18.20.2、20.12.2、22 及更新版本),
Node 拒绝在没有命令 shell 的情况下执行 `.cmd` 和 `.bat` 包装脚本;而在 Windows 上,
裸的 `npx` 根本不是一个可执行文件 —— 它是一个没有扩展名的 shell 脚本。
在 Node 22.20.0 上实测:

| `command` | 客户端不经过 shell 启动 | 客户端经过 shell 启动 |
| --- | --- | --- |
| `npx` | 失败 —— `ENOENT` | 可用 |
| `npx.cmd` | 失败 —— `EINVAL` | 可用 |
| `cmd` + `/c npx …` | **可用** | **可用** |

`cmd.exe` 是真正的可执行文件,所以绕道它两种情况都能跑通 —— 这让它成为唯一一种不依赖
你的客户端具体怎么起进程的形式。如果哪份指南让你在 Windows 上用 `npx.cmd`,那套说法早于
上面那次 Node 变更。

---

## 选你的客户端

### Claude Desktop

**文件:** `claude_desktop_config.json`

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | Claude Desktop 没有 Linux 版。请用 [Claude Code](#claude-code)。 |

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

**怎么打开:** Claude 菜单 → **Settings** → **Developer** 标签 → **Edit Config**。
如果文件不存在,这个按钮会替你创建,所以你不必自己去猜路径。

**如果文件里已经有别的服务器,** 把它们留着。在已有的 `mcpServers` 对象里再加一条
`dotloom-mcp`,而不是替换整个文件。

**然后把 Claude Desktop 完全退出,再重新启动。** 只关窗口是不够的:进程必须真的退出,
才会重新读取配置。

### Claude Code

**文件:** 项目根目录下的 `.mcp.json`。

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

`.mcp.json` 是 Claude Code 的**项目作用域**:它本来就应该提交进版本库,这样任何克隆这个
仓库的人都拿到同一套工具。第一次打开项目时,Claude Code 会就项目作用域的服务器弹一次
授权提示 —— 每个项目批准一次。

不想手写文件：让 CLI 替你写:

```bash
claude mcp add --transport stdio dotloom-mcp -- npx -y dotloom-mcp
```

这条命令只为**你本人、且只在这个项目**保存该条目。加上 `--scope user` 可以在本机所有项目里
都可用,加 `--scope project` 则让它写成 `.mcp.json` 供全队共享。

```bash
claude mcp list        # 列出全部已配置服务器,带连接状态
claude mcp get dotloom-mcp   # 查看某一个服务器存下来的定义
```

在运行中的会话里,`/mcp` 会交互式地打开同一份列表。

### Cursor

**文件:** `mcp.json`

| 作用域 | 路径 |
| --- | --- |
| 全局 —— 你自己,所有项目 | `~/.cursor/mcp.json` |
| 项目 —— 本仓库 | `<项目>/.cursor/mcp.json` |

Cursor 会把两个文件都读进来并**合并**;同一个服务器名同时出现在两处时,项目文件优先。
除非你想把它提交进某一个仓库,否则装成全局的。

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

Cursor 的文档把 `type` 标为 stdio 服务器的必填项,所以这里写上了。

**存盘之后重启 Cursor** —— 改文件不会让运行中的编辑器重新加载。也可以走 UI:
**Customize → MCPs → Add new MCP Server**,粘同样的 JSON。

### OpenCode

**文件:** `opencode.json` 或 `opencode.jsonc`

| 作用域 | 路径 |
| --- | --- |
| 全局 | `~/.config/opencode/opencode.json` |
| 项目 | `<项目>/opencode.json`,或 `<项目>/.opencode/opencode.json` |

macOS / Linux:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

Windows:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["cmd", "/c", "npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

```bash
opencode mcp list
```

`opencode mcp add` 会以交互方式引导你添加一个本地或远程服务器。

**OpenCode 的写法跟另外三个不同,而且很容易写错。**

- 服务器名是**直接挂在 `mcp` 下面**的键。中间没有 `servers` 这一层。
  `mcp.servers.dotloom-mcp` 会被读成「一个名字叫 `servers`、既没有 `type` 也没有 `command`
  的服务器」,而 `dotloom-mcp` 根本没被配置上。这种写法会被 OpenCode 公布的 JSON Schema 判为非法。
- `command` 是**一个包含程序名本身的数组**,不是字符串,也不是「字符串 + 单独的参数列表」。
- `type` 必填:本地写 `"local"`,远程 URL 写 `"remote"`。
- 环境变量写在 `environment` 下,不是 `env`。另外还接受 `timeout`(毫秒);
  见[故障排查](#故障排查)。

### Windsurf

**文件:** `mcp_config.json`

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `~/.config/devin/mcp_config.json`,或 `$XDG_CONFIG_HOME/devin/mcp_config.json` |
| Windows | `%APPDATA%\devin\mcp_config.json` |

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

**别去自己找这个路径 —— 让 Windsurf 告诉你。** 在 Cascade 面板里点
**`...`(Actions)→ Open MCP config file**,它打开的那个文件就是你这个安装真正会读的那个。

> 上面这个路径是 Windsurf 当前文档写的。更早的文档、以及大量第三方指南仍然写
> `~/.codeium/windsurf/mcp_config.json`;Windsurf 自己的文档也说明这一套配置适用于它
> 旧版的 Cascade agent,而它较新的 local agent 改用独立的 Devin CLI 配置文件。
> **以 Windsurf 为你打开的那个文件为准。** 放错路径的文件不会报错 —— 它会被静默忽略,
> 服务器就是永远不出现。

Windsurf 的 MCP 配置是**全局**的:没有按项目划分的文件,所以一条配置服务所有工作区。

**然后在 MCPs 面板里点刷新。** 改文件不会重启已经在跑的服务器。如果某个服务器卡在失败状态,
刷新可能会复用那个已经死掉的进程 —— 那种情况请完整重启 Windsurf。

---

## 验证连接

客户端把服务器列出来,几乎证明不了什么:它只证明了一个 JSON 文件能解析。下面三步检查
依次往下,证明的东西越来越多。

### 检查 1 —— 客户端说它连上了

| 客户端 | 位置 |
| --- | --- |
| Claude Code | `claude mcp list`,或会话里的 `/mcp` |
| OpenCode | `opencode mcp list` |
| Cursor | **Customize → MCPs** |
| Claude Desktop | 输入框下方的连接器菜单 |
| Windsurf | Cascade 面板的 **MCPs** 区域 |

### 检查 2 —— 调用 `get_connection_status`

这是真正的检验,也是这个服务器比「只会画画的服务器」更值得选的原因。对助手说:

> 在 dotloom-mcp 服务器上调用 `get_connection_status` 工具,把结果给我。

没有桌面应用在跑时,正确的回答长这样:

```json
{
  "ok": true,
  "attached": false,
  "mode": "memory",
  "livePreview": false,
  "url": null,
  "port": null,
  "source": null,
  "note": "No desktop app is connected. Edits live only in memory until save_document/finalize_document. Ask the user to open the app for live preview; this session reconnects automatically when it appears."
}
```

读作:*已连接,自己在跑,屏幕上什么都没有。* 桌面应用在跑时,`mode` 会变成 `"app"`、
`livePreview` 变成 `true`,同一个工具就是在告诉助手:它正在驱动你打开的那个窗口。

服务器压根不在的情况下,是**没有这个工具、也没有这种错误** —— 这就是「已连接但跑在内存里」
和「没连上」之间的区别。

### 检查 3 —— 调用 `read_grid`

这一步是真正触到绘图引擎,而不只是汇报它的状态。对助手说:

> 在 dotloom-mcp 上调用 `read_grid`,区域从 0,0 到 10,4,把输出给我。

在一个全新的会话里 —— 一张刚建的 32×32 空白文档、上面什么都没画 —— 正确的回答会说:

```
read_grid  view=value  frame=0  scope=composite  rect=10x4 at (0, 0)
opaque 0/40  (nothing drawn in this region)
```

**「nothing drawn in this region」就是通过条件。** 你要找的不是一张图,而是对一张真实的
(空白的)文档做的一次真实测量。如果这个工具报错、不存在,或者报出一个你从没要求过的文档,
那连接就不是你以为的那个样子。

之后再试试这个真实请求:

> 用 dotloom-mcp 画一个 16×16 的史莱姆精灵,四个绿色调,然后给我看预览。

### 你会在工具列表里看到什么

这个服务器对外广告 **36 个工具**。这是有意为之,不是列表被截断了:背后那 ~90 条绘图、
调色板、绑定姿势与瓦片地图命令是按需发布的,这样它们就不会占用每一条消息的上下文窗口。
让助手跑 `list_commands` 可以看到完整目录;`describe_command` 带上命令名可以拿到它的确切参数。

你还可能在某些客户端里看到服务器自报名字是 **`dotloom-mcp-link`**。这是预期行为。
配置里的名字(`dotloom-mcp`)是你的客户端显示的标签;服务器在协议里自报的名字带
`-link` 后缀,是因为它运行在「一旦出现桌面编辑器就接上去」的那个模式里。两者都会在正常使用中出现。

---

## 诚实的限制

- **你不主动要求,就不会有任何东西落盘。** 助手画的一切都活在内存里,活到本次会话结束为止。
  除非它调用了带输出路径的 `save_document` 或 `finalize_document`,否则会话一关就没了。
  导出要显式提出 —— 「给我看看预览」不会存文件。
- **没有桌面应用就没有实时预览。** 你能在对话里拿到 `get_preview` 系列工具返回的图片,
  这够用来干活,但没有一个窗口会随绘制实时更新。要那个就启动桌面应用。
- **HTTP 没有作为独立选项提供。** 四个客户端里有三个可以连 URL,本页本来可以给你一个。
  但它给不了:HTTP 端点 `http://127.0.0.1:7331/mcp` 只在桌面应用运行时存在,绑在
  loopback 上所以机器外访问不到,而且不做任何鉴权。一个应用一关就没了的 URL,比一个
  由客户端启停的进程更糟糕作为起点。所以这里四个配置全用 stdio,而服务器会自己接上
  正在运行的应用。
- **首次启动慢。** `npx` 要先下载包。如果你的客户端启动超时很短 —— OpenCode 抓取工具的
  默认是 5 秒 —— 先在终端里跑一次 `npx -y dotloom-mcp --version` 把缓存热起来。
- **要不要锁版本由你决定。** `npx -y dotloom-mcp` 每次启动都取最新的已发布版本。
  要固定版本,就把 `dotloom-mcp` 写成 `dotloom-mcp@0.4.2`。
- **Windsurf 对所有 MCP 服务器的工具总数有 100 个的上限。** 本服务器起始 36 个,放得下,
  但在加别的之前先看看已有的那些。
- **你要求的时候,这个服务器能读写本地文件** —— 打开文档、导入图片、导出资源。
  它以你的身份、用你的权限运行。请在你自己的机器上用,并且在想清楚它该碰哪些目录之后,
  再把 agent 指向敏感的东西。
- **`clients/` 里的配置文件不在 npm 压缩包里。** 本文档在;那个目录只在 GitHub 仓库里。
  这正是上面那些代码块完整且自足的原因 —— 从这里复制就行。

---

## 故障排查

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| 客户端里根本没有这个服务器 | 配置没重新加载,或文件放在了它不读的路径 | 完整重启客户端。在 Windsurf 上,用 **Actions → Open MCP config file** 确认。 |
| `command not found` / `ENOENT` | Windows,且用了 `npx` 或 `npx.cmd` | 换成 `cmd` + `/c npx` 的写法。见 [Windows](#windows一处替换以及为什么)。 |
| `EINVAL` | Windows,且用了 `npx.cmd` | 同上。Node 拒绝在没有 shell 的情况下跑 `.cmd`。 |
| 服务器在列表里,但一个工具都没有 | 首次 `npx` 下载导致启动超时 | 预热缓存:`npx -y dotloom-mcp --version`。OpenCode 上给该条目加 `"timeout": 60000`。 |
| 助手找不到 `get_connection_status` | 服务器根本没连上 | 读客户端的 MCP 日志。Claude Desktop 写在 `~/Library/Logs/Claude/mcp.log`(macOS)或 `%APPDATA%\Claude\logs\mcp.log`(Windows);Cursor 在 Output 面板里有 **MCP Logs**。 |
| 能用,但屏幕上什么都没有 | 桌面应用没运行 | 预期行为。见[诚实的限制](#诚实的限制)。 |
| 两次会话之间作品消失了 | 没有保存过 | 要求它带输出路径跑 `finalize_document`。 |
| OpenCode:`opencode mcp list` 里没有它 | 条目嵌在了 `mcp.servers` 下,或 `command` 写成了字符串 | 见 [OpenCode](#opencode)。 |
| OpenCode:`dotloom-mcp` 在列表里但一直连不上 | 文件放错了 —— OpenCode 从 `~/.config/opencode/` 读全局配置 | 检查你写的是哪个 `opencode.json`。 |

### 读服务器自己的日志

服务器把启动那一行写到 stderr,MCP 客户端会把它收进 MCP 日志。正常启动长这样:

```
dotloom-mcp 0.4.2 ready on stdio in memory; watching for a desktop app.
dotloom-mcp 0.4.2 ready on stdio, attached to http://127.0.0.1:7331/mcp.
```

如果想自己看:

```bash
npx -y dotloom-mcp
```

它会打印那一行然后等着。这是正确行为,不是卡死。

### 不通过客户端排查

本仓库附带一个说同样协议的脚本,可以在完全不牵扯 AI 助手的情况下查问题:

```bash
node scripts/mcp-call.mjs list        # 列出全部对外广告的工具
node scripts/mcp-call.mjs call get_connection_status '{}'
```

---

## 相关文档

- [`clients/`](../clients) —— 以字面、可 diff 的文件形式存在的配置文件
- [`REFERENCE.md`](REFERENCE.md) —— MCP 工具面的深度文档:命令目录、惰性工具面、
  脚本、瓦片地图
- [`API.md`](API.md) —— 构建期脚本 API,用代码而不是 agent 来生成资源
- [Model Context Protocol](https://modelcontextprotocol.io/) —— 协议本身
