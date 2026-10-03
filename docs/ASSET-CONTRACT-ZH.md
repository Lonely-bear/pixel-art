# 资产契约 —— `meta.json`

<p align="center">
  <a href="ASSET-CONTRACT.md">English</a> · <a href="ASSET-CONTRACT-ZH.md">中文</a>
</p>

> **状态：**规范性规格，`schemaVersion 1`。本文与 `packages/core/src/asset/` 中的代码
> 是同一个交付物。两者不一致时以本文为准、代码有错；
> `packages/core/test/asset-contract.test.ts` 会解析下面的表格，一旦发现某个字段没有对应
> 的行、或某一行没有对应的字段就让构建失败，因此两者不可能悄悄地漂移。
>
> **这是单个资产的契约，不是打包清单。** `finalize_document` 的导出清单回答的是
> 「这次运行写了什么、写在哪里、有多大」——那是关于一次执行的记账。本文回答的是
> 「这个资产**是什么**」，并且应当比这次运行、这台机器以及做它的人活得更久。

一个丢进 Godot 工程、Unity 包或 Phaser 构建里的 PNG，是一个不知道自己属于哪一帧的
文件。每一个像样的引擎都需要同样六件事——一帧多大、有多少帧、哪些帧组成哪个动画、
每帧停多久、是否循环、精灵图支点在哪里——而每一个生态都用不同的拼法把它们写出来。
`meta.json` 是关于这些事实的**一份**描述，五种生态都读得懂。

本规范的使用者：

| 任务 | 读取 | 最需要什么 |
| --- | --- | --- |
| T-051 Godot 导入器 | 5, 6, 7, 9.1 | 逐帧时序、循环、支点 |
| T-052 Unity 导入器 | 5, 6, 7, 9.2 | 支点、精灵图几何 |
| T-053 Phaser 导入器 | 5, 6, 7, 9.3 | 帧尺寸、动画帧列表 |
| T-054 Excalidraw 导入器 | 5, 9.4 | 帧尺寸、每格一帧 |
| T-055 命名校验器 | 5, 8 | `asset.name`、`outputs[].role`、路径 |

章节号写成「S5」而不是章节符号，这样本文中每个字符都是 ASCII，从终端或某种老旧编码
复制过去也不会损坏。

---

## 1. 范围

**在范围内。** 单个精灵：所有帧共享的一个画布尺寸、一条逐帧时长的时间线、带播放方向
和重复次数的动画标签、一个调色板、一份可选的精灵图、一个支点、可选的许可信息，以及
包里其它文件的清单。

**在 `schemaVersion 1` 时不在范围内。** 图块集、瓦片地图、Tiled 对象图层和九宫格边框。
生成器对这些是**拒绝**而不是为它们写一个 `kind: "sprite"` 的文件。见 S10。

---

## 2. 文件

- **文件名：** `meta.json`。
- **编码：** UTF-8，无 BOM。
- **序列化：** 两空格缩进的 JSON，末尾带一个换行符。键的顺序就是 S5 里的顺序，
  而它是契约的一部分——描述同一资产的两个文件应当**逐字节一致**，而只有在顺序固定的
  前提下这一点才可检查。
- **位置：**与它描述的文件放在一起。文件内部的每一条路径都相对于放着 `meta.json`
  的那个目录，并且在所有平台上都用正斜杠。
- **一个资产一个文件。** 一个同时带图块集和精灵的文档需要两个文件，等图块集契约
  存在之后就是如此。

```jsonc
// hero-idle.meta.json - 一个静帧精灵的最小样子
{
  "format": "dotloom-mcp/asset-meta",
  "schemaVersion": 1,
  "kind": "sprite",
  "asset": { "name": "hero-idle", "contentHash": "sha256:..." },
  "frames": {
    "count": 1,
    "size": { "width": 32, "height": 32 },
    "durationsMs": [100],
    "totalMs": 100,
    "fps": 10
  },
  "pivot": { "x": 16, "y": 16, "source": "default" },
  "palette": { "name": "DawnBringer 16", "locked": false, "colors": ["#140c1c", "..."] }
}
```

---

## 3. 版本与兼容性

`schemaVersion` 是一个整数。两条规则，而第二条才是关键的那条：

1. **破坏性变更要提升它。** 删掉一个字段、给它改名、收窄一个类型、改动一个单位，
   或者改动一个值的含义。
2. **新增字段不提升。** 在同一个主版本内，契约只增不减。

**读取方必须忽略它们不认识的字段。** 一个会长大的规范绝不能弄坏每一个在它长大之前
就已经发布的消费者，而保证这一点的唯一办法是要求容错。因此比读取方所支持的更新的
`schemaVersion` **不**是错误：读取方读它认识的字段、跳过其余的，并且把这件事说出来。

**写入方不得依赖读取方理解一个新字段。** `1.0` 之后新增的每一个字段都是可选的，并且
带一个有文档记录的默认值，所以一个由新生成器写出、被旧读取方读到的文件只会丢掉那个
新字段，别的一概不会丢。

**弃用。** 一个字段在 S5 里被标为弃用，并在本主版本的剩余时间内继续输出。只有当
再没有任何读取方可能依赖它时，它才被移除、并且主版本被提升。一个被弃用的字段绝不会被
悄悄挪用——一个含义变了的字段等于一次删除加一次新增，因为读取方分不出这两者。

**机器可读的政策。** 校验器把更新的 `schemaVersion` 报成 `schema-version-unsupported`
（advisory），把不认识的键报成 `unknown-field`（advisory）。其余一切都是 error。请注意
它的后果，这是整条政策里最锋利的地方：一个**拼错**的字段会以*两条*发现的形式到达——
一条是没人认识的那个键的 `unknown-field` advisory，另一条是它本该是的那一个必需键的
`missing-field` error——所以对未来的容错不会变成对拼写错误的容错。

---

## 4. 身份

### 4.1 内容哈希，以及在跨引擎的意义上是什么标识一个资产

**是内容哈希，不是 id。** `asset.contentHash` 是 `sha256:` 后面跟 64 位小写十六进制
数字。

文档模型给每一个精灵、图层、帧和标签都分了一个 id，而这些 id 来自时钟加上真实熵
（`packages/core/src/ids.ts`）——对一个活着的编辑器来说是对的选择，对一个资产身份来说
是错的选择。两个人画出同一幅四帧精灵，必须在两台机器上、两个会话里得到同一个身份；
否则每一个引擎里的每一份导入器缓存都会在第一次接触时未命中，而一个在开发者机器和构建
服务器之间不一样的缓存键不是缓存键。所以身份是资产本身的摘要，里面没有任何文档 id。

`asset.name` **同样不是**身份。它是一个查找键——人怎么称呼这幅精灵、T-055 校验什么、
导入器以什么名义登记它——并且它被排除在哈希之外，这样重命名资产就不会让它的缓存失效。

### 4.2 哈希里有什么，哈希外有什么

里面，因为这些东西**就是**资产：

| | |
| --- | --- |
| 画布宽、高 | 资产的分辨率 |
| 逐帧，按时间线顺序 | `durationMs`，然后是合成后的 RGBA 字节 |
| 调色板色板 | 按调色板索引顺序，`r`、`g`、`b`、`a` 各一项 |
| 动画标签 | name、`from`、`to`、direction、`repeat` |

外面，而且是有意在外面：

| | 为什么 |
| --- | --- |
| `asset.name` | 重命名不得让缓存失效 |
| 每一个文档 id | 时钟 + 熵；见上文 |
| 图层名、顺序、不透明度、混合模式 | 合成结果相同的两个图层就是同一份画面 |
| 骨架 rig | 创作期的结构；它不改变任何一个像素 |
| `pivot`、`palette.locked`、`license` | 关于资产的声明，不是资产本身 |
| `schemaVersion` | 一个记录了新字段的规范修订不该移动每个项目里的每一个身份 |
| 文件路径、精灵图几何 | 一个资产可以是按精灵图、按 PNG，或者按 3x 发布的 |

一个只在上面那张表之外的东西上不同的文档，序列化出来是**同样的字节**。这就是「它们
确实就是同一个资产」本来的意思。

### 4.3 原像，逐字节

哈希是下面这段字节序列上的 SHA-256。把它公布出来，是为了让另一种语言里的第二个实现
与这个实现一致；这个摘要的值*就是*两个独立实现彼此一致这件事。

```
u32   标记字符串的字节长度
bytes 标记本身，ASCII："dotloom-mcp/asset-meta"
u8    摘要版本，目前为 1
u32   画布宽
u32   画布高
u32   帧数
按帧数重复，按时间线顺序：
  u32   durationMs
  u32   这一帧像素的字节长度   （== width * height * 4）
  bytes 合成后的 RGBA，行主序，y 向下
u32   调色板色板数量
每个色板重复一次，按索引顺序：
  u8 r, u8 g, u8 b, u8 a
u32   动画标签数量
每个标签重复一次，按文档顺序：
  u32   名称的字节长度
  bytes 名称，UTF-8
  u32   from
  u32   to
  u8    方向：forward = 0, reverse = 1, pingpong = 2
  u32   repeat
```

每一个整数都是**无符号小端序**。每一个变长字段都是**带长度前缀**的，而这不是装饰：
没有这些前缀，一个叫 `ab` 的标签挨着一个叫 `c` 的标签，与一个叫 `a` 的标签挨着一个叫
`bc` 的标签，会算出同样的哈希，摘要就悄悄不再是资产的函数了。

合成后的字节是该帧按图层顺序、不透明度、混合模式和可见性展平的结果——也就是本仓库
其它每一个渲染器产出的同一个合成结果。一个改为哈希原始 cel 的摘要，会在画师只是重排
了图层而画面没变的时候改变。

UTF-8 编码把落单的代理项替换为 U+FFFD，与主流编码器一致。

摘要版本是一个与 `schemaVersion` **分开**的整数，而且是有意的。它只在上面这些字节发生
变化时才动，所以记录一个新字段不会让任何缓存失效。

### 4.4 这个哈希不是什么

它是一个**缓存键和变化检测器**，不是真实性声明。没有任何导入器会重算它——它们都做不到，
因为重算意味着把每一帧重新合成、并重建上面的原像。不要用它来判断一个文件有没有被篡改。
要做那件事，请哈希导出的字节（`finalize_document` 的清单已经这么做了），并且把签名留在
本文件之外。

---

## 5. 字段参考

**必填**意味着读取方没有它就没法工作，而且严格就是 `yes` 或 `no`——派生字段是由它的
描述标出来的，不是由它的必填性标出来的，因为「一个导入器可以重算这个」和「一个导入器
可以省略这个」是两句不同的话。S7 列出了哪些是派生的。

这张表要强制执行的那条规则是：**凡是能从像素上读出来的东西，都不必填。** 见 S7。

| 字段 | 类型 | 必填 | 单位 | 默认值 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `format` | string | yes | - | - | 永远是 `dotloom-mcp/asset-meta`。先检查它：它说明这个文件确实是一份资产契约，而不是同目录下的导出清单、Aseprite 精灵图 JSON 或关卡文件。 |
| `schemaVersion` | integer | yes | - | - | 契约修订号，目前是 `1`。在信任其他任何东西之前先与读取方的上限比较；见 S3。 |
| `kind` | enum | yes | - | - | 这个文件描述的是什么。在 `schemaVersion 1` 只有 `sprite`。刻意封闭：读取方遇到一个它不认识的取值，说明它拿到的是一份它无法服务的文档，它必须说出来而不是猜。 |
| `asset` | object | yes | - | - | 身份块。 |
| `asset.name` | string | yes | - | sprite name | 资产自己的名字；人怎么称呼它、导入器以什么名义登记它。是一个查找键，**不是**身份（S4.1）。1-255 个字符；这个上限是路径限制，不是品味。 |
| `asset.contentHash` | string | yes | - | - | `sha256:` + 64 位小写十六进制数字。身份与变化检测（S4）。 |
| `frames` | object | yes | - | - | 时间线。 |
| `frames.count` | integer | yes | frames | - | 帧数，因此也是精灵图里的格子数。必须等于 `durationsMs.length`。 |
| `frames.size` | object | yes | pixels | - | **一帧**的尺寸，以画布像素计。同时也是源画布尺寸：所有帧共享一个画布，所以没有需要描述的逐帧裁剪。引擎按这个尺寸切片，而不是按精灵图尺寸。 |
| `frames.size.width` | integer | yes | pixels | - | 帧宽。 |
| `frames.size.height` | integer | yes | pixels | - | 帧高。 |
| `frames.durationsMs` | integer[] | yes | milliseconds | - | 每一帧被保持多久，按时间线顺序（索引 0 在前）。**这是没有任何引擎能从一张 PNG 推断出来的字段，也是本文件存在的理由。** 用位置数组而不是对象数组，这样一幅四帧精灵花的是四个数字而不是四个 JSON 对象。 |
| `frames.totalMs` | integer | yes | milliseconds | - | `durationsMs` 之和。派生：预先算好，好让播放程序不需要循环就能找到周期长度。 |
| `frames.fps` | number | yes | frames/second | - | `1000 * count / totalMs`，四舍五入到三位小数。派生：给只吃一个数字的引擎的便利值；`durationsMs` 才是权威，因为 100/100/200 ms 没有唯一正确的 fps，而这个是最不坏的一个。 |
| `animations` | object | no | - | - | 播放。单帧静帧时缺席，这不算是失败：静帧没有动画，而「它没有动画」与「它有一个空动画」是不同的话。 |
| `animations.default` | string | yes | - | first item's name | 在没人指定时播放程序应该播的那个动画。在 `animations` 内部是必填的，因为一个靠猜的引擎会去挑第一个，而「第一个」不是任何人做过的决定。 |
| `animations.items` | object[] | yes | - | - | 每一个动画，按文档顺序。至少一个。 |
| `animations.items[]` | object | yes | - | - | 一个动画。为了完整性而列出；它就是上面那个数组的元素形状。 |
| `animations.items[].name` | string | yes | - | tag name | 游戏代码调用的字符串。在哈希之内（S4.2），因为给动画改名是代码可见的变更。 |
| `animations.items[].from` | integer | yes | frame index | - | 范围的**首**帧，**含端点**，0-based。 |
| `animations.items[].to` | integer | yes | frame index | - | 范围的**末**帧，**含端点**，0-based。 |
| `animations.items[].direction` | enum | yes | - | `forward` | `forward`、`reverse` 或 `pingpong`。为那些能原生表达它的引擎保留；`frames` 才是权威，因为并非所有引擎都能。 |
| `animations.items[].repeat` | integer | yes | passes | - | 动画播放多少次；`0` 表示永远。是**播放遍数**，不是总帧数——`frames` 存的是一遍，由引擎来重复。 |
| `animations.items[].loop` | boolean | yes | - | `repeat === 0` | 播放是否永远循环。与 `repeat === 0` 完全等价，单独说出来是因为「这个循环吗」是每一个引擎问的第一个问题，而从一条导出链的哨兵值里推导它，正是一次两段攻击最后永远循环起来的方式。 |
| `animations.items[].frames` | integer[] | yes | frame index | - | 要播放的帧，**已经展开**，按顺序，一遍，不含重复。一段 pingpong 被写成它真实的播放顺序，这样导入器永远不必实现反向或往返——而朴素导入器正是在那里出错的。 |
| `animations.items[].durationMs` | integer | yes | milliseconds | - | **一遍**的长度。派生：非循环动画乘以 `repeat`。 |
| `animations.items[].fps` | number | yes | frames/second | - | 派生：仅这一个动画的平均帧率，取整方式与 `frames.fps` 相同。 |
| `sheet` | object | no | - | - | 打包好的精灵图。导出写成单张 PNG 时缺席，这是合法的：本字段描述精灵图，而它不存在。 |
| `sheet.image` | string | yes | path | - | 精灵图 PNG 的路径，相对于本文件，正斜杠。相对是硬性规则——见 S5.1。 |
| `sheet.columns` | integer | yes | cells | - | 每行的格子数。与 `regions` 一起定下排布。`layout`、`padding` 和 `margin` 是刻意缺席的：打包结果并不携带它们，在这里重新推导它们只会造出第二个几何权威，并且让它必须和第一个保持同步。 |
| `sheet.rows` | integer | yes | rows | - | 格子的行数。 |
| `sheet.scale` | integer | yes | factor | - | 派生：精灵图写出时相对 `frames.size` 的整数倍放大；1:1 时为 `1`。之所以存在，是因为一张 2x 精灵图和一张 32 px 精灵图是同一份画面的不同采样率，而一个正确过滤放大精灵图的导入器必须被告知它被放大过。 |
| `sheet.size` | object | yes | pixels | - | 精灵图图像自身的尺寸。之所以是权威而不是派生，是因为格子之间的空隙和精灵图四周的边框在这里没有被记录，而那恰好就是重算所需要的东西。只要 `scale` 大于 1，它就和 `frames.size` 不同。 |
| `sheet.size.width` | integer | yes | pixels | - | 精灵图宽。 |
| `sheet.size.height` | integer | yes | pixels | - | 精灵图高。 |
| `sheet.regions` | object[] | yes | - | - | 每帧一个矩形，按时间线顺序。**权威：读它们，不要从 `columns` 重算**，因为打包器可能插入了本契约不记录的缝隙或边框。被校验的是：每个格子都是 `frames.size * scale`、落在精灵图内部、并且按 `columns`/`rows` 蕴含的行主序出现。 |
| `sheet.regions[]` | object | yes | - | - | 一个格子。为了完整性而列出；它就是上面那个数组的元素形状。 |
| `sheet.regions[].index` | integer | yes | frame index | - | 这个格子装的是时间线上的哪一帧。必须等于它在数组中的位置。 |
| `sheet.regions[].x` | integer | yes | sheet pixels | - | 格子在精灵图里的左边沿。 |
| `sheet.regions[].y` | integer | yes | sheet pixels | - | 格子在精灵图里的上边沿。 |
| `sheet.regions[].width` | integer | yes | sheet pixels | - | 格子宽；等于 `frames.size.width * scale`。 |
| `sheet.regions[].height` | integer | yes | sheet pixels | - | 格子高；等于 `frames.size.height * scale`。 |
| `pivot` | object | yes | - | canvas centre | 精灵的旋转/缩放原点。永远存在：每一个引擎都需要一个，而一个不得不猜的导入器会得到一个悬在地面上方半个身子的人物精灵。 |
| `pivot.x` | number | yes | canvas pixels | `frames.size.width / 2` | 从左边沿起算。可能是小数（画布为奇数时），也可能正好落在右边缘上。 |
| `pivot.y` | number | yes | canvas pixels | `frames.size.height / 2` | 从上边沿起算。可能是小数，也可能落在下边缘上。 |
| `pivot.source` | enum | yes | - | `default` | `default` 表示没有人选过、这是文档记录的兜底值；`rig-part` 表示它来自某个 rig 部件。见 S7.1。 |
| `palette` | object | no | - | - | 这份画作据以上色的调色板。不能从 PNG 推导：像素携带了颜色，但没有携带它们的索引、顺序或名字，而一条色阶没法从一份扁平的色板列表重建。缺席意味着「这个资产不带调色板约束」，对满 RGB 的画来说这是一个真实状态；它绝不意味着「16 色」。 |
| `palette.name` | string | yes | - | - | 调色板名字，给要展示色板的工具用。 |
| `palette.locked` | boolean | yes | - | `false` | 这份画作是否被吸附到了这个调色板。advisory——它描述的是画是怎么做的，**不在**哈希覆盖范围内（S4.2），并且它是关于改色的提示，不是要强制的约束。 |
| `palette.colors` | string[] | yes | hex | - | 按**调色板索引顺序**排列的色板，也就是画作寻址它们时用的顺序。`#rrggbb`，或者在某个色板不完全不透明时用 `#rrggbbaa`。至少一个。索引顺序就是契约；排序后的顺序是另一个资产。 |
| `palette.roles` | object | no | - | - | 按**十进制调色板索引**给出的语义角色，例如 `{"3": "skin"}`。只有文档里有角色时才出现。按数字索引排序写出。 |
| `license` | object | no | - | - | 许可信息。可选，且**绝不臆造**：缺席意味着「未指定」，这与公有领域不同，也不得当作许可。文档模型没有许可字段，所以这是唯一一个由调用方提供的块。 |
| `license.spdx` | string | yes | - | - | SPDX 标识符，例如 `CC0-1.0`。`license` 出现时必填，因为一个机器无法据以分支的许可只是一条注释。 |
| `license.name` | string | no | - | - | 人类可读的许可名字，当它与 SPDX id 不同时。 |
| `license.url` | string | no | - | - | 完整文本的位置，如果它不在 SPDX id 的规范页面上。 |
| `license.attribution` | string | no | - | - | 许可要求时游戏必须显示的署名行。 |
| `outputs` | object[] | no | - | - | 包里的其余文件。当包里只有一张精灵图、别的什么都没有时缺席。 |
| `outputs[]` | object | yes | - | - | 一个文件。为了完整性而列出；它就是上面那个数组的元素形状。 |
| `outputs[].role` | enum | yes | - | - | `source`、`frame`、`sheet-json`、`gif` 或 `contact-sheet`。`sheet` 是**保留**的并且会被拒绝——精灵图的路径是 `sheet.image`，列两遍等于让同一条路径有两次机会互相矛盾。 |
| `outputs[].path` | string | yes | path | - | 相对于本文件，正斜杠。见 S5.1。 |

### 5.1 包内的路径

每一个路径字段——`sheet.image` 和每一个 `outputs[].path`——都遵守同一条规则：

- **相对**于放着 `meta.json` 的目录。绝对路径（包括 Windows 盘符）是错误
  （`path-absolute`）。这个文件必须能在被搬进游戏工程之后继续存活，而画师机器上的
  绝对路径正是唯一活不下来的那种东西。
- **不允许 `..` 段，且只允许正斜杠。** 指向包外的路径，或者使用了 Windows 分隔符的
  路径，是错误（`path-escapes-bundle`）。
- 在 `outputs` 内**唯一**（`path-duplicate`）。

---

## 6. 时序、顺序与循环

契约表达了三件事，并且是以一种能挺过「被翻译成一个支持得更少的引擎」的方式表达的。

**逐帧时序是重点。** `frames.durationsMs` 是位置式的，也是权威的。`frames.fps` 与
`animations.items[].fps` 是给只吃一个数字的引擎的派生便利值，一个两者都拿到的读取方
必须优先用 `durationsMs`。

**播放顺序是预先展开的。** `animations.items[].frames` 是要显示的帧索引的字面列表，
按顺序排列。`from`、`to` 和 `direction` 也在那里，并且会拿它来校验，但它们是为
「想在 UI 里显示一个区间」的工具准备的——不是为播放准备的。0 到 2 帧上的 pingpong 是
`[0, 1, 2, 1]`：返回那条腿把**两个**端点帧都省掉了，因为它们在这个周期里已经播过一次，
重复它们正是让一次往返在视觉上磕一下的原因。0 到 2 帧上的 reverse 是 `[2, 1, 0]`。

**循环是一个布尔值，而且是从一个哨兵值派生出来的。** `loop === (repeat === 0)`，校验器
拒绝任何两者不一致的文件（`animation-loop-mismatch`）。`repeat` 是**播放遍数**：
`durationMs` 和 `fps` 永远描述一遍，所以一次三段攻击是 `repeat: 1`，而一个保持一秒的
定格姿势是 `repeat: 1, durationMs: 1000`，不是 `durationMs: 1000, repeat: 100`。

| `repeat` | `loop` | 含义 |
| --- | --- | --- |
| `0` | `true` | 永远循环。 |
| `1` | `false` | 播一遍并停在最后一帧。 |
| `n > 1` | `false` | 播 `n` 遍并停在最后一帧。 |

---

## 7. 必填与派生

**规则：凡是能从像素上读出来的东西，都不必填。**

一个可派生的字段绝不能是必填输入，否则只要有人手改一个文件，契约就会与画作脱节。所以：

- **必填**是画作*无法*告诉你的东西：时序（`frames.durationsMs`）和身份
  （`asset.contentHash`）、名字、帧尺寸（精灵图的尺寸对格子的尺寸什么也说明不了），
  以及支点，因为引擎需要一个原点，而猜就是等着发生的 bug。
- **派生**字段仍然会被输出，也仍然会被校验。完整列表是 `frames.totalMs`、`frames.fps`、
  `animations.items[].durationMs`、`animations.items[].fps`、`sheet.scale` 以及
  `sheet.regions[]` 的逐格身份（`index`、`width`、`height`）：它们每一个都可以从文件
  的其余部分重算出来，所以校验器会把每一个都重算一遍，并在不一致时以
  `frame-total-mismatch`、`fps-mismatch`、`animation-duration-mismatch`、
  `sheet-region-count-mismatch` 和 `sheet-region-size-mismatch` 拒绝。

`frames.size`、`sheet.columns`、`sheet.rows`、`sheet.size` 以及 `sheet.regions[]` 的位置
字段是几何的**权威**陈述而不是派生值，而且每一个都有一个理由：画布尺寸在契约的别处
根本没有出现过，而打包器的缝隙与边框——任何按位置重算都会需要的两个参数——是刻意
不记录的（S10）。一个想摆放格子的读取方应当读 `sheet.regions[]`；一个想确认自己看的是
一份自洽文件的读取方可以依赖 S8 里的行主序与图内检查。

这仍然给了导入方一个选择：读派生字段并在它们过期时被告知，或者自己重算并忽略文件里的
副本。两种做法都是安全的，而且第二种不要求这个文件是由本生成器写出的。

### 7.1 为什么 `pivot` 永远存在，以及 `pivot.source` 是干什么的

即使没有人选过支点，`pivot` 也会被输出，因为每一个引擎都需要一个原点，而一个靠猜的
导入器会猜错。它**不该**做的是把猜测*声称*成是一个决定，所以 `pivot.source` 承担了这份
诚实：

- `default`——画布中心。校验为恰好是这个值，所以一个手改过的文件无法把一个被选定的
  支点说成兜底值。
- `rig-part`——取自文档的 rig，当 rig 有**恰好一个**部件时。只有一个部件的 rig 没有可挂
  父节点的东西、也没有别的地方可以挂锚点，所以它的支点是没有歧义的。两个部件意味着
  这个 rig 是一副骨架，而精灵自己的原点确实尚未决定，于是适用 `default`。

单位是**画布像素**，与文档模型里的 `RigPart.pivot` 一致。S9 给出每个引擎需要的换算。

---

## 8. 诊断码

一个必须服务五个消费者的读取方要报告的是发现（findings）而不是一个布尔值，因为一个
缺失的字段、一个来自未来的字段、以及一份区域已经对不上的精灵图，是三种不同的回应。
每一条发现都是 `{ code, severity, path, message }`：`code` 和 `path` 是 API，`message`
是给人看的、不得被解析。`path` 是点号路径（`animations.items[2].name`），根节点为空。

severity 就是 S3 的全部内容：`advisory` 意味着「跨版本边界的正常运作」，`error` 意味着
「这个文件是错的」。

| 码 | severity | 含义 |
| --- | --- | --- |
| `not-json-object` | error | 根不是一个 JSON 对象。关于这个文件再也无法说别的。 |
| `missing-field` | error | 一个必填字段缺席。 |
| `invalid-type` | error | 字段存在，但 JSON 类型不对。 |
| `out-of-range` | error | 类型对，但落在许可范围之外。 |
| `invalid-value` | error | 类型对，但不是许可取值：枚举成员不对、本该是整数的地方不是整数、字符串格式错误。 |
| `schema-version-unsupported` | advisory | `schemaVersion` 比这个读取方理解的更新。读你认识的字段。 |
| `unknown-field` | advisory | 这个读取方不认识的字段。更新的写入方是合法的；相信它无害之前，先检查有没有配对的 `missing-field`。 |
| `content-hash-malformed` | error | `asset.contentHash` 不是 `sha256:` 加 64 位小写十六进制数字。 |
| `frame-count-mismatch` | error | `frames.durationsMs.length` 不等于 `frames.count`。 |
| `frame-total-mismatch` | error | `frames.totalMs` 不等于 `frames.durationsMs` 之和。 |
| `fps-mismatch` | error | `frames.fps` 不是文档记录的时长平均值。 |
| `sheet-region-size-mismatch` | error | 一个精灵图格子不等于 `frames.size * sheet.scale`。 |
| `sheet-region-mismatch` | error | 一个格子越出了精灵图，或者格子不按 `columns` 蕴含的行主序排列。 |
| `sheet-region-count-mismatch` | error | `sheet.regions` 没有每帧一条，或者它的条目不按时间线顺序。 |
| `sheet-size-mismatch` | error | `sheet.size` 对它本该容纳的格子来说太小了。 |
| `animation-frame-out-of-bounds` | error | 一个动画点名了一帧时间线上没有的帧。 |
| `animation-order-mismatch` | error | `frames` 不是 `from`/`to`/`direction` 蕴含的播放顺序。 |
| `animation-loop-mismatch` | error | `loop` 与 `repeat === 0` 不一致。 |
| `animation-duration-mismatch` | error | `durationMs` 不等于它列出的那些帧的时长之和。 |
| `duplicate-animation-name` | error | 两个动画同名，游戏代码无法分别寻址它们。 |
| `unknown-default-animation` | error | `animations.default` 点名了一个不在 `items` 里的动画。 |
| `pivot-not-at-default` | error | `pivot.source` 是 `default` 但支点不在画布中心。 |
| `pivot-out-of-bounds` | error | 支点在画布矩形之外。支点落在边缘上是可以的。 |
| `palette-role-key-invalid` | error | 一个 `palette.roles` 的键不是十进制整数。 |
| `palette-index-out-of-range` | error | 一个 `palette.roles` 的键点名了一个不在 `palette.colors` 里的索引。 |
| `path-absolute` | error | 一个路径字段是绝对的，所以这个包无法被搬动（S5.1）。 |
| `path-escapes-bundle` | error | 一个路径字段不可移植：它含有一个 `..` 段，或者用了反斜杠而不是正斜杠。 |
| `path-duplicate` | error | 两条 `outputs` 条目指向同一个文件。 |
| `reserved-output-role` | error | 一条 `outputs` 条目用了保留的 `sheet` 角色，而它与 `sheet.image` 重复。 |

发现按 `path` 再按 `code` 排序，用普通字节比较而不是与区域设置相关的排序规则，这样
对一个文件跑两次会产出同一份列表。

---

## 9. 各引擎的注意事项

有损的映射，放在最前面写明，因为一个走到一半才发现它们的导入器，就是一个会发布出
细微错误动画的导入器。

### 9.1 Godot

- `SpriteSheet` 接收一个格子尺寸和一个每个动画一份的 `SpriteFrames`，后者只有**一个**
  fps 和一个循环标志，所以逐帧时长无法被精确表达。取 `animations.items[].fps`，原样取
  `loop`，并且接受一条 100/100/200 ms 的时间线会被播成 250/250/250 ms。这是
  `AnimatedSprite2D` 的限制，不是契约的限制：一个需要精确时序的 Godot 导入器必须用脚本
  从 `frames.durationsMs` 驱动 `SpriteFrames`，而不是走动画播放器。
- `Sprite2D.offset` 是**以中心为基准的像素值**：
  `offset = (pivot.x - frames.size.width / 2, pivot.y - frames.size.height / 2)`。注意
  符号约定——Godot 的 offset 移动的是被绘制的精灵，所以位于脚下的支点对应一个*正*的
  Y offset。
- `sheet.regions` 映射到一个带显式区域的图集纹理，而不是网格切图；当
  `columns`/`rows` 就是全部故事时，映射到网格切图。
- 逐帧时序和循环在 `SpriteFrames` 资源里都存在，所以除了*速率*之外没有东西丢失。

### 9.2 Unity

- `Sprite.pivot` 是一个**归一化**的点：`pivot / frames.size`。一个精灵编辑器的默认值是
  `(0.5, 0.5)`，而那恰好就是 `pivot.source == "default"` 的含义。
- Unity 的 `SpriteAtlas` 切片器是基于网格的，所以 `columns`/`rows` 才是 Unity 导入器真正
  需要的东西；`sheet.regions` 是交叉校验。
- 除非这个 clip 是按正确时间点用关键帧创作的，否则 Unity 在单个 `AnimationClip` 内部
  没有逐帧时序，而那正是正确答案：从 `animations.items[].frames` 构建 clip，把每一帧的
  关键帧放在 `cumulative duration` 上。
- `AnimationClip.wrapMode` 直接接收 `loop`。

### 9.3 Phaser

- `load.spritesheet(key, url, { frameWidth, frameHeight })` 接收 `frames.size`，并且完全
  忽略 `sheet.regions`。一个不能整除的网格，或者一张 `scale > 1` 的精灵图，需要一份
  纹理图集 JSON，也就是 `outputs[].role == "sheet-json"`。
- `anims.create({ key, frames, frameRate, repeat })` 接收一个**帧列表**，那恰好就是
  `animations.items[].frames`，而 `repeat: -1` 对应 `loop`、`repeat: n - 1` 对应 `n` 遍
  的遍数，因为 Phaser 是在第一次播放**之后**开始数重复的。
- `frameRate` 是 `animations.items[].fps`；Phaser 没有逐帧时序。

### 9.4 Excalidraw

- Excalidraw 没有动画也没有图集。诚实的映射是每个元素一帧：输出第 0 帧，或者
  `animations.default` 的第一帧，作为被绘制的图像，并用 `frames.size` 把它按 1:1 放到
  画布上。
- `pivot` 无法表达；一个角色精灵应该属于一个名字就是支点约定的图层，那是 T-055 的事，
  不是本契约的事。

---

## 10. 刻意缺席的东西

这里的每一项都被考虑过并被排除在外，连同理由一起写下来，因为一个发现字段缺失的读取方
必须能分辨「还没建模」与「不需要」。

| 缺席的东西 | 为什么 |
| --- | --- |
| 图块集与瓦片地图契约 | 另一份技术契约：格子几何、图块属性、地形边缘。`kind` 是封闭枚举，生成器对带图块集的文档会**抛错**，而不是写一个 `kind: "sprite"` 的文件。 |
| `sheet.layout`、`sheet.padding`、`sheet.margin` | `buildSpritesheet` 不返回它们，所以在这里记录它们就意味着在第二个地方重新推导打包器状态，并任由两者漂移。代价是 `sheet.regions[]` 是权威而不是可重算的，这一点 S5 和 S7 都明说了。 |
| Rig 部件、姿势、补间、锚点、碰撞盒 | 那些是创作期的结构，住在 `.pixel` 源文件和 Aseprite 精灵图 JSON 里。唯一有引擎侧后果的那一块，也就是支点，被投影成了 `pivot`。 |
| 图层名、顺序、不透明度、混合模式 | 它们描述的是画是怎么做的，不是它是什么。合成结果相同的两个图层就是同一个资产，而 S4.2 依赖这件事为真。 |
| 一个 `canvas` 块 | 文档里的每一帧共享一个画布，所以 `frames.size` 已经说明白了。第二份副本就是第二样会漂移的东西。 |
| 一个带版本号的 generated-by 块 | 它每次发布都会变，于是每一个提交进仓库的 `meta.json` 在升级时都会产生一份 diff。契约自己的 `schemaVersion` 是读取方唯一需要的版本。 |
| 一个时间戳 | 生成的必须对同一个文档逐字节一致。见 S11。 |
| `outputs` 里的 `sheet` 角色 | 它会与 `sheet.image` 重复。 |

---

## 11. 给实现者的规则

**确定性。** 同一个文档必须在每一台机器上产出逐字节一致的 `meta.json`。具体地说：

1. 不要时间戳、不要生成器版本号、不要随机数或会话 id、不要主机名、不要绝对路径。
2. 任何与区域设置有关的东西都不要。用普通字节比较排序，绝不用 `localeCompare`，绝不用
   与区域设置有关的排序器，绝不用 `toLocaleString` 或 `Intl`。数字格式化必须是
   `Number.prototype.toString`，别无其它。
3. 键的顺序是 S5 的顺序。不要让一个哈希表、一个 ORM，或者一个带「键按字母排序」选项的
   JSON 库替你决定。
4. 浮点字段在写出之处就四舍五入到一个说明过的位数（S5 把它们标为派生）；绝不要输出一个
   原始的商。
5. 内容是用户数据的映射键，也就是 `palette.roles`，按调色板索引**按数字**排序，而不是
   按字典序，否则索引 10 会排在索引 9 前面。

**生成器宁可拒绝，也不猜。** 一个带图块集的文档、一个没有帧的文档、一个带小数帧时长
或亚毫秒时长的文档，都是错误。把时长四舍五入会让契约与它声称要描述的文档不一致；
为图块集输出 `kind: "sprite"` 会是那个自信的错误答案。两者都是一行 throw。

**绝不要臆造文档不知道的东西。** `license` 和 `outputs` 是调用方的选项。`pivot` 退化到
一个会把这件事说出来的值。契约里其余任何东西都不猜。

---

## 12. 机器可读的 schema

`@pixel/core` 公布了这份契约的 JSON Schema（`packages/core/src/asset/schema.ts` 里的
`assetMetaJsonSchema()`），用于**写入方**的校验：一个从别人手里接收 `meta.json` 的工具
可以在接收之前先检查它。

**不要**把它当作读取方的拒绝规则。它带着 `additionalProperties: false`，因为 schema 里
每一个对象都是严格的，而正是这种严格让 S3 的容错得以表达：一个严格的对象是把「一个我
从没听说过的字段」与「这个文件没问题」区分开来的唯一办法。一个拒绝未知字段的读取方，会
在规范第一次长大时弄坏每一个消费者。

---

## 13. 本契约的变更记录

| 版本 | 变更 |
| --- | --- |
| `1` | 第一版。精灵资产：画布、时间线、标签、精灵图、支点、调色板、许可、输出。 |

提升 `schemaVersion` 需要在同一次变更里在这里加一行带日期的记录和一个理由。
