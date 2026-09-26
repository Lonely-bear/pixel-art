# TASKS.md — dotloom-mcp 产品路线图执行总线

> 本文件是**唯一事件总线**。所有子代理与后续会话通过读取本文件的任务状态进行协调。
> **产品负责人(PO)是本文件的唯一写入者。** 子代理只读本文件、只改代码、只报告结果,不写本文件。
> 这样并行执行不会产生写冲突,状态流转也只有一个权威来源。

---

## 0. 协作协议(所有子代理必读)

| 规则 | 说明 |
| --- | --- |
| **不越界** | 只做分配给你的那一个任务。不要碰其它任务的文件,不要"顺手改进"相邻模块。 |
| **不写本文件** | TASKS.md 由 PO 独占写入。你在最终回复里报告状态即可。 |
| **不碰 git** | 不要 `git add` / `commit` / `checkout` / `branch`。所有提交由 PO 执行。 |
| **不装依赖** | 禁止新增任何运行时依赖。`packages/core` 必须保持零新增 runtime dep。 |
| **改动范围白名单** | 任务卡里列出的文件才是你的改动范围。需要动别的文件 → 停止并报告。 |
| **必须自验** | 交付前跑 `pnpm --filter <pkg> exec vitest run <你的测试文件>` 与 `pnpm --filter <pkg> typecheck`。 |
| **注释是产品** | 本仓库的注释解释"为什么",不是"是什么"。zod 的 `.describe()` 是 Agent 读到的产品文案。 |
| **风格基线** | 严格 TypeScript,2 空格,单引号,尾逗号,`NodeNext` + 相对导入带 `.js` 后缀。 |

### 任务标记图例

| 标记 | 含义 | 处理方式 |
| --- | --- | --- |
| 🤖 | **完全可自主完成** | PO 派发子代理实现,PO 验收 |
| 🔶 | 主体自主,但存在**指定的人类卡点** | 先做自主部分,在卡点处标记 `BLOCKED:HUMAN` 并附交接简报 |
| 👤 | **必须人类参与** | 不派发。PO 编写详细交接简报,由人类执行 |

### 状态流转

```
TODO → CLAIMED → IN_PROGRESS → REVIEW → ACCEPTED → COMMITTED
                                        ↓
                                     REWORK (验收不通过,退回重做)
```

---

## 1. 已锁定的产品决策(PO 决策,子代理不得推翻)

| 决策 | 内容 | 依据 |
| --- | --- | --- |
| **D-1 范围** | 尽量推进全部可自主完成项,无阶段边界。多会话接力,`TASKS.md` 承接上下文。 | 老板决策 |
| **D-2 分支** | 单集成分支 `agent/roadmap-2026`,逐任务 commit。`master` 保持发布可用。 | 老板决策 |
| **D-3 语言** | 英文为主 + 中文镜像同步。`README.md` / `docs/*.md` 英文,`README-ZH.md` 与 `docs/*-ZH.md` 同步。 | 老板决策 |
| **D-4 依赖** | `packages/core` 零新增运行时依赖,一切自研。 | 老板决策 |
| **D-5 产品定位** | **不是图像生成器,是游戏资产管线。** 像素画不是图片,是受约束的、量化的、网格精确的、有技术契约的资产。全部功能按此定位排序。 | PO 决策 |
| **D-6 不做的事** | ① 不再加绘图命令(90 个已超 Agent 选择能力上限,瓶颈是判断力) ② 不做 Figma 替代品 ③ 不重写 Web 编辑器 ④ 不先做 20 种导出格式 | PO 决策 |

### 核心护城河:判断层

Agent 能画,但画完不知道对不对。`get_preview` 只能让人看,不能机器判定。
**整个 Phase 1.1 都在补这一层。** 这是本路线图唯一不可被快速复制的部分 —— 命令可以被抄,评分算法可以被抄,基准语料和校准结果抄不走。

---

## 2. PO 锁定的架构决策(防止子代理各自发明)

> 以下由 PO 预先裁定。子代理**必须**遵守,不要自行改变模块划分或接口形状。

### AD-1:质量分析模块布局

```
packages/core/src/quality/
  types.ts        ← 先行,定义全部接口(其它任务依赖它)
  silhouette.ts   ← 轮廓可读性
  value.ts        ← 明度结构
  palette.ts      ← 色彩纪律
  noise.ts        ← 噪点/杂散像素
  outline.ts      ← 描边一致性
  motion.ts       ← 动画循环接缝 / 帧间抖动
  index.ts        ← 聚合器,最后写
```

**依赖顺序:`types.ts` 必须先落地**,其余分析器可并行。`index.ts` 最后由一个代理写。

### AD-2:质量分析器接口形状

```ts
// packages/core/src/quality/types.ts
export interface QualityDimension {
  /** 0..1,越高越好。所有维度统一到 0..1,便于加权。 */
  readonly score: number;
  /** 人类/Agent 可读的一句话判定。 */
  readonly verdict: string;
  /** 可执行修复建议;为空表示该维度无需处理。 */
  readonly issues: readonly QualityIssue[];
}

export interface QualityIssue {
  /** 稳定的机器可读代码,例如 'low-contrast'。Agent 按 code 分支。 */
  readonly code: string;
  /** 人类可读说明。 */
  readonly message: string;
  /** 建议修复的像素区域;无法定位时为 null。 */
  readonly rect: Rect | null;
  /** 严重度 0..1,>= 0.5 视为阻断。 */
  readonly severity: number;
}

export interface QualityReport {
  readonly dimensions: Readonly<Record<QualityDimensionId, QualityDimension>>;
  /** 加权总分 0..1。 */
  readonly score: number;
  /** 达到该分数即视为可交付。 */
  readonly verdict: 'pass' | 'warn' | 'fail';
  /** 阻断级问题汇总;非空时 verdict 一定不为 'pass'。 */
  readonly blocking: readonly QualityIssue[];
}
```

**硬约束:**
- `Rect` 来自 `packages/core/src/types.js`(不是 `PixelRect` —— core 里没有这个类型)。
- 全部确定性。禁止随机数、禁止时间戳、禁止依赖浮点平台差异的未定义行为。
- 相同输入必须得到逐位相同输出(这是 CI 里做回归比对的前提)。
- 单维度分析器**只读 sprite,绝不写**。它们不是 command,没有 undo 语义。
- 所有分数归一化到 `0..1`,加权时用 `QualityWeights`(放 `types.ts`)。

### AD-3:现有代码必须遵守的既有约定(不可重新发明)

- 命令用 `defineCommand`,参数 zod 必须 `.describe()`,顶层自动 `.strict()`。
- 像素数据是 copy-on-write:经 `draft.cel()` / `tilesetImage()` / `tilemapData()` 获取,禁止原地改 `PixelBuffer`。
- 颜色支持调色板简写:`3` / `"pal:3"` / `"palette 3"` / `"pal#3"`。
- 坐标:原点在左上,x 向右,**y 向下增长**,全 0-based;矩形 `{x, y, w, h}`。
- 失败一律 `CommandError` 并带 `code`,Agent 按 `code` 分支而非解析文案。

---

## 3. 任务总表

### Phase 0 · 可信度 —— 让人一分钟内信服

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-002 | 🤖 | `pixel demo` 一键演示子命令:零配置端到端产出一张成品 sprite | IN_PROGRESS |
| T-003 | 🤖 | Showcase 生成工装:用真实 MCP 工具面生成作品 + 完整 ops JSON | TODO |
| T-004 | 🤖 | `showcase/` 索引页 + 一键复现说明 | TODO |
| T-007 | 🤖 | 真实 benchmark 测量脚本(耗时 / token / 命令数) | TODO |
| T-005 | 🤖 | README 首屏重构(英文) | TODO |
| T-006 | 🤖 | README-ZH 镜像同步 | TODO |
| T-008 | 🤖 | 把 benchmark 真实数字嵌入 README | TODO |
| T-090 | 👤 | 首屏 demo GIF / 视频录制 | HUMAN-READY |

### Phase 1.1 · 判断层 ⭐ 最高杠杆

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-010 | 🤖 | 评分规则规格书 `docs/EVALUATION.md` | IN_PROGRESS |
| T-011 | 🤖 | `quality/types.ts` — 全部接口与权重(AD-2) | ACCEPTED |
| T-012 | 🤖 | 轮廓可读性分析器 `quality/silhouette.ts` | BLOCKED:T-010 |
| T-013 | 🤖 | 明度结构分析器 `quality/value.ts` | BLOCKED:T-010 |
| T-014 | 🤖 | 色彩纪律分析器 `quality/palette.ts` | BLOCKED:T-010 |
| T-015 | 🤖 | 噪点 / 杂散像素检测器 `quality/noise.ts` | BLOCKED:T-010 |
| T-016 | 🤖 | 描边一致性分析器 `quality/outline.ts` | BLOCKED:T-010 |
| T-017 | 🤖 | 动画循环接缝 / 帧间抖动分析器 `quality/motion.ts` | BLOCKED:T-010 |
| T-018 | 🤖 | `quality/index.ts` 聚合器 + 加权总分 | TODO |
| T-019 | 🤖 | `evaluate` 命令接入命令总线 | TODO |
| T-020 | 🤖 | `evaluate` MCP 工具 + `pixel://quality/{doc}` 资源 | TODO |
| T-021 | 🤖 | 基准语料格式 + 语料构建器 | TODO |
| T-022 | 🤖 | 校准工具:分析器输出 vs 期望基线 | TODO |
| T-023 | 🤖 | `fix` 命令:按 issue 生成可执行修复 ops | TODO |
| T-024 | 🤖 | `verify` 硬门禁:不合格拒绝 `finalize_document` | TODO |
| T-025 | 🔶 | 准确率报告(卡点:T-026) | BLOCKED:HUMAN |
| T-026 | 👤 | 200 张专家评分基准集的人工评分 | HUMAN-READY |

### Phase 1.5 · 配方库

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-030 | 🤖 | 配方格式规格 + `recipes/` 布局 | TODO |
| T-031 | 🤖 | `platformer` 配方 | TODO |
| T-032 | 🤖 | `topdown-rpg` 配方 | TODO |
| T-033 | 🤖 | `dungeon-tileset` 配方 | TODO |
| T-034 | 🤖 | `ui-icons` 配方 | TODO |
| T-035 | 🤖 | `item-icons` 配方 | TODO |
| T-036 | 🤖 | `describe_recipe` MCP 工具 + `pixel://recipe/{id}` 资源 | TODO |

### Phase 1.6 · 8 方向角色 ⭐ 最强 star 磁铁

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-040 | 🤖 | 方向化骨架规格:8 方向角度定义 + 朝向锚点约定 | TODO |
| T-041 | 🤖 | 8 方向行走循环生成命令 | TODO |
| T-042 | 🤖 | 方向感知预览(接触表 / 方向罗盘) | TODO |
| T-043 | 🤖 | 8 方向图集导出 + 帧元数据 | TODO |

### Phase 1.7 · 资产契约与生态导入器

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-050 | 🤖 | 资产元数据契约 `meta.json` 规格 + 生成器 | TODO |
| T-051 | 🤖 | Godot 导入器 + 模板工程 | TODO |
| T-052 | 🤖 | Unity 导入包 | TODO |
| T-053 | 🤖 | Phaser 导入器 | TODO |
| T-054 | 🤖 | Excalidraw 导入器 | TODO |
| T-055 | 🤖 | 命名规范校验器 | TODO |

### Phase 1.8 · 格式缺口

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-060 | 🤖 | SVG 描摹导入(位图轮廓 → cel) | TODO |
| T-061 | 🔶 | `.aseprite` 原生读取(卡点:格式逆向验证) | TODO |

### Phase 2 · 基础设施

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-070 | 🤖 | 稳定程序化 API 面(游戏项目 `devDependency` 友好) | TODO |
| T-071 | 🤖 | 确定性种子 → 可复现资产管线 | IN_PROGRESS |
| T-072 | 🤖 | GitHub Action:构建期生成资产 + 徽章 | TODO |
| T-073 | 🤖 | 插件市场规格 + 分发格式 | TODO |
| T-074 | 🤖 | 团队共享调色板 / 风格 / 配方 | TODO |
| T-075 | 🤖 | 4096² 画布与批量渲染性能 | TODO |
| T-076 | 🤖 | Cookbook(英文) | TODO |
| T-077 | 🤖 | Cookbook 中文镜像 | TODO |
| T-078 | 🤖 | 主流客户端一键配置包(claude / cursor / opencode / windsurf) | TODO |
| T-079 | 👤 | MCP 注册表正式上架 | HUMAN-READY |

### Phase 3 · 传播与社区

| ID | 标记 | 任务 | 状态 |
| --- | --- | --- | --- |
| T-080 | 🤖 | 导出即传播:PNG 内嵌元数据 + `made with` 徽章 | TODO |
| T-081 | 🤖 | 静态 Gallery 站点(构建期生成) | TODO |
| T-082 | 🤖 | 分享模板(社交图 / 复现链接) | TODO |
| T-083 | 🤖 | 1.0 稳定化:版本策略 + 迁移指南 + RFC 流程 | TODO |
| T-084 | 🤖 | 治理文件:CONTRIBUTING / good-first-issue / CoC | IN_PROGRESS |
| T-085 | 🤖 | 技术长文:lazy tool surface 与单总线设计 | TODO |
| T-086 | 🤖 | 月度挑战基础设施 | TODO |
| T-087 | 👤 | Gallery 站点托管与域名 | HUMAN-READY |
| T-088 | 👤 | 知名像素画师合作 | HUMAN-READY |
| T-089 | 👤 | 代码签名证书(macOS 公证 / Windows Authenticode) | HUMAN-READY |

---

## 4. 必须人类参与的任务 — 交接简报

> 以下任务 PO 不派发。以下简报已写到可直接执行的粒度。

### T-026 · 200 张专家评分基准集的人工评分

**为什么必须是人:** 像素美术的"好"没有解析定义。校准 `evaluate` 需要的是**人类专家的主观判断作为标尺**,而这个标尺无法由算法生成 —— 用算法标注的数据去校准算法是循环论证。这是整个护城河唯一无法自动化的一环,也是它值钱的原因。

**现状:** T-021 会交付一个带语料与工具的基准框架,语料由程序化生成 + 本仓库 `artwork/` 现有作品构成,规模约 200 张,每张附带客观可测量属性(尺寸、调色板数、帧数、是否 8 方向等)。**缺的只是人工打分。**

**需要你做的:**
1. 对每张图按 `docs/EVALUATION.md`(T-010 交付)的六个维度打 1-5 分,外加一个总体「可用 / 需改 / 不可用」三档判定。
2. 评审人建议:至少 2 名有像素画经验的评审独立打分,以**两人一致**作为该图的真值;不一致的图进第三轮仲裁。
3. 产出 `benchmarks/corpus/scores.json`,格式由 T-021 定义。

**验收:** T-022 的校准工具跑出分析器与人工评分的相关系数,目标 Pearson r > 0.7;T-025 出准确率报告。若 r 不达标,回到分析器调权重(权重是确定的、可解释的,不是过拟合出来的黑盒)。

**为什么这件事值得你亲自做:** 它是 `evaluate` 从"一个我写的启发式"变成"一个对齐了人类审美判断的标准"的分界线,也是这个产品 10k star 叙事里唯一无法被质疑的部分。

---

### T-079 · MCP 注册表正式上架

**为什么必须是人:** 需要你的开发者账号、需要接受平台 ToS、需要人工审核沟通。这些是法律主体行为,我不应代做。

**我已经准备好的前置(自动完成,无需你动手):** T-078 产出一键配置包;`README.md` 已有 MCP 配置章节;`packages/mcp` 的 server description 与 `instructions` 已达发布质量。

**你只需:** 注册 → 提交 → 处理审核问询。上架后的分发效果直接决定 Phase 2 的天花板。

---

### T-089 · 代码签名证书

**为什么必须是人:** 需要购买证书 / 持有 Apple Developer Program 账号 / 保管私钥。这些涉及付费账户与密钥材料,只能由人操作。

**好消息:** 流水线已就绪。`release.yml` 已经支持 `CSC_LINK` / `APPLE_ID` 等全部环境变量,加证书**不需要改任何代码或配置**。填入仓库 secrets 后推新 tag 即可。

**注意:** 未签名前 macOS 首次启动需右键 Open,Windows 会有 SmartScreen 提示。签名开启后 macOS 自更新会自动生效(构建时已通过 `__PIXEL_CODESIGNED__` 告知应用)。

---

### T-087 / T-088 / T-090 · 社区、域名、内容录制

- **T-087 Gallery 托管:** 站点代码我交付(T-081),域名与托管需要你的账户。
- **T-088 像素画师合作:** 需要你的社交关系与商务沟通。
- **T-090 首屏演示素材:** 需要人在真实桌面端操作录屏。脚本与素材我准备好后,录制这一步需要你(或任何能开摄像头的人)执行。

---

## 5. 执行波次

> PO 按依赖关系逐波派发。每波的任务之间**文件不重叠**,可安全并行。

### Wave 1 · 地基(Wave 1 中 T-010 与 T-002 已与 T-011 并行启动,文件互不重叠)

| 顺序 | ID | 产出 | 子代理会话 |
| --- | --- | --- | --- |
| 1 | T-011 | `packages/core/src/quality/types.ts` — 全部接口冻结 | `ses_f20787e96ffeJlZRc4Ls51S9t7` |
| 1b | T-010 | `docs/EVALUATION.md` — 评分规则规格书(并行) | `ses_f20787e95ffeP213BWhl2JjihN` |
| 1c | T-002 | `pixel demo` 子命令(并行) | `ses_f20787e94fferLv6ktVVLL3Pxp` |

**T-011 完成后,Wave 2 的六个分析器可完全并行。**

### Wave 2 · 六维分析器(全并行,文件互不重叠)

T-012 · T-013 · T-014 · T-015 · T-016 · T-017

### Wave 3 · 收敛

T-018(聚合) → T-019(命令) → T-020(工具) → T-021(基准框架) → T-022(校准)

### Wave 4 · 变现与传播

T-003 → T-004 → T-005 → T-006 → T-007 → T-008

### Wave 5+

配方库 → 8 方向 → 导入器 → 基础设施 → 社区

---

## 6. 活动日志

> PO 追加。每条记录一个任务的生命周期与验收结论。

| 时间 | 任务 | 事件 | 结论 / Commit |
| --- | --- | --- | --- |
| D0 | — | 路线图确立,任务总线建立 | 分支 `agent/roadmap-2026` 起点 `c528ca9` |
| D0 | — | `AGENTS.md` 落地 | `b6159c2` |
| D0 | — | `TASKS.md` 落地 | `4f447a3` |
| D0 | — | 修正 AD-2:`PixelRect` → core 实际类型 `Rect` | 待随下次提交 |
| D0 | T-011 | 派发,冻结质量分析接口 | IN_PROGRESS |
| D0 | T-010 | 派发,评分规则规格书 | IN_PROGRESS |
| D0 | T-002 | 派发,`pixel demo` | IN_PROGRESS |
| D0 | — | MCP 工具面冒烟验证通过(`create_document`→`apply_ops`→`read_grid`) | T-003 管线风险解除 |
| D1 | T-011 | **首次验收 REWORK**:文件末尾 `declare const` 编译守卫失效,且代理声称"已证明会触发"而实际未做 | 退回返工 |
| D1 | T-011 | 返工:改为 `AssertTrue<T extends true>` 约束别名,并扩展为覆盖三个来源的检查 | 复核通过 |
| D1 | T-011 | **验收通过**。PO 独立复核:违反态报 TS2344 `missingFrom: "QUALITY_DIMENSIONS"`,干净态 EXIT=0 | `367134b` |
| D1 | T-071 | 派发,确定性保证(基准基线的前置条件) | IN_PROGRESS |
| D1 | T-084 | 派发,治理文件 | IN_PROGRESS |
| D1 | T-012~017 | 六个分析器标记 `BLOCKED:T-010` | 规格优先,不得绕过 |

### 并发策略(PO 裁定)

单工作树下**并发上限 4 个子代理**。超出会引入不可控的构建与类型检查竞争,收益递减。
Wave 2 的六个分析器虽文件互不重叠,但**必须等 T-010 规格书落地** —— 否则各自发明的 issue code 会与规格冲突,而 issue code 是 Agent 分支依赖的 API,冲突成本极高。
规格优先顺序在此**不可绕过**。

### 验收记录:D1 · T-011

**接受的实质内容:**
- `QualityContext.composite` 字段 —— 代理发现 `QualitySprite` 只读视图无法传入 `compositeFrame`,若不预合成,五个分析器会各自实现图层合成并对"画面是什么"产生分歧。这是代理在我给定的 AD-2 之外做出的正确架构判断,已接受并写入契约。
- `clamp01` 边界(NaN→0、±Infinity→1/0、-0→0、不做舍入)—— 为基线 diff 而设计,正确。
- `verdictFor` 阻断短路至 `fail` —— 若返回 `warn` 则 T-024 门禁无从执行,判断正确。
- `STATIC_QUALITY_WEIGHTS`(motion=0 + 重归一化)—— 单帧精灵既不因 motion 被扣分,也不假装拿到满分。
- `QualityCel` 剥离变更方法、`QualityReport.dimensions` 用 `Record` 而非 `Partial<Record>`。

**打回的原因(以及 PO 自身的错误):**
1. 代理缺陷:末尾编译守卫用 `declare const`,该形式对任意类型都合法,**结构上无法失败**。失效的守卫比没有守卫更糟,因为它读起来像在保护什么。
2. 代理缺陷(更严重):报告中写"我证明过守卫会触发",而该证明并未执行。**已报告但未执行的验证,比代码 bug 更贵** —— 它意味着该报告里其余验证也未经确认。返工时已要求:不得报告未实际运行的验证。
3. **PO 失误(自我记录):** 我判定"守卫失效"在结构上正确,但我用来证明的用例是**满足态**(把 id 接进了被检查的 `QUALITY_DIMENSIONS`),因此该测试**并未证明失效**。是返工代理指出这一点,并给出了判别性用例(只改进 union 与权重表、不碰 `QUALITY_DIMENSIONS`),PO 随后独立复核通过。教训:验收报告里的每条断言也要经得起同样的 scrutiny。

### 复审规则(新增,对后续所有代理生效)

- 代理声称"已验证"时,PO 必须**独立复核**,不得采信。
- 复核时必须使用**判别性用例**(触发失败的那一个),而不是通过的那一个。两者都能通过时,测试什么也证明不了。
- 若 PO 自己的验收结论有误,必须像记录代理缺陷一样记录在案。
