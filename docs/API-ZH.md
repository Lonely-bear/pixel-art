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

十二个导出。其中七个负责干活。

| 导出 | 层级 | 是什么 |
| --- | --- | --- |
| `buildSprite(spec)` | **稳定** | 从尺寸、渐变和一组 ops 构建单帧精灵。返回一个 `Sprite`。 |
| `buildAnimation(spec)` | **稳定** | 同上，外加帧数和动画标签。返回一个 `Sprite`。 |
| `exportAssets(sprite, plan)` | **稳定** | 把精灵渲染成成品文件，以字节返回。绝不写磁盘。 |
| `getDirectionModel(canvas, anchor?)` | **稳定** | 某个画布上的八方向角度模型：哪四个是精确的、哪四个必须画、每个方向落在哪里。只读。 |
| `buildWalkAnimation(spec)` | **稳定** | 一个 `AnimationSpec` 外加一个方向和一套步态。把 `generate_walk_cycle` 接在你的 ops 之后，返回 `Sprite`。 |
| `exportEngineAssets(sprite, plan)` | **稳定** | `meta.json` 加上某个引擎的文件，以字节返回，并附带有损清单。绝不写磁盘。 |
| `traceSvg(spec)` | **稳定** | 一个 `SpriteSpec` 外加一段 SVG 轮廓：建好文档，然后把矢量扫描到像素网格上。 |
| `API_VERSION` | **稳定** | 本契约的版本号，字符串形式。见[版本策略](#版本策略)。 |
| `VERSION` | **稳定** | 包版本号，例如 `'0.5.0'`。 |
| `core` | 内部 | 完整的无界面引擎：`Sprite`、`Editor`、全部命令、绑定、瓦片地图、渐变、导入器、编解码器。 |
| `mcp` | 内部 | MCP 服务器及其面向 Agent 的工具面，在进程内运行。 |
| `script` | 内部 | 基于 `node:vm` 的脚本运行时，面向受信任的脚本和插件。 |

**稳定**导出就是契约。**内部**命名空间是逃生舱：真实存在、已经发布，也是 README
一直在写的东西，但不受 `API_VERSION` 保护。新代码不要走这条路 ——
见[版本策略](#版本策略)。

### 类型

这个包自带类型声明，所以这份文件不只是文档：TypeScript 使用者在 `import` 的时候
就能拿到下面的签名，写错调用是编译错误，而不是运行时的意外。

```ts
import { buildSprite, type SpriteSpec, type ExportPlan } from 'dotloom-mcp';
```

解析走包的 `exports` 映射：

| 说明符 | 是什么 |
| --- | --- |
| `dotloom-mcp` | 稳定接口面；为了向后兼容，也包含那三个内部命名空间。 |
| `dotloom-mcp/internal` | 同一个模块，但显式地命名为逃生舱。适合放在 `tsconfig` 的 `imports` 别名里，或者用一条 lint 规则声明「这个构建脚本允许去摸 `core`」。 |
| `dotloom-mcp/package.json` | 清单文件，给需要读版本号的构建脚本用。 |

其他任何写法 —— `dotloom-mcp/dist/index.js`、`dotloom-mcp/dist/index.js.map` —— 都**没有**
被导出，也解析不了。这正是这张映射表的意义：层级边界写在一个工具能强制执行的地方，
而不是只写在本文档里一句没人检查的话。`packages/core/test/npm-consumer-types.test.ts`
会对打包产物编译一个使用方，并断言两半：文档里的名字都能解析，没声明的说明符不能。

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
- `exportAssets` 和 `exportEngineAssets` 不分配 id、不查时钟：它们是
  `(sprite, plan)` 的纯函数。资产契约不带时间戳，也不编造 `uid://`，而命名报告是
  名字的纯函数。
- `getDirectionModel` 是纯函数、不查时钟：系数全是整数，没有三角函数，所以矩阵在任何
  机器上都逐位相同。
- `buildWalkAnimation` 继承另外两个构建函数同样的带种子 id 作用域 —— 步态命令分配的帧
  id 和标签 id 是 `seed` 的函数。
- `traceSvg` 用 Cody-Waite 区间规约加 fdlibm minimax 核，而不是 `Math.sin`，理由同上：
  V8、JSC 和 SpiderMonkey 在最后一位 ULP 上可能有分歧，而一个在两个引擎之间差一个
  像素的轮廓，不是任何人能靠截图调试的 bug。
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
| 什么时候提升 | 每次发布。 | 任何一个稳定导出发生破坏性变更时：重命名、删除、新增必填字段，或类型被收窄。 |
| 用来做什么 | 报 bug。 | 钉住你的构建脚本。 |

**稳定** —— `buildSprite`、`buildAnimation`、`exportAssets`、`getDirectionModel`、
`buildWalkAnimation`、`exportEngineAssets`、`traceSvg`、`VERSION`、`API_VERSION`。
在 `API_VERSION` 的同一个主版本内，唯一允许的变更都是**新增**：一个新导出、一个新的
可选 plan 字段、一个新的可选 spec 字段、一个被放宽的接受类型。重命名、删除、调整
顺序，或者把一个可选字段变成必填，都是破坏性变更，会把 `API_VERSION` 提升到下一个
主版本。

这就是 `getDirectionModel`、`buildWalkAnimation`、`exportEngineAssets` 和 `traceSvg`
发布时没有提升版本号的原因：四个新名字，没有删除，也没有签名变化。
`packages/core/test/npm-surface.test.ts` 钉住了这份清单，并在旁边钉住 `API_VERSION`，
所以「只有新增」是一个被检查的断言，而不是一个意图。

**`exports` 映射表是契约的一部分。** `.` 是稳定接口面，`./internal` 显式地命名
逃生舱，`./package.json` 是清单，其他什么都解析不了。新增一个子路径是新增；删除一个
是破坏性的，因为导入过它的构建脚本就编不过了。

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
- **配方目录，或 `describe_recipe`。** 两者都已存在，而且都不在这里，这是刻意的：配方是给
  Agent 读的一段文字，所以它由 MCP 服务器的 `describe_recipe` 工具和
  `pixel://recipe/{id}` 资源提供；npm 包附带的是 `recipes/` 目录，而不是一个返回它们的
  库函数。
- **把多个精灵融进同一张图集。** `exportAssets` 只接收一个 `Sprite`，因为标签
  和帧元数据该怎样跨文档合并是 T-043 的决策，不是可以猜的东西。用
  `buildAnimation` 构建一段动画，精灵图本身就已经是一个文件了。
- **写文件、目录、glob、watch 模式、缓存键、资产清单。** `exportAssets` 和
  `exportEngineAssets` 返回字节；字节去哪里是构建脚本的事，而且这些选择每一个都更适合
  交给项目本来就有的构建系统去做。
- **一次调用产出整套八方向角色。** `getDirectionModel` 告诉你一套八方向角色其实
  需要画哪三张 —— 八个方向里有四个是精确变换，完全不需要新图 —— 而
  `buildWalkAnimation` 烘焙其中一个方向。把八个拼起来仍然是一个循环，因为一套八方向
  角色是*三张*由人画的图，而选哪三张正是配方该做的决策，不是库原语该做的。

---

## `getDirectionModel(canvas, anchor?)`

只读、纯派生。它不写任何东西、不分配 id，可以在构建脚本的规划阶段安全调用 —— 在
任何东西被画出来之前。

```js
const model = getDirectionModel({ width: 32, height: 32 });
model.exact;        // ['N', 'E', 'S', 'W']     —— 变换可精确复现
model.approximate;  // ['NE', 'SE', 'SW', 'NW'] —— 对角线，必须画
model.pivot;        // { x: 15.5, y: 31 }       —— 底边中心，即 `ground`
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `baseDirection` | `'E'` | 基础姿势的朝向。其余一切都由它派生。 |
| `anchor` | `'ground' \| 'facing' \| 'origin'` | 每个方向都保持不动的那个点，所以转向是原地转而不是在画布上滑动。默认 `ground`，即脚下的接触点。 |
| `pivot` | `{x, y}` | 该锚点在这个画布上的位置。 |
| `exact` | `DirectionId[]` | 四分之一转和/或镜像可精确复现的方向。不需要画。 |
| `approximate` | `DirectionId[]` | 对角线。不存在像素精确的 45° 变换，本引擎也不会去近似一个。 |
| `directions` | `DirectionSummary[]` | 全部八个，从 N 顺时针：`facing`、`drawing`、`resolvedFrom`，以及画布上的 `matrix`。 |

`N` 是屏幕向上，`S` 是屏幕向下。在俯视地图上屏幕向上是*远离*摄像机，所以如果你要
「`N` 面向观众」那种正面视角的读法，去直接用底层工具，把这两行换掉就行。

每个矩阵的系数都是整数：四分之一转是坐标轴的一个带符号置换，镜像则把其中一行取负。
模型里任何地方都没有三角函数 —— 这正是 `packages/core/test/determinism.test.ts`
把 `Math.sin` 之类从 `src` 里禁掉的原因：V8、JSC 和 SpiderMonkey 在最后一位
ULP 上可能有分歧，而一个在两个引擎之间差一个像素的矩阵，不是任何人能靠截图调试的 bug。

---

## `buildWalkAnimation(spec)`

就是 `buildAnimation` 再加一条 `generate_walk_cycle` 命令，并且这条命令**接在你的
ops 之后**，这样绑定和静止姿势会在步态被烘焙之前就存在。一次调用生成一个方向。

```js
const walk = buildWalkAnimation({
  seed: 7, width: 32, height: 32, name: 'hero',
  layers: ['body', 'legL', 'legR'],
  direction: 'S',
  walk: { frames: 6, stride: 3 },
  ops: [
    {
      command: 'create_rig',
      params: {
        parts: [
          { name: 'body', pivot: { x: 16, y: 10 } },
          { name: 'legL', pivot: { x: 14, y: 20 }, parent: 'body' },
          { name: 'legR', pivot: { x: 18, y: 20 }, parent: 'body' },
        ],
      },
    },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 12, y: 8, w: 8, h: 12 }, color: '#8bac0f' } },
    { command: 'draw_rect', params: { layer: 'legL', rect: { x: 13, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
    { command: 'draw_rect', params: { layer: 'legR', rect: { x: 17, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
  ],
});
```

`AnimationSpec` 的每个字段都被继承。此外：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `direction` | `DirectionId` | 默认 `E`，即基础朝向。对角线会落到离它最近的那个基本方向上，命令的结果里会写明。 |
| `anchor` | `DirectionAnchorName` | 默认 `ground`。 |
| `pivot` | `{x, y}` | 显式的朝向支点，覆盖 `anchor`。 |
| `walk.frames` | `number` | 一个步态周期的帧数。偶数读起来更好：一个周期有两次触地。默认 4。 |
| `walk.frameDurationMs` | `number` | 默认 120。 |
| `walk.stride` | `number` | 脚部水平位移的峰值，单位像素。默认 2。 |
| `walk.bob` | `number` | 身体起伏的峰值，单位像素。默认 1。 |
| `walk.legSwingDegrees` | `number` | 摆动两端腿部的倾角峰值。默认 6。 |
| `walk.legs` / `arms` / `body` | `string[]` | 绑定部件的名字或 id。省略则按名字自动识别（`leg`/`foot`、`arm`/`hand`、`body`/`torso`）。 |
| `walk.phaseOffset` | `number` | 在第 0 帧之前整体前进的整帧数，用来把一个循环相对另一个错开。 |
| `walk.tagName` | `string` | 默认 `walk_<方向小写>`。要凑齐一套就用不同的名字。 |
| `walk.loopDirection` | `'forward' \| 'reverse' \| 'pingpong'` | 默认 `forward`。 |
| `walk.repeat` | `number` | `0` 表示永远循环。默认 `0`。 |
| `walk.targetFrame` | `number` | 第一个目标帧。默认是绑定静止帧之后的那一帧。 |
| `walk.overwrite` | `boolean` | 目标帧已经有像素时必须传。 |

**循环是闭合的。** 步态由整数三角波驱动，按 `frames` 取模采样，所以第 `frames` 帧
与第 `0` 帧是*同一个姿势*，最后一帧直接接回第一帧。没有重复的末帧，因此没有接缝。
正弦在静态图里读起来一样，却会把 `Math.sin` 塞进一条决定像素的路径。

步态姿势是临时的：它们被烘焙进帧里，永远不会被推回绑定，所以一个文档不会累积
「每帧每方向一个姿势」。想保留某个站姿就用一条 `save_pose` op。

**错误。** 和别处一样，`CommandError` 带一个 code。这里真正会遇到的失败是缺少绑定，
它会以 `ops[N] (create_rig) failed: …` 或步态 op 自己的上下文到达 —— 是被点名的，
不是一个意外。

---

## `exportEngineAssets(sprite, plan)`

`meta.json` 加上某个引擎的文件，以字节返回。资产契约
（[`ASSET-CONTRACT.md`](ASSET-CONTRACT.md)）和四个导入器
（[`IMPORTERS.md`](IMPORTERS.md)）都是 core 的内部实现；这是一个构建脚本唯一需要的
调用，于是没有人需要手工拼 `{root, files, warnings}`、序列化契约、校验命名、再逐段
拼接路径。

```js
const bundle = exportEngineAssets(sprite, { engine: 'godot', sheet: true });
for (const file of bundle.files) {
  await writeFile(join('assets', bundle.root, file.path), file.bytes);
}
console.log(bundle.warnings); // Godot 的映射没能承载什么
```

| plan 字段 | 作用 |
| --- | --- |
| `engine` | `'godot' \| 'unity' \| 'phaser' \| 'excalidraw'`。 |
| `meta` | 同时写出 `meta.json`。默认 `true`；每个导入器都要读一份契约。 |
| `metaPath` | 它写到哪里，相对于根目录。默认 `meta.json`。 |
| `sheet` | `true` 用默认选项打包一张精灵图；给对象则把布局选项传给 `core.buildSpritesheet`。整包单帧 PNG 时省略。 |
| `scale` | 打包精灵图的整数倍放大。默认 1。 |
| `background` | 在精灵图后面填充底色，而不是留透明。 |
| `outputs` | 包里的其他文件，会列进契约。 |
| `license` | 授权信息。绝不凭空编造：省略即契约对权限只字不提。 |
| `directions` | 逐帧朝向标签，每帧一个。**这是调用方选项，绝不推导** —— 无法识别的标签会被拒绝而不是丢掉，因为一个在游戏里悄悄朝错方向的角色，是无法从精灵图上追溯出来的。 |
| `name` | 文件名词干。默认取精灵名。 |
| `directory` | 覆盖导入器建议的根目录。 |
| `options` | 原样传给选中的导入器。`godot` 不接受参数，并且会明说。 |

结果是 `{root, files, warnings, meta, naming}`。`files` 是 `{path, bytes, role}`，
相对于 `root`。

**`warnings` 是一份有损清单，不是一个分数。** 这里没有任何数字可供优化，也没有
任何判定可以让画面朝它移动 —— 这些是契约自己的 S9 里列出的映射，而导入器确实命中了
其中哪些；这正是构建日志需要的。`naming` 同理，是带机器可读诊断的报告，不是评分。
命名**错误**（保留设备名、大小写折叠后碰撞）会拒绝整次调用，因为一份文件会在
Windows 构建机上坏掉的包就是一次坏掉的构建，在这里找到比在 CI 里什么都点名不了地
失败要好。

**确定性。** 契约不带时间戳，也不编造 `uid://`；文件顺序就是导入器的顺序；命名报告是
名字的纯函数。同一个精灵、同一个 plan、同样的字节，任何进程都一样。

**它会拒绝**自己没法诚实描述的东西：瓦片集或瓦片地图文档没有 `schemaVersion 1` 的
契约，无法识别的朝向是错误，长度不对的 `directions` 数组也是错误。给瓦片集发一份
`kind: "sprite"` 的文件，正是那种要让接入者花掉一天的、自信满满的错误答案。

---

## `traceSvg(spec)`

一个 `SpriteSpec` 外加 `svg`：从矢量到像素的路，一次调用走完。PNG 导入无法还原
几何信息；描边得到的轮廓则是精确落在网格上的。

```js
const icon = traceSvg({
  svg: await readFile('assets/logo.svg', 'utf8'),
  width: 32, height: 32, name: 'logo',
  palette: ['#1a1c2c', '#5d275d', '#ef7d57', '#ffcd75'],
  scale: 16,           // 一个 512 单位宽的图标落成 32px 宽
});
```

`svg` 是源码**文本**，不是路径：core 没有文件系统，所以由构建脚本读文件。在
`SpriteSpec` 之上还有：`layer`、`frame`、`color`（把整条描边压成一种颜色）、`scale`
（每个像素对应多少 SVG 用户单位）、`offset`、`tolerance`、`rect` 和 `replace`。

**覆盖率是硬边的，这是刻意的。** 描边得到的轮廓是一个像素边缘，不是一串中间 alpha
值的渐变；如果阶梯太粗，之后跑一条 `antialias` op 就行。

**它会拒绝。** 任何元素上的 `transform`、带继承 `fill` 的 `<g>`，以及
`fill: url(#gradient)` —— 它们都会把画面放到错误的位置却不作声。描边（stroke）
永远不会被描：只有描边的 SVG 什么都不产出，并且会说出来。

**怎么读这个拒绝。** `editor.execute` 会把每一次命令失败重新包一层，所以你捕获到
的错误 code 是 `command_failed`，而机器可读的原因嵌在下一层：

```js
try {
  traceSvg({ svg, width: 32, height: 32 });
} catch (error) {
  error.code;                          // 'command_failed' —— 这条 op 失败了
  error.details.code;                  // 'invalid_params' —— 参数有问题
  error.details.details.reason;        // 'svg_unsupported' | 'svg_malformed' | 'svg_empty'
}
```

这是这份 API 里每一个 op 抛出的形状，不是描边器特有的：在这三层里按
`error.details.details.reason` 分支，才是在按「文档拒绝的原因」分支 —— 只有它
说明了关于这份 SVG 的任何事情。

**确定性。** 描边器的三角运算是 Cody-Waite 区间规约加 fdlibm minimax 核，而不是
`Math.sin`，原因同上。同样的 SVG、同样的画布、同样的像素，任何机器都一样。
