<div align="center">
  <img src="assets/pixel-mark.svg" width="88" alt="dotloom-mcp 标志" />
  <h1>dotloom-mcp</h1>
  <p><strong>面向游戏资产的像素画引擎，人类和 AI Agent 操作的是同一套。</strong></p>
  <p>同一套引擎、同一套文档模型，三个客户端：Electron 编辑器、<code>pixel</code> CLI 和 Model Context Protocol 服务器。</p>
  <p>为人类与 AI 提供同一套像素画引擎 · Electron for humans, MCP for agents</p>
  <p>
    <a href="https://www.npmjs.com/package/dotloom-mcp"><img src="https://img.shields.io/npm/v/dotloom-mcp?label=npm&logo=npm&style=flat-square" alt="npm 版本" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Apache-2.0 许可证" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.13-5fa04e?style=flat-square" alt="Node.js 22.13 或更高版本" />
    <img src="https://img.shields.io/badge/MCP-ready-8a5cf5?style=flat-square" alt="支持 Model Context Protocol" />
  </p>
</div>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <img src="assets/hero.png" width="760" alt="黄昏时分的像素画山湖，由 dotloom-mcp 工具链创作" />
</p>

<p align="center">
  <strong>在 Electron 编辑器中绘制，通过 CLI 下达命令，或让 AI Agent 操作同一个实时文档。</strong><br />
  所有变更都经过同一条命令总线，因此工具、历史记录、导出以及撤销/重做始终保持一致。
</p>

它是游戏资产管线，不是图像生成器。像素画资产是受约束的、量化的、网格精确的
产物，并带有技术契约 —— 调色板索引、动画标签、瓦片属性、碰撞矩形 —— 命令、
文件格式和导出都是围绕这份契约设计的，而不是围绕画面本身。

## 一条命令做出成品

`pixel demo` 不需要输入文件、不需要调色板，也没有必填参数。它通过真实的命令总线
画出一张精灵，写出 PNG，并在旁边写下可编辑的 `.pixel` 源文件。事先什么都不用装 ——
下面就是完整的命令，只是把两个可选参数写了出来：

```console
$ npx -y dotloom-mcp pixel demo --out out --size 8
pixel demo -> /…/out/crowned-slime.png
  editable source: /…/out/crowned-slime.pixel
{
  "ok": true,
  "command": "demo",
  "sprite": "Crowned Slime",
  "path": "/…/out/crowned-slime.png",
  "source": "/…/out/crowned-slime.pixel",
  "width": 256,
  "height": 256,
  "canvas": {
    "width": 32,
    "height": 32
  },
  "scale": 8,
  "palette": 10,
  "layers": [
    "Base",
    "Shade",
    "Light",
    "Crown",
    "Face",
    "Outline"
  ],
  "frames": 2,
  "tags": [
    "idle"
  ],
  "commands": 33,
  "bytes": 4675
}
```

一张 32×32 的成品精灵 —— 十个颜色、六个图层、`idle` 标签下的两帧，由 33 条命令
画出 —— 用最近邻采样放大 8 倍，旁边就是可以直接在编辑器里打开的 `.pixel`。所有
文档操作都只打印一个 JSON 对象，所以它和别的命令一样能进 Shell 脚本。

`path` 和 `source` 是相对工作目录解析后的绝对路径，`/…/` 就是你执行命令的位置。
上面的输出是在本仓库的构建产物上跑同一条命令得到的。

### 同一个引擎，接给 Agent

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

这就是全部的安装步骤。服务器通过 stdio 讲 MCP，会在 loopback 接口上发现正在运行的
编辑器，去编辑窗口里显示的同一批文档、共用同一份撤销历史；如果没有编辑器在运行，
它就在内存中提供同一套引擎，并在之后出现编辑器时自动重连。

`tools/list` 返回 **36 个工具**。它们背后的 94 条命令 —— `draw_ellipse`、
`add_palette_ramp`、`outline`、`stroke_tilemap`、`autotile`、绑定、瓦片地图 ——
一开始并不在列表里。Agent 只能像任何 MCP 客户端那样，通过 `list_commands`、
`describe_command`、`find_workflow` 或 `apply_ops` 去找它们；只要本次会话查找过
或运行过某条命令，它就立刻变成可以直接调用的工具。那份扁平目录曾经是 127 条，
每条请求都要带在上下文里。数字和取舍理由写在
[`docs/REFERENCE.md`](docs/REFERENCE.md#what-it-exposes)。

## 画面由 Agent 画出

本页的像素画，是 AI Agent 通过网络驱动本产品画出来的，只用公开的工具列表 ——
没有 import `@pixel/core`，没有直接访问编辑器，也没有特权调用。这个限制本身就是
论据，而且在这里是真实存在的：Agent 出发时拿到的列表里一条绘图命令都没有，所以
发现路径必须真的能用，否则根本不会有这些画。

同一个场景，两种媒介。左边是光栅参考图，右边是同一构图在原生 512×512 像素画
下的样子。

<table>
  <tr>
    <td width="50%"><img src="assets/lighthouse-reference.png" alt="日落灯塔的光栅参考图" /><br /><sub>光栅参考</sub></td>
    <td width="50%"><img src="assets/lighthouse-pixel.png" alt="同一构图的原生像素画" /><br /><sub>原生像素画输出</sub></td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><img src="assets/showcase-autumn.png" alt="秋日黄昏湖泊像素画" /></td>
    <td width="50%"><img src="assets/showcase-moonlit.png" alt="月光下的高山湖泊像素画" /></td>
  </tr>
  <tr>
    <td align="center"><sub>秋日黄昏湖泊</sub></td>
    <td align="center"><sub>月光下的高山湖泊</sub></td>
  </tr>
</table>

这些场景、服务器写出的 `.pixel` 源文件，以及用来复现它们的校验流程，都放在
[`artwork/`](artwork/README.md)。

## 安装

`dotloom-mcp` 是公开 npm 包的规范名称。内部 workspace 包仍使用 `@pixel/*` 作用域；这些是实现包，不是额外的 npm 产品。

### 下载桌面版

编辑器为每个平台都提供可直接安装的构建产物。从
**[GitHub Releases](https://github.com/Lonely-bear/pixel-art/releases/latest)**
下载最新版本：

| 平台 | 文件 |
| --- | --- |
| Windows | `dotloom-mcp-<version>-x64-setup.exe` — 安装到当前用户目录，无需管理员权限 |
| Windows 免安装 | `dotloom-mcp-<version>-x64-portable.exe` — 放到哪里都能直接运行，包括 U 盘 |
| macOS（Apple 芯片） | `dotloom-mcp-<version>-arm64.dmg` |
| macOS（Intel） | `dotloom-mcp-<version>-x64.dmg` |
| Linux | `dotloom-mcp-<version>-x86_64.AppImage` — 直接运行，无需安装；Debian/Ubuntu 也可用 `.deb` |

装好编辑器就够了，不需要其它任何东西：MCP 服务器构建在同一个二进制里，并在
`127.0.0.1` 上发布自己，这正是单独安装的 `dotloom-mcp` 找到正在运行的编辑器的
方式。`pixel` CLI 不在这个二进制里 —— 它来自下面的 npm 包。

> 这些构建**尚未做代码签名**。macOS 首次启动会拦截，需要右键应用选择
> **打开**（或执行 `xattr -dr com.apple.quarantine /Applications/dotloom-mcp.app`）；
> Windows 的 SmartScreen 会警告一次，选择**更多信息 → 仍要运行**。后续补上证书
> 不需要改动应用本身。

### 环境要求

npm 包需要 Node.js **22.13 或更高版本**，以及 npm、pnpm，或任何能够启动本地
stdio 服务器的 MCP 客户端。

桌面版除操作系统外不需要任何运行时环境。

### 安装 CLI 和 MCP 服务器

```bash
npm install -g dotloom-mcp
```

验证安装：

```bash
dotloom-mcp --version
pixel --version
```

`pixel-mcp` 和 `pixel-art-mcp` 仍是独立 MCP 服务器的兼容别名；`pixel` 是无界面的文档 CLI。

无需全局安装，也可以直接临时运行：

```bash
npx -y -p dotloom-mcp pixel --version
npx -y dotloom-mcp --version
```

### 从构建脚本生成资产

还有一种用法，既不需要客户端也不需要人：构建脚本。不用 GUI，不用 MCP 客户端，
没有人类在环里。`buildSprite`、`buildAnimation` 和 `exportAssets` 会把一份规格变成
成品文件，以 `devDependency` 的形式使用。

```js
import { buildSprite, exportAssets } from 'dotloom-mcp';

const slime = buildSprite({
  seed: 20260927, width: 16, height: 16, name: 'slime',
  layers: ['base', 'shade'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  ops: [{ command: 'draw_ellipse', params: { rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } }],
});

for (const file of exportAssets(slime, { sheet: true, source: true })) {
  console.log(file.path, file.bytes.length, file.mediaType);
}
```

同一个种子，每次都是同样的字节 —— 这正是把生成的资产纳入版本管理的前提。API 只
返回字节，绝不碰磁盘；文件放在哪里由构建脚本决定。**[`docs/API-ZH.md`](docs/API-ZH.md)
给出完整接口面、确定性契约和版本策略**（[English](docs/API.md)）：哪些是稳定的、
哪些是内部的、哪些会在大版本里变。

该包还直接暴露整套引擎，不必经过上面这种任务形函数：

```js
import { VERSION, core, mcp, script } from 'dotloom-mcp';

const document = core.createSprite({ width: 32, height: 32 });
console.log(VERSION, document.width, typeof mcp.createPixelServer, typeof script.ScriptRuntime);
```

这三个命名空间是逃生舱，而不是推荐的起点。它们真实存在、已经发布、也有文档，
但不在 `API_VERSION` 的覆盖范围内。

### 连接 MCP 客户端

大多数桌面 MCP 客户端使用 `mcpServers` 对象：

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

在 Windows 上，部分客户端需要使用 `"command": "npx.cmd"`。

<details>
<summary><strong>OpenCode V2 配置</strong></summary>

在希望使用该服务器的项目中添加：

```bash
opencode mcp add dotloom-mcp -- npx -y dotloom-mcp
```

也可以在 `opencode.json` / `.opencode/opencode.json` 中手动配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "dotloom-mcp": {
        "type": "local",
        "command": ["npx", "-y", "dotloom-mcp"]
      }
    }
  }
}
```

使用 `opencode mcp list` 或 `/mcps` 检查连接状态。

</details>

## 为什么选择 dotloom-mcp？

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>面向人类的工作区</h3>
      <p>在 Electron 中提供像素级画布、图层、帧、洋葱皮、瓦片地图、调色板和动画播放。</p>
    </td>
    <td width="33%" valign="top">
      <h3>面向 Agent 的工作区</h3>
      <p>独立 MCP 服务器为 Agent 提供真实 PNG 预览、结构化工具、精确的字符网格和安全批量编辑。</p>
    </td>
    <td width="33%" valign="top">
      <h3>唯一事实来源</h3>
      <p>Electron UI、CLI、脚本和 MCP 服务器使用同一套可序列化命令与文档模型。</p>
    </td>
  </tr>
</table>

实用的 Agent 工作循环刻意保持简短：

```text
create_document → block silhouette → inspect PNG → shade in batches
      ↑                                                    ↓
 fix what you can see ← preview each visual gate → finalize_document
```

## 30 秒了解 CLI

文档操作只向 stdout 打印一个 JSON 对象，便于 CLI 与 Shell 脚本和 CI 组合；帮助信息和面向人类的命令列表使用纯文本。

```bash
# 一张成品精灵；--out 和 --size 都可以省略
pixel demo --out out --size 8

# 创建带图层和动画的文档
pixel new hero.pixel --width 32 --height 32 --layers Ink,Shade --frames 4

# 查看、绘制并导出
pixel info hero.pixel
pixel apply hero.pixel --ops ops.json
pixel export hero.pixel --out hero.png --scale 8

# 引擎和游戏资源格式
pixel sheet hero.pixel --out hero-sheet.png
pixel gif hero.pixel --out hero.gif --tag idle
pixel tiled hero.pixel --out hero.tmj
pixel thumb hero.pixel --out thumb.png --max 128

# 查看所有命令及其 JSON Schema
pixel commands --json > tools.json
```

批量操作使用与 Agent 通过 MCP 发送的相同载荷：

```json
{
  "ops": [
    {
      "command": "draw_rect",
      "params": {
        "layer": "Ink",
        "frame": 0,
        "rect": { "x": 2, "y": 2, "w": 12, "h": 12 },
        "color": "pal:3",
        "fill": true
      }
    },
    {
      "command": "outline",
      "params": {
        "layer": "Ink",
        "color": "#101820",
        "scope": "composite"
      }
    }
  ]
}
```

对文档执行这批操作：

```bash
pixel apply hero.pixel --ops ops.json
```

## MCP 服务器提供什么

工具目录由用于验证命令的同一套 Zod Schema 生成，因此文档不会与运行时行为脱节。下表是其中的一部分；`list_commands` 返回完整目录，并且每个工具都声明了全部四项风险提示，客户端可以据此做门禁。

| 能力 | 作用 |
| --- | --- |
| `read_grid` | 把画面以字符网格返回——剪影、亮度、调色板槽位或颜色名。是文本，所以精确、可 diff、便宜；重复调用会报告哪些行发生了变化。用来**验证**一幅画。 |
| `get_selection` | 用户在画布上框选的矩形，附带它所在的图层和帧。`hint`（默认）只标记目标、允许 AI 略微改到框外；`enforce` 则把修改完全限制在框内。 |
| `get_preview` | 返回单帧或全部帧的真实 PNG，可选择裁剪、缩放、隔离图层或洋葱皮显示。用来**终审**一幅画。 |
| `preview_animation` | 按原始时间线或标签展开顺序生成动画联络表，并支持顺序感知的洋葱皮。 |
| `preview_pose` | 渲染绑定姿态或补间，并解析锚点和攻击框的世界坐标。 |
| `create_sprite_spec` | 通过一份声明式规格一次创建图层、帧、标签、调色板角色和可选绑定。 |
| `preview_tilemap` | 渲染未烘焙的地图，可叠加瓦片网格、数字索引、无效单元格和变更区域。 |
| `apply_ops` | 批量执行编辑操作，支持原子回滚，并可在同一次往返中返回预览。 |
| `set_frame_durations` / `upsert_tags` | 通过一次经过完整校验的命令更新多段帧时长和多个动画标签。 |
| `expectedVersion` | 通过版本冲突拒绝过期写入，避免覆盖更新的工作。 |
| `clip` | 将阴影、高光和抖动色带限制在轮廓或指定图层内。 |
| `add_palette_ramp` | 构建色相偏移的材质渐变，而不是简单的平面插值。 |
| `prune_palette` | 查找选定原始 cel 中未使用的颜色，提供 dry-run、语义角色和索引重映射。 |
| `ensure_palette_role` / `replace_colors` | 维护材质角色，并跨文档、帧、范围或列表统一改色。 |
| `finalize_document` | 保存可编辑源文件，并一次生成 PNG/逐帧/精灵图/GIF/姿态/联络表及可选增量哈希清单。 |
| `run_script` | 将有时限的 JavaScript 批处理作为单个撤销步骤运行，并提供隔离 dry-run 和源码相对错误诊断。 |
| `load_plugin` | 将插件命令注册为实时 MCP 工具。 |

`read_grid` 负责**验证**，`get_preview` 负责**终审**。这个分工是刻意的：判断一幅画
*好不好看*只有 PNG 才行，但 Agent 真正反复迭代的问题它答不上来 —— 32×32 精灵的
256px 缩图看不出剪影是否对称，也说不出第 14 行和第 13 行是否差了一个色阶，而图像
本身没法做 diff。

独立服务器通过 stdio 运行，不需要桌面应用，但会优先选择它。不带参数启动时，它会在
loopback 端点上发现正在运行的 Electron 应用并转发过去，因此 Agent 编辑的正是窗口
里显示的同一批文档。启动时没有应用应答，它就以内存模式自包含运行并持续探测：之后
打开应用会自动重连，关闭应用则回退到内存。`--attach <url>` 固定到某个端点，连不上
时会明确报错而不降级；`--standalone` 则完全跳过发现。

```bash
dotloom-mcp                                        # 优先应用，并持续探测
dotloom-mcp --attach http://127.0.0.1:7331/mcp     # 固定一个端点
```

连接后，GUI 和 Agent 会共享文档及撤销/重做历史：Agent 的编辑会重新绘制画布，人类的编辑也会立即对 Agent 可见。

## 创作工具箱

- **绘制** —— 铅笔、橡皮擦、直线、矩形、椭圆、多边形、油漆桶填充、颜色替换、裁剪，以及替换式重绘。
- **动画** —— 帧、批量时长和标签、持久角色绑定/姿态/补间、姿态与播放预览、锚点/攻击框、洋葱皮、任意角度局部变换、GIF 和精灵图。
- **瓦片地图** —— 图块集、可编辑网格、曲线加权地形笔刷、稀疏/加权 16/47 过渡、alpha 边缘局部烘焙、网格/索引预览、地图感知诊断、逐瓦片游戏属性、独立地图对象，以及自包含的 Tiled `.tmj` 导出。
- **像素画技巧** —— 色相偏移渐变、调色板锁定、安全清理未使用颜色、Bayer 和聚类抖动、选择性描边、去杂点，以及感知边角的抗锯齿。
- **场景构图诊断** —— 为全幅场景提供地平线、山脊、水线、明度平面、光线集中和引导线证据。
- **脚本** —— 受限的 `node:vm` 上下文，提供命令、像素缓冲、文档检查、采样、超时和插件。脚本 API 受到限制，但它不是针对不可信代码的安全边界。

<details>
<summary><strong>脚本 API</strong></summary>

```js
const base = layers()[0].id;

draw.rect({
  layer: base,
  frame: 0,
  rect: { x: 0, y: 0, w: 8, h: 8 },
  color: 'pal:3',
  fill: true,
});

putPixels({ x: 8, y: 0, w: 2, h: 1 }, '/wAA/wD/AIA=');
const reflected = sampleComposite(1, 1);

log('done', commands().length);
return { base, reflected };
```

地图脚本可以调用 `strokeTilemap(...)`、`paintTilemap(...)` 以及对应的 `draw.tilemap` / `draw.bake` 别名；`tilemaps()`、`mapObjects()` 和 `tileProperties()` 可以读取地图元数据，而无需复制大型瓦片数组。整个脚本只算一个撤销步骤。沙箱不提供 `require`、`process`、文件系统、网络、`eval` 或 `new Function`。

</details>

## 文件支持

| 格式 | 读取 | 写入 | 说明 |
| --- | :---: | :---: | --- |
| `.pixel` | ✓ | ✓ | 原生可编辑文档格式 |
| PNG | ✓ | ✓ | 单张图像、全部帧、任意整数倍缩放 |
| Aseprite `.ase` | ✓ | — | 导入为新的可编辑文档 |
| 精灵图 + JSON | — | ✓ | 兼容 Aseprite 的 `frameTags` |
| 动画 GIF | — | ✓ | 支持标签方向和重复设置 |
| Tiled `.tmj` | — | ✓ | 自包含地图 + 图块集 PNG、瓦片属性和对象图层 |

`.pixel` 就是一个普通的 zip —— 一份 manifest 和每个 cel 一张 PNG，zip 条目的时间戳
被固定 —— 所以可以直接解开查看，同一份文档序列化两次得到的也是同样的字节。

## 架构

```text
┌─────────────────────┐
│ Electron 像素 UI    │──┐
├─────────────────────┤  │
│ pixel CLI + 脚本    │──┼──▶  命令总线  ──▶  PixelDocument
├─────────────────────┤  │        │              图层 · 帧
│ MCP 工具/资源       │──┘        │              标签 · 瓦片地图
└─────────────────────┘           ▼
                         撤销 / 重做历史
```

| 包 | 作用 |
| --- | --- |
| `dotloom-mcp` | 已发布的 npm 包：包含库、CLI 和独立 MCP 服务器。 |
| `packages/core` | 与平台无关的 TypeScript 文档模型、命令总线、光栅器、PNG、GIF 和序列化。 |
| `packages/script` | 仅支持 Node.js 的 JavaScript 沙箱和插件运行时。 |
| `packages/cli` | 以 JSON 为优先的无界面命令行。 |
| `packages/mcp` | MCP 工具、资源、提示、stdio 服务器和 HTTP 桥接。 |
| `packages/app` | 内嵌 MCP 主机的 Electron + React + Vite 编辑器。 |

`core` 不依赖 DOM、Electron 或 Node。相同源码可以运行在 Node、浏览器、Worker、Electron 渲染进程、测试和 CI 中。

## 开发

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm build
pnpm typecheck
pnpm test

# Electron 编辑器
pnpm --filter @pixel/app run dev

# 从当前检出运行独立工具
node packages/cli/dist/index.js --help
node packages/mcp/dist/cli.js --help
```

构建公开 npm 包但不发布：

```bash
pnpm build:npm
npm pack --dry-run
```

仓库使用 pnpm workspace、严格 TypeScript、Vitest 和干净构建 CI 检查。公开 npm 包会将内部 workspace 代码打包进去，同时将普通 npm 依赖保留为外部依赖。

> **分发范围：** npm tarball 发布 CLI、库入口和独立 MCP 服务器。Electron 编辑器单独分发，作为 GitHub Release 的安装程序提供 —— 它不属于 tarball，tarball 也不需要它。

### 打包桌面版

安装程序使用 [electron-builder](https://www.electron.build/) 构建。主进程由
esbuild 打包，而不是逐文件编译 —— 因为 pnpm 把 `@pixel/core` 和 `@pixel/mcp`
链接为符号链接，打包后的应用无法跟随这些链接。因此最终的产物里完全没有
`node_modules`。

```bash
# 发布所需的全部构建，按当前所在平台
pnpm build
pnpm --filter @pixel/app run dist:win     # 或 dist:mac / dist:linux

# 只生成未打包的应用目录，不做安装器 —— 验证改动最快的方式
pnpm --filter @pixel/app run pack

# 按 assets/pixel-mark.svg 的设计重新生成 build/icon.png
pnpm --filter @pixel/app run icon
```

产物在 `packages/app/release/`。构建目标、产物命名和图标都写在
[`packages/app/electron-builder.yml`](packages/app/electron-builder.yml) 里；
workflow 只负责决定哪个 runner 构建哪个平台。

### 发布流程

```bash
# 1. 把 Unreleased 的更新日志条目移到带日期的标题下，然后提升版本号：
#    package.json -> version，CHANGELOG.md -> ## [X.Y.Z] - YYYY-MM-DD
# 2. 提交后打 tag 并推送。tag 必须与 package.json 完全一致。
#    两行里的 <version> 都要替换成你刚设置的版本号。
git commit -am "chore(release): prepare dotloom-mcp <version>"
git tag v<version>
git push origin main --follow-tags
```

随后 `.github/workflows/release.yml` 会并行构建 Windows、macOS 和 Linux，并把
所有产物发布到同一个 GitHub Release。如果 tag 与 `package.json` 不一致，或更新
日志里没有该版本的带日期小节，workflow 会直接拒绝构建 —— 两项检查都在
`scripts/prepare-release.mjs` 里，它同时会把版本号同步到 app 包，供
electron-builder 读取。

以后要加代码签名，只需配置仓库 secrets 再推一个新 tag，无需改动 workflow 或
任何配置：

| Secret | 用途 |
| --- | --- |
| `CSC_LINK` | P12 的 base64：Windows 的 Authenticode、macOS 的 Developer ID |
| `CSC_KEY_PASSWORD` | 该 P12 的密码 |
| `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | macOS 公证 |
| `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD` | 传入同一个 P12 的另一种方式 |

## 安全与本地信任

- 独立 MCP 服务器使用 stdio，由本地 MCP 客户端控制。
- Electron HTTP 主机绑定到 `127.0.0.1`，仅供受信任的本地客户端使用。请勿将其暴露到外部或进行端口转发。
- MCP 工具可以读取、写入、导入和导出本地文件路径。请使用只拥有必要权限的操作系统用户运行服务器。
- 插件 JavaScript 沙箱的范围有意保持狭窄，但 MCP 工具本身不能替代操作系统权限控制。

## 文档

- [English README](README.md) — 英文项目介绍与完整使用说明
- [库 API](docs/API-ZH.md) — 构建期生成资产的任务形接口、确定性契约与版本策略（[English](docs/API.md)）
- [技术参考](docs/REFERENCE.md) — 命令目录、MCP 内部机制、脚本、动画、瓦片地图和设计决策
- [更新日志](CHANGELOG-ZH.md) — 发布历史和范围（[English](CHANGELOG.md)）
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenCode MCP 配置](https://opencode.ai/v2/docs/mcp-servers/)

## 项目状态

`dotloom-mcp@0.4.2` 是当前版本。`0.4.0` 是第一个提供桌面安装程序的版本；`0.4.1`
让无界面服务器在编辑器稍晚启动时能够重连，而不是在本次会话剩余时间里一直待在
内存模式；`0.4.2` 带来了一条命令的 demo、稳定的构建期库 API、字节可复现的
`.pixel` 文件，以及应用内更新。

- [x] 核心文档模型、光栅器、命令总线、历史记录和原生序列化
- [x] PNG、精灵图、GIF、Aseprite 导入和 Tiled 导出
- [x] Electron 编辑器、动画、调色板、洋葱皮和瓦片地图
- [x] 独立 MCP 服务器、视觉资源、提示、诊断以及脚本/插件
- [x] 稳定的构建期库 API（`buildSprite` / `buildAnimation` / `exportAssets`）
- [x] 公开 npm 包和 CI 质量门禁
- [x] 每个 GitHub Release 都提供跨平台桌面安装程序
- [ ] 代码签名和 macOS 公证

## 许可证

Copyright © 2026 Lonely-bear。基于 [Apache License 2.0](LICENSE) 发布。
