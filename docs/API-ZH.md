# 库 API

<p align="center">
  <a href="API.md">English</a> · <strong>中文</strong>
</p>

> 本文是权威版本。`API-ZH.md` 是它的中文镜像：两者内容不一致时，以本文为准，中文版
> 就是过期的那一份。

`dotloom-mcp` 是一条游戏资产管线。这份 API 面向游戏项目：在**构建期**用代码生成
精灵、图块集和动画，作为 `devDependency` 引入 —— 不用 GUI，不用 MCP 客户端，
没有人参与。

```bash
npm install --save-dev dotloom-mcp
```

需要 Node.js **22.13 或更高版本**。纯 ESM。不需要 Electron，不需要文档存储，
不需要运行中的应用，也没有配置步骤：导入模块，调用函数即可。

> AI Agent 通过 MCP 工具面（`pixel-mcp`）驱动这个产品；构建脚本通过这份 API 驱动
> 它。两者共享同一个引擎和同一份命令目录，而不是同一个接口，并且都受支持。
> MCP 工具面和完整命令列表见 [`REFERENCE.md`](REFERENCE.md)。

---

## 接口一览

八个导出。其中三个负责干活。

| 导出 | 层级 | 是什么 |
| --- | --- | --- |
| `buildSprite(spec)` | **稳定** | 从尺寸、渐变和一组 ops 构建单帧精灵。返回一个 `Sprite`。 |
| `buildAnimation(spec)` | **稳定** | 同上，外加帧数和动画标签。返回一个 `Sprite`。 |
| `exportAssets(sprite, plan)` | **稳定** | 把精灵渲染成成品文件，以字节返回。绝不写磁盘。 |
| `API_VERSION` | **稳定** | 本契约的版本号，字符串形式。见[版本策略](#版本策略)。 |
| `VERSION` | **稳定** | 包版本号，例如 `'0.4.2'`。 |
| `core` | 内部 | 完整的无界面引擎：`Sprite`、`Editor`、全部命令、绑定、瓦片地图、渐变、导入器、编解码器。 |
| `mcp` | 内部 | MCP 服务器及其面向 Agent 的工具面，在进程内运行。 |
| `script` | 内部 | 基于 `node:vm` 的脚本运行时，面向受信任的脚本和插件。 |

**稳定**导出就是契约。**内部**命名空间是逃生舱：真实存在、已经发布，也是 README
一直在写的东西，但不受 `API_VERSION` 保护。新代码不要走这条路 ——
见[版本策略](#版本策略)。

---

## 一个完整可运行的例子

把它存成项目里的 `tools/build-assets.mjs`，然后运行
`node tools/build-assets.mjs`。

```js
// tools/build-assets.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildAnimation, buildSprite, exportAssets } from 'dotloom-mcp';

const OUT = 'assets/generated';

/** Write whatever the plan produced, into OUT. The API returns bytes; the path is yours. */
async function emit(sprite, plan) {
  for (const file of exportAssets(sprite, plan)) {
    const path = join(OUT, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    console.log(`  ${file.path.padEnd(22)} ${String(file.bytes.length).padStart(6)} B  ${file.mediaType}`);
  }
}

/* 1. One sprite: a slime, blocked in as a silhouette then shaded. */
console.log('slime');
const slime = buildSprite({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime',
  layers: ['base', 'shade', 'outline'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  ops: [
    // base: the whole body in one flat mid-tone. This is the silhouette.
    { command: 'draw_ellipse', params: { layer: 'base', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },
    // shade: a contact band inside the silhouette, and two eyes.
    { command: 'draw_ellipse', params: { layer: 'shade', rect: { x: 4, y: 9, w: 8, h: 4 }, color: '#306230' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    // outline: a 1px border of the same shape, drawn last.
    { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
  ],
});
await emit(slime, { frames: true, sheet: true, source: true });

/* 2. A tagged animation: the same slime, bobbing. */
console.log('slime-idle');
const idle = buildAnimation({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime-idle',
  layers: ['base', 'shade', 'outline'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  frames: 4,
  frameDurationMs: 140,
  tags: [{ name: 'idle', from: 0, to: 3, direction: 'pingpong' }],
  ops: [0, 1, 2, 1].map((squash, frame) => ({
    command: 'draw_ellipse',
    // `frame` and `layer` address a cel exactly as they do in the CLI. Leave either out and
    // the bottom layer of frame 0 is filled in for you.
    params: { frame, layer: 'base', rect: { x: 2, y: 5 + squash, w: 12, h: 9 - squash }, color: '#8bac0f' },
  })),
});
await emit(idle, { sheet: { layout: 'grid', columns: 4 }, gif: { scale: 4 }, source: true });
```

输出：

```text
slime
  slime_0.png               143 B  image/png
  slime_sheet.png           143 B  image/png
  slime_sheet.json          895 B  application/json
  slime.pixel              1218 B  application/zip
slime-idle
  slime-idle_sheet.png      195 B  image/png
  slime-idle_sheet.json    2101 B  application/json
  slime-idle.gif            921 B  image/gif
  slime-idle.pixel         1498 B  application/zip
```

`ops` 里的每一条命令都是共享命令目录里真实存在的命令，自带校验 —— 所以
`list_commands` / `pixel://commands` 记录的正是 Agent 会用的同一批 ops，
`REFERENCE.md` 就是它们的手册。参数写错会报错，绝不会变成一个静默默认值。

---

## `buildSprite(spec)` / `buildAnimation(spec)`

两者都返回一个普通的 `Sprite`：没有会话，没有句柄，没有清理。拿它做什么由你
决定 —— `exportAssets`、`core.serializeSprite`，或者直接交给 `core` 命名空间。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `seed` | `number` | 本次构建分配的所有 id 的种子。省略即 `0`，而 `0` 是*依然*可复现的。 |
| `width`、`height` | `number` | 正整数。机器装得下多大就能用多大。 |
| `name` | `string` | 同时是导出路径默认的文件名词干。 |
| `palette` | `string[] \| Palette` | 显式颜色列表，或一个 `core.Palette`。默认 DawnBringer 16。 |
| `layers` | `string[]` | 从底向上，例如 `['base', 'shade', 'outline']`。 |
| `background` | `ColorInput \| null` | 填充每一帧的底层图层。省略则透明。 |
| `paletteLocked` | `boolean` | 把每一次上色吸附到最近的色板上。 |
| `ops` | `AssetOp[]` | `{command, params?, label?}`，在共享总线上按顺序执行。 |
| `frames` | `number` | *仅 `buildAnimation`。* 默认 1。 |
| `frameDurationMs` | `number` | *仅 `buildAnimation`。* 默认 100。逐帧时序用一条 `set_frame_durations` op。 |
| `tags` | `AnimationTagSpec[]` | *仅 `buildAnimation`。* `{name, from, to, direction?, repeat?}`，0-based 且含端点。 |

**Ops。** `params.layer` 和 `params.frame` 定位图层和帧的方式与 CLI 完全一致。
省略它们，最底层图层和第 0 帧会被自动补上 —— 与 MCP 工具面和脚本用的是同一条
规则、同一个 core 里的函数，所以构建脚本和 Agent 写出的 ops 长得一模一样。

**不接受渐变名。** `'dawnbringer16'` 是给 Agent 的便利手段：短名字对 Agent 有
好处，间接一层也不亏。构建脚本不需要：渐变最终会出现在你的产物里，而
`core.DAWNBRINGER_16` 一次导入就能拿到。

**调色板角色是 op，不是字段。** `add_palette_ramp` 接受一个 `role`，
`ensure_palette_role` 和 `shade_band` 都绑定到它：

```js
{ command: 'add_palette_ramp', params: { from: '#2b1f3d', to: '#e8b98a', steps: 5, hueShift: 12, role: 'skin' } }
```

**错误。** 每一次拒绝都是一个带 `code` 的 `core.CommandError` ——
`invalid_params`、`unknown_command`、`command_failed` —— 所以按 code 分支，
不要去解析文案。失败的 op 的消息里会写明它在 `ops` 中的下标：

```text
ops[2] (draw_ellipse) failed: Command draw_ellipse failed: Frame index out of range: 1
```

---

## `exportAssets(sprite, plan)`

把一个精灵渲染成成品文件并以字节返回。它不读也不写：路径、目录、zip、CDN
都由你决定。

```ts
interface AssetFile {
  path: string;        // 'knight_sheet.png', safe to join onto any root
  bytes: Uint8Array;
  mediaType: string;   // 'image/png' | 'application/json' | 'image/gif' | 'application/zip'
  kind: 'frame' | 'sheet' | 'sheet-json' | 'gif' | 'source';
}
```

| plan 字段 | 产出 |
| --- | --- |
| `frames: true` | 每帧一张 PNG：`<name>_0.png`、`<name>_1.png`…… 0-based。 |
| `sheet: true` | `<name>_sheet.png` 加上 `<name>_sheet.json`，即 Aseprite 帧表。 |
| `sheet: {layout, columns, padding, margin}` | 同上，布局选项来自 `core.buildSpritesheet`。 |
| `gif: true` / `gif: {tag, scale, loop, …}` | 某个标签或整条时间线的 `<name>.gif`。 |
| `source: true` | `<name>.pixel` —— 可编辑归档，一份清单加每个 cel 一张 PNG 的 zip。 |
| `name` | 文件名词干。默认取精灵名，分隔符和空格折叠成 `-`。 |
| `scale` | 所有渲染产物的整数倍放大。不影响 `source`。 |
| `background` | 在精灵后面填充底色，而不是留透明。 |

没有默认 plan。一个什么都没选的 plan 会抛错，而不是返回空数组 —— 一个什么
文件都没产出却报告成功的构建，是最糟的结果。精灵图故意是两个文件：PNG 是
引擎用来切片的，JSON 是用来告诉引擎每一帧在哪里、持续多久、属于哪个标签的。

帧表描述的是*放大后*的精灵图 —— `scale` 作用在图集上而不是图像上，所以
矩形、图集尺寸和像素永远互相吻合。

---

## 确定性契约

**同样的输入，同样的字节。任何时候、任何进程、任何机器。**

这是让构建期生成资产这件事成立的前提：一个提交进仓库的资产必须是其源代码
的函数，所以一次 diff 意味着*画面变了*，永远不意味着*这次运行变了*。这一点
是被强制的，不是口头承诺：

- `buildSprite` 和 `buildAnimation` 会在调用期间装上一个带种子的 id 工厂，
  因此 `.pixel` 清单里携带的图层、帧、调色板和标签 id 是 `seed` 的函数，
  而不是时钟的函数。
- 每一条 op 都走共享命令总线，而总线把它所有的随机性都取自 core 的
  `rng.ts`。绘制路径里没有 `Math.random()`。
- 调用返回时 id 工厂会被**移除**，进程回到一个全新进程应有的状态。如果你用
  `core.setIdFactory` 装过自己的工厂，事后要重新装回去。
- `exportAssets` 不分配 id、不查时钟：它是 `(sprite, plan)` 的纯函数。
- `.pixel` 序列化逐字节可复现，zip 条目的时间戳被固定。

两个 `seed` 相同的构建产出完全相同的字节，包括 `.pixel` 归档和精灵图 JSON。
一个不同的 `seed` 产出不同的字节。这条断言的两半都写在
`packages/core/test/npm-surface.test.ts` 里 —— 因为单说「同样的 seed、
同样的字节」的话，一个空缓冲区就能满足。

要把它当成回归检查，就重新构建并比对字节，而不是用眼睛看图。把 spec 放进
它自己的模块，这样画面一动，构建就会失败。

```js
// tools/check-assets.mjs
import { readFile } from 'node:fs/promises';
import { buildSprite, exportAssets } from 'dotloom-mcp';
import { SLIME } from './slime-spec.mjs'; // the same spec tools/build-assets.mjs used

const [rebuilt] = exportAssets(buildSprite(SLIME), { source: true });
const committed = await readFile('assets/generated/slime.pixel');
if (!Buffer.from(rebuilt.bytes).equals(committed)) {
  console.error('slime.pixel changed — review the diff before committing it');
  process.exit(1);
}
console.log('slime.pixel is byte-identical to the committed file');
```

---

## 版本策略

两个版本号，它们的区别很重要。

| | `VERSION` | `API_VERSION` |
| --- | --- | --- |
| 跟踪什么 | 包本身的发布版本。 | 稳定导出的形状。 |
| 什么时候提升 | 每次发布。 | `buildSprite`、`buildAnimation`、`exportAssets` 或它们接受的类型发生破坏性变更时。 |
| 用来做什么 | 报 bug。 | 钉住你的构建脚本。 |

**稳定** —— `buildSprite`、`buildAnimation`、`exportAssets`、`VERSION`、
`API_VERSION`。在 `API_VERSION` 的同一个主版本内，唯一允许的变更都是**新增**：
一个新导出、一个新的可选 plan 字段、一个新的可选 spec 字段、一个被放宽的
接受类型。重命名、删除、调整顺序，或者把一个可选字段变成必填，都是破坏性
变更，会把 `API_VERSION` 提升到下一个主版本。

**内部** —— `core`、`mcp`、`script`。它们已发布、有文档，也是引擎全部威力
所在。它们不受 `API_VERSION` 保护，并且可能在一次小版本发布里改变，因为
它们是刻意镜像本仓库自身的包布局的：这种耦合正是任务形接口面要消除的东西，
为它承诺稳定是不诚实的。当三个稳定函数覆盖不了某件事时，它们是正确的工具；
但它们不是正确的默认选择。

**完全没有覆盖的部分：** 三个稳定函数*返回值*的内部结构。`Sprite` 是一个
`core` 类型，而这份 API 除了 `docs/REFERENCE.md` 记录的内容之外，不对
`Sprite` 的形状作任何承诺。其中你真正该用的部分 —— `width`、`height`、
`frames`、`layers`、`tags`、`palette` —— 和 `core` 的其余部分一样稳定。如果你
开始读 `sprite.rig.tweens[0].easing`，那就是进到内部区域了。

---

## 配方会接在这里

一个配方就是同形状的函数，建立在这三个之上，与它们并排导出：

```js
import { buildAnimation, exportAssets } from 'dotloom-mcp';

export function buildPlatformerTileset({ tileSize = 16, seed = 1, columns = 8 } = {}) {
  const sprite = buildAnimation({ seed, width: tileSize * columns, height: tileSize * columns, /* … */ });
  return sprite;
}
```

配方落地时，下面这个接口面不会有任何变化。`API_VERSION` 保持为 `1`。

## 有意不做的事

- **`buildCharacter({brief, directions})`。** 配方需要一个大模型或一个人把散文
  变成 ops，所以它是异步的，而且它是配方（T-030+），不是库原语。它接入的
  接缝就是 `buildAnimation` + `exportAssets`。
- **配方目录，或 `describe_recipe`。** 那是 T-030/T-036。
- **把多个精灵融进同一张图集。** `exportAssets` 只接收一个 `Sprite`，因为标签
  和帧元数据该怎样跨文档合并是 T-043 的决策，不是可以猜的东西。用
  `buildAnimation` 构建一段动画，精灵图本身就已经是一个文件了。
- **写文件、目录、glob、watch 模式、缓存键、资产清单。** `exportAssets` 返回
  字节；字节去哪里是构建脚本的事，而且这些选择每一个都更适合交给项目本来就
  有的构建系统去做。
- **为发布产物提供 typedef。** npm 包发布的是 JavaScript。这里的类型是文档和
  编辑器辅助，不是分发渠道。
