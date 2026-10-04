# Cookbook（示例集）

<p align="center">
  <a href="COOKBOOK.md">English</a> · <a href="COOKBOOK-ZH.md">中文</a>
</p>

> 英文的 [COOKBOOK.md](COOKBOOK.md) 是正本，本文件是它的中文镜像；两者冲突时以英文为准。
> 标识符、路径、字段名与表格顺序都与英文逐字一致；**只翻译围绕它们的散文**。

> 五个任务，五个可运行的文件。每个字段的参考都在
> [`docs/API.md`](API.md)；这份文档写的是人们真正想做的事。
>
> 这里的每一段代码都是 [`cookbook/`](../cookbook/) 里的一个文件，而
> `packages/core/test/cookbook.test.ts` 会编译、运行并逐字节比对它们全部。
> （英文原版的这一行曾标注「尚无中文镜像」；现在就是这份文件。）

人们真正想用这个引擎做的五件事，以及把它们做出来的代码。

本文档里的每一段代码都是 [`cookbook/`](../cookbook/) 里的一个文件，而
`packages/core/test/cookbook.test.ts` 会在每次测试运行时编译、运行并逐字节比对其中每一个。
这里任何一段失效的代码，都会在读者复制它之前先让构建失败。

| 章节 | 文件 | 产出什么 |
| --- | --- | --- |
| [1. 你的第一张精灵](#1-你的第一张精灵) | `cookbook/01-first-sprite.ts` | 一只 16×16 的史莱姆：剪影、明暗、轮廓，PNG + 图集 + `.pixel` |
| [2. 行走循环与八个方向](#2-行走循环与八个方向) | `cookbook/02-walk-cycle.ts` | 从一张图画出四个正方向的行走循环，外加 `directions.json` |
| [3. 描摹一个 SVG](#3-描摹一个-svg) | `cookbook/03-trace-svg.ts` | 一个描摹成 16px 图标的 64 单位叶片，以及随之而来的那次拒绝 |
| [4. 面向引擎导出](#4-面向引擎导出) | `cookbook/04-engine-export.ts` | 由同一份契约生成 Godot、Unity、Phaser 和 Excalidraw 文件包 |
| [5. 完整跑通一份配方](#5-完整跑通一份配方) | `cookbook/05-recipe-ui-icon.ts` | 用配方搭出一个 UI 图标，并用具名缺陷来检查 |

[`docs/API.md`](API.md) 是参考手册：每一个字段、每一个错误码、每一个 plan 选项。
这份文档讲的是那五个任务。

---

## 运行一个示例

这些示例是带顶层 `await` 的 ESM TypeScript，它们导入裸说明符 `dotloom-mcp` —— 就是一个
游戏项目会写的那个字符串，通过包的 `exports` 映射解析，而不是通过一条通往本仓库内部的路径。

在一个已经安装了这个包的项目里：

```bash
npm install --save-dev dotloom-mcp
node --experimental-strip-types cookbook/01-first-sprite.ts
```

有两件事在你的项目里不是可选的，因为这些示例是 ESM：

- `package.json` 里的 `"type": "module"`，或者用 `.mts` 扩展名。
- Node **22.13 或更高版本**（`--experimental-strip-types`；在 22.18+ 上这个标志是可选的）。

在*这个*仓库里，裸说明符哪儿也解析不到 —— 一个 workspace 不会链接到自己 —— 所以这些示例的
运行方式就是测试的运行方式：对着打包好的 tarball，在一个临时的使用方里跑。那就是
`packages/core/test/cookbook.test.ts`，而运行它同时也是你在改动某个示例之后检查它的方式：

```bash
pnpm --filter @pixel/core exec vitest run test/cookbook.test.ts
```

文件会落在 `./generated/`，除非你另有安排：

```bash
DOTLOOM_COOKBOOK_OUT=out node --experimental-strip-types cookbook/02-walk-cycle.ts
```

**当画面确实变了的时候，重新生成字节期望值并读一遍 diff：**

```bash
DOTLOOM_COOKBOOK_UPDATE=1 pnpm --filter @pixel/core exec vitest run test/cookbook.test.ts
```

这会重写 [`cookbook/manifest.json`](../cookbook/manifest.json) 里每一条目的 `outputs` 块 ——
每个示例产出的每个文件的路径、长度和 sha256。那里出现的 diff 意味着像素移动了，而这正是
重点：一个没人改动却会变化的资产就是 bug，而它在这里现形。

---

## 1. 你的第一张精灵

[`cookbook/01-first-sprite.ts`](../cookbook/01-first-sprite.ts)

一只史莱姆，按像素画师的工作顺序来：**剪影平涂，在它内部上明暗，轮廓最后画。** 这个顺序
不是风格问题。之后每一遍的效果，都是拿「第一遍对不对」来评判的，而在明暗之前画下的轮廓
什么也分不开。

```ts
const slime = buildSprite({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime',
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  layers: ['base', 'shade', 'outline'],   // bottom first
  ops: [
    { command: 'draw_ellipse', params: { layer: 'base',    rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },
    { command: 'draw_ellipse', params: { layer: 'shade',   rect: { x: 4, y: 9, w: 8,  h: 4 }, color: '#306230' } },
    { command: 'draw_ellipse', params: { layer: 'shade',   rect: { x: 3, y: 8, w: 10, h: 4 }, color: '#9bbc0f', fill: false } },
    { command: 'draw_rect',    params: { layer: 'shade',   rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_rect',    params: { layer: 'shade',   rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
  ],
});

const files = exportAssets(slime, { frames: true, sheet: true, source: true });
```

那段代码里有五件事值得照抄：

- **`ops` 就是同一份命令目录**，GUI 和 MCP 工具面用的也是它。`list_commands` 记录了这些
  op；构建脚本没有第二种方言。
- **`layer` 和 `frame` 是可选的。** 省略它们，第 0 帧的最底图层会被自动填上 —— 用的是 core
  里 MCP 工具面所调用的同一个函数，所以构建脚本和 Agent 写出的 op 拼写完全一致。
- **参数写错就是错误，绝不会是一个静默默认值。** `.strict()` schema 意味着
  `ops[3] (draw_rect) failed: …` 会点名是那一条 op 错了。
- **`exportAssets` 返回字节，不碰任何文件系统。** 它们去哪里是你构建脚本的事。一个什么都没
  选中的 plan 会抛错，因为一个没有产出任何文件却报告成功的构建，是最糟的结果。
- **`sheet: true` 是两个文件。** PNG 是引擎用来切片的；旁边的 `.json` 才是用来说明每一帧
  在哪里、持续多久、属于哪个标签的。一张没有自己那张表的图像只是一幅画。

---

## 2. 行走循环与八个方向

[`cookbook/02-walk-cycle.ts`](../cookbook/02-walk-cycle.ts)

在画任何东西之前先问 plan：

```ts
const model = getDirectionModel({ width: 32, height: 32 });
model.exact;        // ['N', 'E', 'S', 'W']     — a turn and/or a mirror reproduces these exactly
model.approximate;  // ['NE', 'SE', 'SW', 'NW'] — no pixel-exact 45° transform exists; draw these
model.pivot;        // { x: 15.5, y: 31 }       — bottom centre, the contact point under the feet
```

**一个八方向角色是三张图，不是八张图集。** 八个方向里有四个是底图 `E` 的精确变换。四个斜
方向不是，因为不存在像素精确的 45° 变换，而这个引擎也不会去近似一个 —— 所以它们需要自己的
画面，而 plan 会明说，而不是悄悄地替换成一个正方向。

然后每个方向调用一次：

```ts
const walk = buildWalkAnimation({
  seed: 4242, width: 32, height: 32, name: 'hero-e',
  layers: ['body', 'legL', 'legR', 'armL', 'armR'],
  direction: 'E',
  walk: { frames: 6, frameDurationMs: 110, stride: 3, tagName: 'walk_e' },
  ops: [ /* create_rig, then the rest pose, drawn once */ ],
});
```

- **绑定是步态得以成立的原因。** `create_rig` 给每个部件一个支点；一条没有支点的腿不会摆动，
  它只会平移。这些部件同时也是图层，所以每个部件的像素能存活到生成器烘焙出的那些帧里。
- **循环是闭合的。** 步态是整数三角波，按 `frames` 取模采样，所以第 `frames` 帧与第 0 帧
  是*同一个姿势*。没有重复的末帧，因此没有接缝。
- **行走姿势是临时的。** 它们被烘焙进帧里，永远不会被推回绑定，所以一个文档不会累积「每帧
  每方向一个姿势」。想保留某个站姿就用一条 `save_pose` op。
- **给角色一个不对称的细节。** 这个例子里的主角在一侧背着一个挎包。左右对称的角色会映射到
  自身，于是 `E` 和 `W` 产出逐字节相同的文件，四个方向就变成两套图集顶着四个名字。测试断言
  `hero-e_sheet.png` 和 `hero-w_sheet.png` 不同，这条性质就是靠它维持的。

---

## 3. 描摹一个 SVG

[`cookbook/03-trace-svg.ts`](../cookbook/03-trace-svg.ts)

```ts
const icon = traceSvg({
  svg: await readFile('assets/leaf.svg', 'utf8'),
  width: 16, height: 16, name: 'leaf',
  palette: ['#1a1c2c', '#5d275d', '#9bbc0f', '#ffcd75'],
  scale: 4,          // 64 SVG user units across 16 pixels
});
```

- **`svg` 是文本，不是路径。** core 没有文件系统；文件由你来读。
- **`scale` 是每个像素对应多少 SVG 单位**，不是反过来。把一个 64 单位的图标放进 16px 的
  画布就是 `4`。填反了会让画面落到四分之一大小，那看起来像描摹器的 bug，而且它是一个错数字。
- **覆盖率是硬边的，这是刻意的。** 描摹得到的轮廓是一个像素边缘，不是一串半透明 alpha 值的
  渐变。阶梯太粗的话，之后跑一条 `antialias` op 就行。
- **拒绝是具名的，不是近似的。** 不接受 `transform`，不接受带继承 `fill` 的 `<g>`，不接受
  `fill: url(#gradient)`，不接受只有描边的形状。示例把那次拒绝写了出来：

```text
code: command_failed
details.code: invalid_params
reason: svg_unsupported
```

这个嵌套是真实的，值得知道一次：总线会把每一次命令失败重新包一层，所以你捕获到的错误 code
是 `command_failed`，而那个说明了关于这份 *SVG* 的事情的 reason 位于
`error.details.details.reason`。这就是这份 API 里每一个 op 抛出的形状。

---

## 4. 面向引擎导出

[`cookbook/04-engine-export.ts`](../cookbook/04-engine-export.ts)

游戏不读一张 PNG。它读的是一张精灵图、一份帧表和一套支点约定，而每个引擎把这三样东西的
叫法都不一样。`exportEngineAssets` 接受那一份契约，写出某一个引擎的文件：

```ts
const bundle = exportEngineAssets(sprite, {
  engine: 'godot',                     // 'godot' | 'unity' | 'phaser' | 'excalidraw'
  sheet: { layout: 'grid', columns: 4 },
  directions: ['S', 'S', 'S', 'S'],   // one per frame, timeline order
});
for (const file of bundle.files) {
  await writeFile(join('assets', bundle.root, file.path), file.bytes);
}
console.log(bundle.warnings);
```

- **`warnings` 是一份有损清单，不是一个分数。** 对于本例中不均匀的 110/90 ms 时序，
  Godot 用一句话说明：

  > Animation "idle" has non-uniform frame durations (110/90/110/90/110/90 ms). Godot's
  > SpriteFrames carries one speed per animation, so this plays at 10 fps with every frame held
  > 100.000 ms. Drive SpriteFrames from meta.frames.durationsMs in script for the exact timing.

  Unity 保留逐帧时序，什么也不警告 —— 这正是示例要用一个时长混合的动画的原因：均匀时序会
  掩盖掉那里每一种有损映射。
- **`directions` 是调用方选项，绝不推导。** 无法识别的标签会被拒绝而不是丢掉，因为一个在
  游戏里悄悄朝错方向的角色，是无法从精灵图上追溯出来的。
- **一次命名错误会拒绝整次调用**，在任何字节被产出之前：

```text
code: invalid_params
Asset naming refuses this bundle: 1 error(s) [reserved-name]. First: "outputs[0].path" -
"CON.png" is a reserved Windows device name. …
```

  一个文件会在 Windows 构建机上坏掉的包就是一次坏掉的构建，而这个错误在这里被发现，远好过
  在 CI 里失败却什么都点名不了。
- **`meta.json` 默认会跟着一起产出。** 每个导入器都读一份契约，而契约正是让引擎文件可以重新
  生成、可以 diff、可以检查的东西。

---

## 5. 完整跑通一份配方

[`cookbook/05-recipe-ui-icon.ts`](../cookbook/05-recipe-ui-icon.ts)

一份**配方**（[`recipes/ui-icons.recipe.json`](../recipes/ui-icons.recipe.json)）是一份可复用的
美术指导纲要：要建多大、怎么建调色板、有哪些图层、光从哪来、按什么顺序做、这一类作品反复
犯的错是什么。它不是脚本 —— 它点名的是约束，画面仍然是通过普通命令画出来的。

1. **读它，并校验它。** `core.parseRecipe` 用的就是 `describe_recipe` 用的那份 schema，
   所以一份没通过校验的配方就不会被遵循。`DOTLOOM_RECIPE` 把示例指向另一个配方文件：此后
   每一个**数字**都跟着那个配方走 —— 画布、图层、调色板、`locked` —— 而画面不跟着走。配方
   决定约束，画面决定标记。一个想要一整套东西的构建脚本会按 `recipe.id` 分支。
2. **从它那里取数字。** `canvas.sizes[0]` 是默认尺寸，因为配方这么说；`layers[]` 从底向上；
   `palette.base` 用作调色板的种子，`palette.roles[]` 里每一条追加一条 `add_palette_ramp`；
   `palette.locked` 变成 `paletteLocked`。
3. **照着配方画。** 标记用一种平涂颜色，然后是 `clear_region` 开出的镂空 —— 正是这块负形
   让一个图标有意义，而且在 16px 上，那些本该填满它的细节是没人分辨得出来的细节。
4. **回答它的检查项。** 它们是答案是或否的问题，配一个只读工具，绝不是分数：

```json
{
  "markFills10to12": true,
  "markBounds": { "x": 3, "y": 3, "w": 10, "h": 11 },
  "recipe": "ui-icons",
  "defects": [
    { "dimension": "value", "code": "flat-value",
      "message": "one lightness bucket holds 1000/1000 of the solid pixels; the form is not being described by tone at all." },
    { "dimension": "silhouette", "code": "thin-profile",
      "message": "profile 63/1000 (compactness 92/1000, thickness 63/1000 at 1px in a 16x16 canvas): the shape is too thin to read at game scale; thicken it, or give the sprite more pixels." }
  ]
}
```

### 为什么输出是缺陷的**名字**而不是一个分数

曾经有一个 `quality_report` 工具。它在 0.3.1 被删除，而原因是这个项目里最重要的一个设计
教训：**一个被告知某个数字「干净」的模型，把一个湖磨成了一块深色平板。** 任何交给 Agent 的
分数都会变成目标，而不是画面。那就是古德哈特定律如期而至。

所以这个仓库提供的是过程性的工艺指导和一个只读感知通道，而不是一个判定。`evaluate` 仍然
*计算* `score`，而配方示例也调用了它 —— 但它打印出来的是 issue 的名字以及各自附着的那句
说明，也就是一份待办清单。测试在结构上强制这一点，而不是靠约定：**任何示例写出的 JSON 文件
都不得带有 `score`、`scoreQ`、`severityQ` 或 `verdict` 键。** 加一个，cookbook 测试就会失败。

没有补救办法的缺陷就是一句空话，所以每条 issue 都随附该怎么办。其中一些 code 的修复动作是
机械的，另一些则不存在；`fix` 把那些有安全 op 的修复动作变成你通过总线施加的
`{command, params}` 数据，对没有的就用散文说明。它自己从不改任何像素。

---

## 测试检查什么，又不检查什么

`packages/core/test/cookbook.test.ts`：

| 主张 | 如何检查 |
| --- | --- |
| 每个示例都已注册 | `cookbook/*.ts` 和 `manifest.json` 必须双向列出同一批文件 |
| `cookbook/` 里没有任何东西被漏掉 | 任何既不是 `manifest.json` 也不是示例的文件都会失败 |
| 每个示例都能通过类型检查 | 一个使用方自己的 `tsc`，`strict`，`skipLibCheck: false`，对着**打包好的 tarball**、通过 `exports` 映射 |
| 每个示例都使用已发布的说明符 | 每个 import 都被断言为 `dotloom-mcp`，绝不是相对路径 |
| 每个示例都能运行 | 在子进程里跑它自己的顶层 `main()`；一次抛出就会带着该文件自己的输出失败 |
| 每个示例都写出文件 | 输出目录被列出来，且必须非空 |
| 同样的 spec，同样的字节 | 每个示例运行**两次**，两次运行互相比对 |
| 与已提交的文件同样的字节 | 每个产出文件的长度和 sha256，key 集合两个方向都精确匹配 |
| 每一章都守得住自己的主张 | 镜像会跑、描摹器点名 `svg_unsupported`、Godot 和 Phaser 会警告而 Unity 不会、`CON.png` 被拒绝、标记填满 16 中的 10–12 |
| 没有分数可供优化 | 任何 JSON 输出都不得带有 `score`、`scoreQ`、`severityQ`、`verdict` 或 `quality` |
| 散文跟得上代码 | `docs/COOKBOOK.md` 必须提到每一个示例文件和每一个章节标题 |

**没有被比对的东西：** 今天没有任何东西。所有五个示例都是其输入的纯函数，所以每一个产出的
字节都被提交进了 manifest。manifest 的 schema 为 `bytes: false` 豁免留了位置，并要求必须给出
理由，因为一个确实无法做到确定性的示例仍然应该被编译和运行 —— 而且有一个测试断言**今天没有
任何示例使用它**，所以这项豁免不会悄悄变成常态。

**字节比对看不见的唯一一件事：** 画面到底好不好。manifest 钉住的是管线产出了什么，而不是
那是不是正确答案。评判这些图是 [`dev/EVALUATION.md`](EVALUATION.md) 的工作，而它需要人类
评分者。

---

## 这份示例集撞上的已知缺口

两个，两个都写出来而不是糊过去：

1. **一份配方用预设 id（`endesga16`）指明它的基础调色板，而库入口解析不了预设名。** MCP
   工具面能解析它们；npm 入口收的是颜色，而 `docs/API.md` 直说了渐变的*名字*是刻意不被接受
   的。示例从 `mcp` 命名空间读取预设表，并在注释里说明了这件事。把
   `resolveBuiltinPalette` 提升到稳定入口，就能去掉这一行和那个 `mcp` 导入。
2. **`recipes/` 不在包的 `files` 列表里**，尽管 `docs/API.md` 说这个包会带上 recipes 目录。
   因此第 5 章把配方当作项目要放在构建脚本旁边一起 vendor 的文件，而示例反正也是这么做的。

---

## 相关文档

- [`docs/API.md`](API.md) —— 库参考手册：每一个字段、plan 选项和错误码。
- [`docs/ASSET-CONTRACT.md`](ASSET-CONTRACT.md) —— `meta.json` 的含义，逐字段说明。
- [`docs/IMPORTERS.md`](IMPORTERS.md) —— 四个引擎各自对它做什么，以及各自损失了什么。
- [`recipes/README.md`](../recipes/README.md) —— 配方格式，以及如何新增一份。
- [`docs/REFERENCE.md`](REFERENCE.md) —— 完整命令目录，给这份文档还没用过的 op 用。