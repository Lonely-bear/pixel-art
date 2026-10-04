# 这个 GitHub Action

<p align="center">
  <a href="ACTION.md">English</a> · <a href="ACTION-ZH.md">中文</a>
</p>

> 英文的 [ACTION.md](ACTION.md) 是正本，本文件是它的中文镜像；两者冲突时以英文为准。
> 标识符、输入名、默认值、路径与表格顺序都与英文逐字一致；**只翻译围绕它们的散文**。

`dotloom-mcp/build-assets` 在 CI 里运行一个项目的资源构建，并在资源不对时让任务失败。它是
[`API.md`](API.md) 那套说法的 CI 那一半：一个游戏项目把这个包当作 `devDependency` 引入，
在构建期生成精灵，而这个 Action 就是让那次生成发生在 PR 上，而不是发生在某个人的笔记本上。

```yaml
- uses: dotloom-mcp/build-assets@v1.0.0
  with:
    command: node tools/build-assets.mjs
    check-command: node tools/check-assets.mjs
    quality-gate: blocking
```

就这么多。`tools/build-assets.mjs` 就是 [`API.md` §A complete, runnable example](API.md#a-complete-runnable-example)
里的脚本，只改了路径；而 `tools/check-assets.mjs` 是
[§The determinism contract](API.md#the-determinism-contract) 里的确定性检查。

---

## 为什么用 composite action

**它在 runner 自己的 Node 上运行，而不是在容器镜像里，因为这个包有四个运行时依赖、
没有原生构建，而且一个游戏项目的构建脚本是*他们自己的*代码 —— Docker action 还得把他们
整个 `node_modules` 递进去才能跑它。** Docker action 还会钉死一个 OS 和一份 libc，而项目
自己的工具链又必须跟它们一致，这在这里买不到任何东西；`actions/setup-node` 加一个明确的
`node-version` 更快，而且可复现 —— 这正是一个产物要提交进仓库的构建所真正在意的性质。

---

## 输入

| Input | Default | What it does |
| --- | --- | --- |
| `command` | *(required)* | 构建命令，一行 shell 命令。项目本地已经在跑的任何东西都属于这里。 |
| `check-command` | `''` | 构建之后运行的可选命令；退出码非零就让任务失败。字节可复现性检查应该放在这里。留空表示跳过。 |
| `install-command` | `npm ci` | 依赖安装，在构建之前于 `working-directory` 中运行。设为 `''` 以跳过安装。 |
| `node-version` | `'22.13'` | runner 上的 Node.js 版本。默认值是本包的下限而不是 `latest`，这样同一个提交的两次运行渲染出同样的字节。 |
| `working-directory` | `'.'` | 其他所有路径都相对于它解析，也是命令运行所在的目录。 |
| `quality-gate` | `'off'` | `off` 只运行命令。`blocking` 还会额外度量 `asset-dir` 下的每一个 `.pixel` 文档，并在交付门禁拒绝其中之一时让任务失败。 |
| `gate-threshold` | `fail` | `quality-gate: blocking` 使用哪一档门禁阈值：`fail` 拒绝具名缺陷以及低于下限的维度；`warn` 还会拒绝偏低的加权总分。 |
| `asset-dir` | `assets/generated` | 门禁到哪里找 `.pixel` 文档，相对于 `working-directory`。 |

每一个输入的可运行示例 —— 包括首次运行通常会搞错的那几个 —— 在
[`example-assets.yml`](../.github/workflows/example-assets.yml) 里。这个 Action 自身的定义在
[`action.yml`](../.github/actions/build-assets/action.yml)，而
`packages/core/test/github-action.test.ts` 会在有人往那里加了输入却没在本文档里记录时失败。

---

## 这里「让构建失败」是什么意思

三件独立的事，其中第三件是可选的。

**1. 构建命令退出码非零。** 无条件成立，而且这是底线。某条 op 里参数写错、画布尺寸为零、
命令名未知：这些全都是共享总线抛出的 `CommandError`，都会让任务停下。

**2. 检查命令退出码非零。** 同样无条件成立，只要你设了。值得拥有的检查是确定性那个 ——
用同一份 spec 重建，再和已提交的文件逐字节比对：

```js
// tools/check-assets.mjs
import { readFile } from 'node:fs/promises';
import { buildSprite, exportAssets } from 'dotloom-mcp';
import { SLIME } from './slime-spec.mjs';

const [rebuilt] = exportAssets(buildSprite(SLIME), { source: true });
const committed = await readFile('assets/generated/slime.pixel');
if (!Buffer.from(rebuilt.bytes).equals(committed)) {
  console.error('slime.pixel changed — review the diff before committing it');
  process.exit(1);
}
```

把 spec 放进它自己的模块，这就是让「同样的输入，同样的字节」成为一道门禁而不是一句承诺的
检查。可运行的版本在
[`examples/check-assets.mjs`](../.github/actions/build-assets/examples/check-assets.mjs)。

**3. 质量门禁拒绝一份文档。** 需要 `quality-gate: blocking`，而且**默认关闭**，
因为评估规格书的 §6.2 只跑过一次，只跑在一张精灵上 —— 一道没人校准过的门禁就是一道会
挡住好成果的门禁。等你希望某个缺陷能拦住一次合并时再打开它。

门禁调用的是 `core.qualityGateForSprite`，和 `finalize_document` 在写任何东西之前调用的是
同一个函数，所以 CI 和交付路径不可能对「失败」是什么意思产生分歧。在默认的 `fail`
阈值下，它拒绝的是**具名缺陷**：严重度达到或超过 500/1000 的 issue，或者一个*被度量过*的
维度低于它的下限。

**建议级别永远不会让构建失败。** 低于那道线的是 `warn` 判定，不是 `fail` 判定。它会被
打印出来 —— 一条人类能看一眼的具名发现，比一片沉默更值钱 —— 然后任务继续。被排除的维度
同样从不拒绝：一份没有任何维度适用于它的文档会弃权并明说，而不是因为某种缺席而被判失败。

---

## 为什么日志里没有分数

这是唯一值得争论的设计点，因为这个仓库已经为此付出过一次代价。

`AGENTS.md` 记录了 `quality_report` 工具曾经发布、并在 0.3.1 被删除。原因是：
> 一个被告知那个数字「干净」的模型，把一个湖磨成了一块深色平板。

任何交给自动化系统的数字都会变成目标，而不是画面。那就是古德哈特定律如期而至，而一份
CI 日志就是一个有主见的自动化系统。所以门禁打印的是**缺陷** —— 一个 code、拥有它的维度、
它在哪儿，以及分析器自己那一句说明：

```text
FAIL assets/generated/slime.pixel - the delivery gate refuses this document:
       value/flat-value at (0,0) 16x16: one lightness bucket holds 1000/1000 of the solid
         pixels; the form is not being described by tone at all.
```

这就是一份 bug 报告。由人类来决定它是否重要。唯一那个来自加权分数而非具名缺陷的拒绝 ——
`aggregator/weighted-total` —— 是**有名字但没有数字**的：退出码照样把它算进去，而日志改为
指向上面那些缺陷。这个 Action 里没有任何地方会打印一个聚合质量分数，加一个就等于把当初
被删掉的那个工具请回来。

日志里确实出现的那些严重度数字（`550/1000`、`400/1000`）是逐个缺陷的度量，对应一个已
公布的逐缺陷切分，而不是关于画面的判定。它们是你区分阻断级缺陷和建议级缺陷的方式，而这
正是这个 Action 存在的意义：把那个决策自动化。

---

## 确定性

一个每次 CI 运行都产出不同字节的构建，比没有构建更糟，因为 `assets/` 里的 diff 会失去
*画面变了* 这个含义。

- 每一个产物都来自 `buildSprite` / `buildAnimation` / `exportAssets`，它们在调用期间装上
  一个带种子的 id 工厂，并把全部随机性取自引擎自己的 `rng.ts`。绘制路径里没有
  `Math.random`，也没有时钟，而 `packages/core/test/determinism.test.ts` 把两者都从 `src`
  里禁掉。
- `node-version` 默认取本包的下限而不是 `latest`，所以同一个提交的两次运行不会跨越一次
  V8 变更。
- 门禁按排序后的顺序遍历 `asset-dir`，也不查时钟，所以同一棵树的两次运行会以同样的顺序
  报告同样的缺陷。

---

## 第一次运行，以及会踩到什么

- **`command` 是必填的，而且没有默认值。** 构建脚本还不存在，是首次运行最常见的失败原因，
  而且它在第一步就失败，而不是到一半才失败。
- **门禁需要 `.pixel` 文件。** 它读的是 `source: true` 那个产物，因为那是唯一作为文档的
  输出。一个只写 PNG 和 GIF 的构建没有任何东西可供它度量，于是它会说明这一点并通过 ——
  那就设置 `asset-dir`，或者把门禁关掉。
- **`asset-dir` 相对于 `working-directory`。** 如果你的构建从一个 `tools/` 工作目录往
  `../assets` 写，默认值什么都找不到。
- **`install-command` 默认为 `npm ci`。** pnpm 或 yarn 的项目必须覆盖它，否则安装步骤会
  在构建之前失败。
- **`gate-threshold: warn` 不是默认值**，而且在你对自己的画面跑过门禁、知道它对这份画面
  说了什么之前，应该一直关着。`warn` 还会拒绝偏低的加权总分，而那是唯一一个把「弃权」与
  无关读数相抵扣的通道。

---

## 相关文档

- [`API.md`](API.md) —— 构建脚本所导入的那个库。
- [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md) —— `meta.json` 以及四个引擎导入器，
  `exportEngineAssets` 会从构建脚本驱动它们。
- [`EVALUATION.md`](EVALUATION.md) —— 六个维度各自度量什么，以及它们的阈值今天值多少。