<div align="center">
  <img src="assets/pixel-mark.svg" width="88" alt="dotloom-mcp 标志" />
  <h1>dotloom-mcp</h1>
  <p><strong>同一套像素画引擎，两种创作方式。</strong></p>
  <p>为人类与 AI 打造的同一套像素画引擎 · Electron for humans, MCP for agents</p>
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

## 为什么选择 dotloom-mcp？

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>面向人类的工作区</h3>
      <p>在 Electron 中提供像素级画布、图层、帧、洋葱皮、瓦片地图、调色板和动画播放。</p>
    </td>
    <td width="33%" valign="top">
      <h3>面向 Agent 的工作区</h3>
      <p>独立 MCP 服务器为 Agent 提供真实 PNG 预览、结构化工具、视觉质量报告和安全批量编辑。</p>
    </td>
    <td width="33%" valign="top">
      <h3>唯一事实来源</h3>
      <p>Electron UI、CLI、脚本和 MCP 服务器使用同一套可序列化命令与文档模型。</p>
    </td>
  </tr>
</table>

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

## 安装

`dotloom-mcp` 是公开 npm 包的规范名称。内部 workspace 包仍使用 `@pixel/*` 作用域；这些是实现包，不是额外的 npm 产品。

### 环境要求

- Node.js **22.13 或更高版本**
- npm、pnpm，或任何能够启动本地 stdio 服务器的 MCP 客户端

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

该包还提供无需启动 CLI 进程的库 API：

```js
import { VERSION, core, mcp, script } from 'dotloom-mcp';

const document = core.createSprite({ width: 32, height: 32 });
console.log(VERSION, document.width, typeof mcp.createPixelServer, typeof script.ScriptRuntime);
```

无需全局安装，也可以直接临时运行：

```bash
npx -y -p dotloom-mcp pixel --version
npx -y dotloom-mcp --version
```

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

## 30 秒了解 CLI

文档操作只向 stdout 打印一个 JSON 对象，便于 CLI 与 Shell 脚本和 CI 组合；帮助信息和面向人类的命令列表使用纯文本。

```bash
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

工具目录由用于验证命令的同一套 Zod Schema 生成，因此文档不会与运行时行为脱节。

| 能力 | 作用 |
| --- | --- |
| `get_preview` | 返回单帧或全部帧的真实 PNG，可选择裁剪、缩放、隔离图层或洋葱皮显示。 |
| `preview_tilemap` | 渲染未烘焙的地图，可叠加瓦片网格、数字索引、无效单元格和变更区域。 |
| `apply_ops` | 批量执行编辑操作，支持原子回滚，并可在同一次往返中返回预览。 |
| `expectedVersion` | 通过版本冲突拒绝过期写入，避免覆盖更新的工作。 |
| `clip` | 将阴影、高光和抖动色带限制在轮廓或指定图层内。 |
| `add_palette_ramp` | 构建色相偏移的材质渐变，而不是简单的平面插值。 |
| `quality_report` | 报告光栅缺陷和构图证据，或分析瓦片地图的变体、重复、开放边缘和连通地形。 |
| `finalize_document` | 一次调用即可保存可编辑的 `.pixel` 源文件并写出所需的 PNG 导出。 |
| `run_script` | 将有时限的 JavaScript 批处理作为单个撤销步骤运行，并提供隔离 dry-run 和源码相对错误诊断。 |
| `load_plugin` | 将插件命令注册为实时 MCP 工具。 |

实用的 Agent 工作循环刻意保持简短：

```text
create_document → block silhouette → inspect PNG → shade in batches
      ↑                                                    ↓
quality_report ← fix warnings ← preview each visual gate → finalize_document
```

独立服务器通过 stdio 运行，不需要桌面应用。如果 Electron 应用已经运行，也可以连接到它的 loopback HTTP 端点：

```bash
dotloom-mcp --attach http://127.0.0.1:7331/mcp
```

连接后，GUI 和 Agent 会共享文档及撤销/重做历史：Agent 的编辑会重新绘制画布，人类的编辑也会立即对 Agent 可见。

## 创作工具箱

- **绘制** —— 铅笔、橡皮擦、直线、矩形、椭圆、多边形、油漆桶填充、颜色替换、裁剪，以及替换式重绘。
- **动画** —— 帧、时长、标签、播放、洋葱皮、整层平移、挤压/拉伸、GIF 和精灵图。
- **瓦片地图** —— 图块集、可编辑网格、曲线加权地形笔刷、稀疏/加权 16/47 过渡、alpha 边缘局部烘焙、网格/索引预览、地图感知诊断、逐瓦片游戏属性、独立地图对象，以及自包含的 Tiled `.tmj` 导出。
- **像素画技巧** —— 色相偏移渐变、调色板锁定、Bayer 和聚类抖动、选择性描边、去杂点，以及感知边角的抗锯齿。
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

## 作品展示

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

<table>
  <tr>
    <td width="50%"><img src="assets/lighthouse-reference.png" alt="详细灯塔参考图" /><br /><sub>光栅参考</sub></td>
    <td width="50%"><img src="assets/lighthouse-pixel.png" alt="原生像素画灯塔输出" /><br /><sub>原生像素画输出</sub></td>
  </tr>
</table>

## 架构

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

> **分发范围：** `dotloom-mcp@0.1.3` 发布 CLI、库入口和独立 MCP 服务器。本版本中的 Electron 应用仍以源代码形式提供；桌面安装程序不属于 npm tarball 的一部分。

## 安全与本地信任

- 独立 MCP 服务器使用 stdio，由本地 MCP 客户端控制。
- Electron HTTP 主机绑定到 `127.0.0.1`，仅供受信任的本地客户端使用。请勿将其暴露到外部或进行端口转发。
- MCP 工具可以读取、写入、导入和导出本地文件路径。请使用只拥有必要权限的操作系统用户运行服务器。
- 插件 JavaScript 沙箱的范围有意保持狭窄，但 MCP 工具本身不能替代操作系统权限控制。

## 文档

- [English README](README.md) — 英文项目介绍与完整使用说明
- [技术参考](docs/REFERENCE.md) — 命令目录、MCP 内部机制、脚本、动画、瓦片地图和设计决策
- [更新日志](CHANGELOG.md) — 发布历史和范围
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenCode MCP 配置](https://opencode.ai/v2/docs/mcp-servers/)

## 项目状态

`dotloom-mcp@0.1.3` 是当前可安装的 CLI/MCP 版本。

- [x] 核心文档模型、光栅器、命令总线、历史记录和原生序列化
- [x] PNG、精灵图、GIF、Aseprite 导入和 Tiled 导出
- [x] Electron 编辑器、动画、调色板、洋葱皮和瓦片地图
- [x] 独立 MCP 服务器、视觉资源、提示、诊断以及脚本/插件
- [x] 公开 npm 包和 CI 质量门禁
- [ ] 已签名的跨平台 Electron 安装程序

## 许可证

Copyright © 2026 Lonely-bear。基于 [Apache License 2.0](LICENSE) 发布。
