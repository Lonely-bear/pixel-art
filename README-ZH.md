<div align="center">
  <img src="assets/pixel-mark.svg" width="88" alt="dotloom-mcp 标志" />
  <h1>dotloom-mcp</h1>
  <p><strong>用手、用脚本，或者直接让 AI agent 画出可以直接进游戏的像素画。</strong></p>
  <p>一套引擎、一份文档模型、三种客户端：Electron 编辑器、<code>pixel</code> 命令行，以及一个 Model Context Protocol 服务器。</p>
  <p>
    <a href="https://www.npmjs.com/package/dotloom-mcp"><img src="https://img.shields.io/npm/v/dotloom-mcp?label=npm&logo=npm&style=flat-square" alt="npm 版本" /></a>
    <a href="https://github.com/Lonely-bear/pixel-art/stargazers"><img src="https://img.shields.io/github/stars/Lonely-bear/pixel-art?style=flat-square&label=stars" alt="GitHub stars" /></a>
    <img src="https://img.shields.io/github/forks/Lonely-bear/pixel-art?style=flat-square&label=forks" alt="GitHub forks" />
    <a href="LICENSE"><img src="https://img.shields.io/github/license/Lonely-bear/pixel-art?style=flat-square" alt="许可证" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.13-5fa04e?style=flat-square" alt="Node.js 22.13 或更新" />
  </p>
</div>

<p align="center">
  <a href="README.md">English</a> · <a href="README-ZH.md">中文</a>
</p>

## 这是什么

你描述一个精灵——"一个 32×32 的骑士，带披风，两帧待机，十二种颜色"——它就变成一份真正可用的游戏素材：可索引的调色板、图层名、帧标签、碰撞盒、一份可以提交的 `.pixel` 源文件，以及 PNG、精灵图集、GIF 或 Tiled 输出。你可以在编辑器里做，可以在 shell 脚本里做，也可以让一个 AI agent 来做。三者驱动的是同一套命令、同一份文档，所以撤销、历史、导出和编辑器窗口之间永远不会各说各话。它是游戏素材流水线，而不是图像生成器：像素素材是量化的、严格对齐网格的产物，带着一份技术契约，命令、文件格式和导出都是围绕这份契约而不是围绕画面设计的。

它也会告诉你这张图画错了什么。不是画得好不好——这个产品里没有分数、没有评级、没有任何数字，这是刻意的——而是评审会指出的那些具体的、定位到区域的缺陷：(11, 18) 处一个 2×3 的本该填实的洞，一侧 4px 粗、另一侧 2px 粗的轮廓，43 个和周围任何东西都对不上的像素。而当某个维度无法测量时，它会直说无法测量并给出原因，而不是悄悄拿一个高分。

## 作品展示

下面八件作品来自 [`showcase/`](showcase/)，每一件都只通过对外公布的 MCP 工具列表绘制——没有库导入，没有直接操作编辑器。说明文字就是流水线对每一件作品的报告；零缺陷的作品也在表里，这是有意为之。

<table>
  <tr>
    <td width="50%" align="center"><img src="showcase/gallery/out/sunset-lighthouse-512.png" alt="Sunset Lighthouse，512x512 像素画" width="260" /><br><sub><b>Sunset Lighthouse 512</b> — 512×512，10 个图层，1 个具名缺陷</sub></td>
    <td width="50%" align="center"><img src="showcase/gallery/out/dusk-lake-valley-agent.png" alt="Dusk Lake Valley，256x256 像素画" width="260" /><br><sub><b>Dusk Lake Valley Agent</b> — 256×256，3 个缺陷，其中一个被报告称为流水线中最可能的误报</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="showcase/gallery/out/dusk-lake-valley-agent2.png" alt="同一场景的干净版本" width="260" /><br><sub><b>Dusk Lake Valley Agent2</b> — 同一场景的干净画法。作为负对照：<b>0 个缺陷</b>，这正是其他缺陷为真的证明</sub></td>
    <td width="50%" align="center"><img src="showcase/gallery/out/dusk-lake-valley-v3.png" alt="黄昏湖景的第三版" width="260" /><br><sub><b>Dusk Lake Valley V3</b> — 第三版，图层降到四层；只剩一条建议项，而它按设计就是建议项</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="showcase/gallery/out/moonlit-alpine-lake.png" alt="月光下的高山湖泊，64x64 像素画" width="200" /><br><sub><b>Moonlit Alpine Lake</b> — 64×64，3 个缺陷，其中包括 43 个游离像素</sub></td>
    <td width="50%" align="center"><img src="showcase/gallery/out/moonlit-alpine-lake-fast.png" alt="同一片 64x64 湖泊的更快版本" width="200" /><br><sub><b>Moonlit Alpine Lake Fast</b> — 同样的活儿、同样的尺寸，却触发了 <code>hue-sprawl</code>，而更大的那幅没有：这是报告点名的长期空白，不是这张画的缺陷</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="showcase/gallery/out/ironhold-knight.png" alt="Ironhold Knight，一个披甲英雄精灵" width="200" /><br><sub><b>Ironhold Knight</b> — 64×64 披甲英雄，带披风与巨剑，5 个缺陷各自定位到区域</sub></td>
    <td width="50%" align="center"><img src="showcase/gallery/out/verify--lantern-keeper.png" alt="Lantern Keeper，一个 32x32 角色精灵" width="160" /><br><sub><b>Lantern Keeper</b> — 32×32，6 个缺陷。由一个起初连任何绘图命令都没有的 agent 画出，它是靠 <code>list_commands</code> 找到那些命令的</sub></td>
  </tr>
</table>

其余四张渲染图、每一件的逐条缺陷报告，以及每件作品的可复现配方，都在
[`showcase/gallery/gallery.json`](showcase/gallery/gallery.json) 和
[`showcase/`](showcase/) 里。

## 安装

npm 包需要 **Node.js 22.13 或更新版本**。桌面应用除操作系统外不需要任何运行环境。

**桌面应用** —— Windows、macOS、Linux 的安装包都在
[GitHub Releases](https://github.com/Lonely-bear/pixel-art/releases/latest)，其中 Windows 还有免安装的便携版。MCP 服务器内置在同一个二进制里，所以通过 npm 安装的服务器能自动找到正在运行的编辑器，并编辑同一批文档。这些构建尚未做代码签名：macOS 首次启动需要右键 → 打开，Windows SmartScreen 会警告一次。

**命令行与 MCP 服务器** —— 一个包，四个 bin 名字（`dotloom-mcp`、`pixel`，以及兼容别名 `pixel-mcp` / `pixel-art-mcp`）：

```bash
npm install -g dotloom-mcp     # 或者作为构建期依赖：
npm install -D dotloom-mcp

dotloom-mcp --version
pixel --version
```

一次性使用不需要全局安装：

```bash
npx -y dotloom-mcp --version
npx -y dotloom-mcp pixel --version
```

**MCP 客户端** —— 加一个 server 配置块。macOS 与 Linux：

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

在 Windows 上要换掉前两个字段——`npx` 不是 Windows 能在没有 shell 的情况下启动的可执行文件，而 Node 也拒绝直接运行 `.cmd` 垫片，所以启动必须走 `cmd.exe`：

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

Claude Desktop、Claude Code、Cursor、Windsurf 和 OpenCode 的确切文件路径（OpenCode 用的是 `mcp` 而不是 `mcpServers`），以及一个三步检查，用来区分"已连接"和"已连接且正在内存中运行"，见 [`docs/CLIENTS.md`](docs/CLIENTS.md)（[中文](docs/CLIENTS-ZH.md)）。

## 它能做什么

**绘制与编辑。** 编辑器里有像素级精确的画布、图层、帧、洋葱皮、调色板和动画播放。铅笔、直线、矩形、椭圆、多边形、油漆桶填充、颜色替换、裁剪、色相偏移的调色板渐变、Bayer 与聚类抖动、选择性描边、去斑点，以及感知角落的抗锯齿。

**动画。** 帧、批量时长、批量标签、GIF 与精灵图集导出。持久化的角色骨架——部件、姿势、补间、锚点、碰撞盒——带姿势与播放预览，以及由一张画派生出八方向角色。

**构建瓦片地图。** 图块集、可编辑网格、带权重的曲线地形笔刷、稀疏与加权 16/47 转场、alpha 边缘局部烘焙、每格玩法属性、地图对象，以及自包含的 Tiled `.tmj` 导出。

**看清你到底画出了什么。** `read_grid` 把画面按字符网格返回——剪影、亮度、调色板槽位或颜色名——因此它是精确的、可 diff 的、廉价的，而且重复调用会报告哪些行变了。`get_preview` 返回真正的 PNG，可裁剪、放大、隔离图层、加洋葱皮。一个用来验证，一个用来验收；这个划分是刻意的，因为缩略后的 PNG 没法告诉你第 14 行是不是比第 13 行差一级。

**被告知哪里不对，而不是有多好。** `evaluate` 给出具体的、定位到区域的缺陷，带代码、区域和修复方式——或者什么都不报告。无法测量的维度会被报告为未测量并说明原因，绝不会被当成满分。这里没有总分，而且以后也不会有：交给模型的"质量分"会变成目标而不是画面，所以一个 `quality_report` 工具曾经存在过，后来被删掉了。

**读写真实格式。** `.pixel`（一个普通 zip：一份 JSON 清单加每个 cel 一张 PNG，条目时间戳被固定，因此同一份文档序列化出的字节完全相同）、PNG、Aseprite `.ase` 导入、精灵图集加 Aseprite 兼容 JSON、动态 GIF、Tiled `.tmj`。

**自动化。** 以 JSON 为主的设计的命令行、与 MCP 服务器完全相同的批量 ops 载荷，以及一个受限的 `node:vm` 脚本沙箱——整个脚本算一步撤销。`list_commands` 会打印完整的命令目录及其 JSON Schema，因此客户端无需文档即可发现一切。

## 使用

得到一张可见 PNG 的最短路径——不需要输入文件、不需要调色板、不需要参数：

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
  "canvas": { "width": 32, "height": 32 },
  "scale": 8,
  "palette": 10,
  "layers": ["Base", "Shade", "Light", "Crown", "Face", "Outline"],
  "frames": 2,
  "tags": ["idle"],
  "commands": 33,
  "bytes": 4675
}
```

一个成品的 32×32 精灵——十种颜色、六个图层、`idle` 标签上的两帧、由 33 条命令画出——用最近邻放大 8 倍，旁边就是一份能在编辑器里打开的 `.pixel`。上面这段记录就是本仓库构建产物原样输出，未作修改。每个文档操作恰好打印一个 JSON 对象，因此它像别的命令一样能拼进 shell 脚本。

`pixel new` 创建文档，`pixel apply --ops ops.json` 执行批量操作，`pixel export`、`pixel sheet`、`pixel gif`、`pixel tiled`、`pixel thumb` 写出各种输出格式。完整列表见 `pixel --help`。

**作为 agent**，这个服务器就是你的客户端已经会读的工具列表。stdio 上的 `tools/list` 返回 **38 个入口工具**——这是实测数字，也是一条由测试守护的预算上限，不是承诺。它们背后的命令目录（101 条命令：`draw_ellipse`、`add_palette_ramp`、`outline`、`stroke_tilemap`、`autotile`、骨架、瓦片地图）一开始并不在这个列表里；agent 通过 `list_commands`、`describe_command`、`find_workflow` 或 `apply_ops` 找到它们，而一条命令一旦被本次会话碰到，就成为可以直接调用的工具。工具列表及其参数每个会话都会重建——请读你这次拿到的 schema，而不是从文档里抄来的。

不带参数启动时，服务器会在 loopback 接口上寻找正在运行的编辑器并把请求转发过去，于是 agent 和窗口共享文档与同一份撤销历史；没有编辑器时，它就在内存里提供同一套引擎，并在之后有编辑器出现时自动重连。

```bash
dotloom-mcp                                        # 优先使用应用，并继续寻找
dotloom-mcp --attach http://127.0.0.1:7331/mcp     # 钉住一个端点，失败即报错
dotloom-mcp --standalone                           # 完全跳过发现
```

## 集成

三条入口，承诺程度依次递增。

**库。** 把它作为 `devDependency`，在构建脚本里生成素材——无 GUI、无 MCP 客户端、无人参与。九个导出是稳定的，由 `API_VERSION` 覆盖；其余都不稳定。API 返回字节，从不碰磁盘，所以字节去哪里是你的构建脚本自己的事，而且同一个种子每次都给出同样的字节。

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

类型随包一起发布，所以打错的调用会变成编译错误。什么是稳定的、什么是内部的、一个主版本可以破坏什么，写在 [`docs/STABILITY.md`](docs/STABILITY.md) 里；这些函数在 [`docs/API.md`](docs/API.md)（[中文](docs/API-ZH.md)），五个可运行、按字节比对的例子在 [`docs/COOKBOOK.md`](docs/COOKBOOK.md)（[中文](docs/COOKBOOK-ZH.md)），真实文件在 [`cookbook/`](cookbook/)。

**素材契约。** 一个导出目标就是这份契约之上的一层渲染器：引擎文件加上一份可以校验、也可以被别的工具读取的 `meta.json`。Godot、Unity、Phaser 和 Excalidraw 四个导入器都基于它。[`docs/ASSET-CONTRACT.md`](docs/ASSET-CONTRACT.md)（[中文](docs/ASSET-CONTRACT-ZH.md)）是契约本身，[`docs/IMPORTERS.md`](docs/IMPORTERS.md) 是四条导入路径。

**CI。** 只在你笔记本上跑的构建脚本，等于没人评审的构建。这个 Action 会在 pull request 上运行它，并在素材不对时让任务失败——一个坏掉的 op、一次字节可复现性检查，或者可选的一条阻塞性具名缺陷。它报告具名缺陷，绝不报告数字，因为一条打印分数的 CI 日志会把那个分数变成目标。

```yaml
- uses: dotloom-mcp/build-assets@v1.0.0
  with:
    command: node tools/build-assets.mjs
    check-command: node tools/check-assets.mjs
    quality-gate: blocking
```

[`docs/ACTION.md`](docs/ACTION.md)（[中文](docs/ACTION-ZH.md)）列出了每一个输入、第一次运行会遇到什么坑，以及文档被拒绝时该做什么。

## 文档

从 [`docs/README.md`](docs/README.md) 开始，它索引了全部文档。

| 你是… | 请读 |
| --- | --- |
| 要集成游戏引擎，想知道哪些可以依赖 | [`STABILITY.md`](docs/STABILITY.md)，然后 [`API.md`](docs/API.md) |
| 要针对 npm 包写构建脚本 | [`API.md`](docs/API.md)，然后 [`COOKBOOK.md`](docs/COOKBOOK.md) |
| 要产出或消费导出的素材 | [`ASSET-CONTRACT.md`](docs/ASSET-CONTRACT.md) |
| 要从别的工具导入画面 | [`IMPORTERS.md`](docs/IMPORTERS.md) |
| 要配置 MCP 客户端 | [`CLIENTS.md`](docs/CLIENTS.md) |
| 要分享一个包或一次评审 | [`ACTION.md`](docs/ACTION.md)、[`SHARING.md`](docs/SHARING.md) |
| 要查某条命令、某个脚本或瓦片地图模型 | [`REFERENCE.md`](docs/REFERENCE.md) |
| 好奇流水线如何下判断 | [`dev/EVALUATION.md`](dev/EVALUATION.md) |

贡献者与 agent 用的材料——仓库布局、构建串行规则、如何验收工作，以及已锁定的产品决策——在 [`AGENTS.md`](AGENTS.md) 和 [`dev/`](dev/)。变更日志：[`CHANGELOG.md`](CHANGELOG.md)（[中文](CHANGELOG-ZH.md)）。

## 本地信任

独立 MCP 服务器使用 stdio，由你的 MCP 客户端控制。Electron 的 HTTP 宿主绑定 `127.0.0.1`，面向可信的本地客户端——不要暴露或做端口转发。MCP 工具可以读写、导入和导出本地文件路径，所以请以你只打算授予的那些权限去运行服务器。脚本与插件的 JavaScript 沙箱刻意做得很窄，但它不是针对不可信代码的安全边界。

## Stars

[![Star History Chart](https://api.star-history.com/svg?repos=Lonely-bear/pixel-art&type=Date)](https://star-history.com/#Lonely-bear/pixel-art&Date)

## 许可证

Copyright © 2026 Lonely-bear. 基于 [Apache License 2.0](LICENSE) 发布。
