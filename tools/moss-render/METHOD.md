# 卡片图片背景 —— 标准作业流程（SOP）

> 目标：给 APP 里每类卡片一张**有语义、可辨识**的图形背景，
> 且不遮挡文字与按钮，同时适配 2 套皮肤（MOSS 冷青绿 / 550W 待机红）× 明暗 2 态 = 4 套主题。
>
> **核心原则：图形必须有意义。** 不是噪点、不是模糊材质、不是渐变色块。
> 大日期卡是天文刻度盘，任务卡是节点连线，台历卡是日期网格——一眼能认出这张卡是干什么的。

---

## 0. 铁律

| 规则 | 原因 |
|---|---|
| **一个页面一个页面做** | 每页的卡片结构完全不同，批量做必然出错；且改一处要立刻能验证 |
| **不先做后处理，先出图看效果** | 调色/压缩是后期的事，出图阶段先把"图形对不对"定下来 |
| **不做全量验证** | 全量跑一遍成本高且掩盖问题；每页做完交人眼看 |
| **每类卡片一张自己的图** | 一张通用图套 18 种卡片，图案必然错位 |
| **图形位置用实测数据定** | 靠猜 CSS 尺寸必然压到文字；必须量 DOM 矩形 |

---

## 1. 盘点：该页到底有几类卡片面

不是"看起来像卡片"，而是：**模板里真实在用 + CSS 里自带 background 或 border-radius**。

```bash
# 1) 模板真实使用的 class
awk '/<template>/,/<\/template>/' src/pages/<page>/<page>.vue | grep -oE 'class="[^"]*"'

# 2) 模板中 0 次出现的 CSS 类 = 结构重构后的死代码，直接排除
grep -c 'class="[^"]*\b<cls>\b' src/pages/<page>/<page>.vue
```

判定「独立卡片面」的标准：
- 有自己的 `background`（含 gradient）
- 或有自己的 `border-radius` + 独立底色
- 纯列表行、纯文字块不算

> 今天页的真实案例：`.hero` `.stat` `.quick` `.calpage` `.flipcard` `.caldate` `.menu` `.modal` = 8 类
> （早期只认了 5 类，漏了台历头日期块和两个弹层 → 弹层的图形会跑到页面右上角）

---

## 2. 实测：量出每个卡片的真实占位

用 puppeteer 在**真实构建产物**上量 DOM 矩形，输出归一化坐标。

```bash
node tools/moss-render/slot-today.mjs     # 输出 /tmp/ui-shots/today-slots.json
```

输出形如：

```json
{ "size": [358, 132], "ratio": "2.71",
  "leaves": [ { "cls": "hdate", "x": 0.047, "x1": 0.44, "y": 0.3, "y1": 0.55, "text": "10月25日" } ] }
```

**这一步的产出决定一切**：
- 文字/控件占了哪些矩形 → 图形只能放剩下的空档
- 卡片真实宽高比 → 决定主图怎么裁切、纹理图什么尺寸

> 典型结论：hero 卡 358×132，文字占 x0.047–0.44，进度环占 x0.75–0.92，
> → 天球仪只能塞进中间 x0.46–0.72 这条窄缝，且要缩小。

---

## 3. 出图：AI 生成主体图形（不是纹理）

**每类卡片 × 每套皮肤 = 1 张主图**。同语义不同皮肤各出一张，换色更可控。

| 卡片 | 图形语义 |
|---|---|
| `.hero` 大日期卡 | 天文仪器：同心刻度环 + 星座连线 |
| `.stat` 指标卡 | 柱状图 + 折线火花图 |
| `.quick` 快速记录 | 笔尖 + 拖尾 + 星芒 |
| `.calpage` 台历卡 | 日历网格，部分格子填充 |
| `.flipcard` 任务卡 | 任务流：节点 + 正交连线箭头 |
| `.caldate` 日期块 | 月相圆盘 + 细刻度 |
| `.menu` 底部弹层 | 抽屉三层错位板 |
| `.modal` 弹窗 | 碎裂警示三角 + 断环 |

**Prompt 模板**（关键是要约束留白与禁止项）：

```
A precise astronomical instrument schematic drawn as glowing emerald-teal line art
on a pure solid black background. The subject: a large circular armillary device —
three concentric engraved rings with fine tick marks along the edges, a thin sweeping
orbital arc crossing diagonally, and small glowing circular nodes connected by delicate
straight constellation lines forming a loose polygon. Rendered entirely as thin luminous
strokes with subtle bloom, engineering-drawing precision, no shading, no gradient fill,
no text, no letters, no numbers, no labels, no signature, no watermark marks,
no border, no frame. Subject occupies the right-center area, left half is empty pure black.
```

必写的禁止项：`no text, no letters, no numbers, no labels, no signature, no watermark marks, no border, no frame`

**550W 版**只换颜色词：`glowing crimson-red`（MOSS 用 `glowing emerald-teal`）。

**主图尺寸**统一 `1536x1024`，`quality: high`，输出到 `tools/moss-render/raw/`。

> ⚠️ 生图会在右下角打「AI生成」水印，后处理会裁掉。
> ⚠️ 一次生 8–16 张，额度消耗大；先出**一类**看效果，确认风格对了再铺开。

---

## 4. 后处理：裁水印 → 取景 → 提取线稿 → 着色 → 输出

脚本：`tools/moss-render/tex-build.py`，规格表：`tools/moss-render/card_specs.py`。

### 4.1 提取线稿（黑底图 → alpha 叠加层）

主图是**黑底 + 发光线稿**，直接用就会得到一张黑底图片。
用亮度当 alpha，把黑底去掉：

```python
alpha = 主图亮度            # 黑底=0，线稿=亮
rgb  = 主题线条色           # 全部替换成主题色
输出 = RGBA(rgb=线条色, a=alpha)
```

这样**同一张 RGBA 图能叠在任何底色上**，深色主题是发光线，浅色主题自动变成深色线（底浅时线必须深才看得清）。

### 4.2 锚点模型（anchor）—— 图形精确定位到空白矩形

不再"整幅铺 + 遮罩"，而是把图形**放进卡片内的一个精确矩形**：

```python
'anchor': (x0, y0, x1, y1)   # 归一化，来自第 2 步实测
```

放置算法分两条路，由**图形比例与锚区比例的接近程度**决定：

```
keep = min(图形比例, 锚区比例) / max(图形比例, 锚区比例)

keep ≥ 0.55  → 裁切：按锚区比例从主图裁一块，铺满锚区（细节全在）
keep < 0.55  → 容纳：图形完整保留，缩进锚区（语义完整但可能变小）
```

**为什么要有比例失配保护（MIN_KEEP = 0.55）**：
按锚区比例硬裁，在比例悬殊时会把图形裁成"几根断线"——设备拓扑图变成几段互不相连的线。
反过来直接 contain 又会让图形小到看不见（早期版本：控制台卡 contain 后只有 28px 高，
非零像素占比掉到 0.2%）。

两条路各丢一样，只能二选一。阈值 0.55 是权衡点：
低于它就认"语义完整优先"（宁可小），高于它就认"可见度优先"（宁可裁）。

> 实测对照（`ab-compare.py`，离线模拟两种策略）：
> news 卡 裁切 204×17 CSS / 容纳 47×17 CSS；
> console 卡 裁切 192×29 / 容纳 36×29。
> 裁切版可见度高 2~4 倍，但 news 会被剪成断竖线、caldate 的月相会被压成椭圆。
> 结论：容纳版在语义完整性上是对的，比例失配的卡确实小，
> 但**小不等于错**——只要不压字，语义能认出就是合格。

**裁切中心用 alpha 重心自适应**：手写 focus 容易偏（实测 20 张卡里 4 张偏了 0.3+），
所以裁切中心优先取图形自身的 alpha 重心，focus 只作 25% 的微调。

### 4.3 整幅模式（keep_band / full_bleed）

少数卡片需要图形铺满（如台历卡的网格线从任务卡缝隙透出）。
这时用 `safe` 标出**要被保护**的矩形，遮罩清零该区，其余保留。

### 4.4 主题着色参数

| 主题 | 线条色 | boost | cut |
|---|---|---|---|
| moss-dark | `#46e3a6` | 1.15 | 0.15 |
| moss-light | `#0a6b4a` | 1.60 | 0.11 |
| 550w-dark | `#ff4d3a` | 1.15 | 0.15 |
| 550w-light | `#9c2418` | 1.60 | 0.11 |

- 浅色主题 boost 要高（深线要更实才看得见）
- **两套皮肤的参数必须对齐**：早期 550w 用 boost 0.70 / cut 0.20，
  结果 550w 线稿峰值只有 178，moss 是 255 —— 同一张主版差这么多，
  根因是参数不是母版（实测两套母版亮度分布几乎一致：p50 0.203 vs 0.199）。
  改成对齐后，两套皮肤峰值都是 255。

### 4.5 主图皮肤归属：清单而不是看图的颜色

母版入库时做过一次无损压缩：把 RGB 归一化成「最大通道灰度」
（抠图只取 max 通道，对产物逐像素无损，体积 60MB → 22MB）。

但色相正是判断"这张是 MOSS 版还是 550W 版"的唯一依据
（靠 `G - (R+B)/2` 的正负来分）。灰度后这个值恒为 0，
所有母版都会被误判成同一套皮肤，550W 的图就会用上 MOSS 的主图。

所以：**颜色信息在压缩时丢一次，就用清单把它记下来一次** ——
`raw-skin.json` 记着每张母版属于哪套皮肤，`find_raw()` 优先读清单。
灰度化后重建，100 张纹理逐字节一致。

### 4.6 输出

WebP，RGBA，文件名 `{key}-{skin}-{mode}.webp`，路径 `src/static/moss/tex/`。
- 浅色主题是**反相**的深色线，深色主题是发光浅色线 → 4 套主题 = 4 个文件
- 母版（`raw/`）不入库（体积大），只入库产物 + 皮肤清单

---

## 5. 接入页面

### 5.1 组件

`src/components/moss/MossTex.vue`：

```vue
<MossTex name="hero" />
```

- 路径由 JS 算：`/static/moss/tex/{name}-{skin}-{mode}.webp`
- 浓度取 `var(--tex-{name}-op)` 令牌
- `pointer-events: none`
- 低端机（`state.lite`）时 `display: none` 降级

> **为什么用 `<image>` 组件而不是 CSS `background-image`**：
> uni-app App 端 / 小程序端对 CSS 引本地静态资源有限制，
> 而 `<image src="/static/...">` 是工程已验证路径（MossBadge、me.vue 的 hero.webp）。

### 5.2 CSS 三件套（每张带纹理的卡片都要）

```css
.hero {
  position: relative;   /* 纹理的 absolute 参照物 */
  overflow: hidden;     /* 裁掉溢出圆角的图形 */
}
.hero > *:not(.tex) {
  position: relative;
  z-index: 1;           /* 内容压在纹理之上 */
}
```

**弹层（`.menu` / `.modal`）特例**：
- 缺 `position: relative` → 纹理会跑到页面右上角
- 可滚动 → 纹理会跟着内容滚走

解决：拆成**两层结构**——外层 shell 负责定位+裁切+放纹理，内层负责滚动。

```html
<view class="menu-shell"><view class="menu">…滚动内容…</view></view>
```

```css
.menu-shell { position: relative; overflow: hidden; border-radius: 18px 18px 0 0; }
.menu { overflow-y: auto; }   /* 纹理在 shell 上，不动 */
```

### 5.3 浓度令牌

`src/styles/tokens.scss`，4 个主题块各一份：

```scss
--tex-hero-op: 0.42;
```

浓度**不能烤进图片**——一张图要能被不同尺寸、不同底色的卡片复用。

---

## 6. 验证（每页做完给人看，不做全量）

| 脚本 | 作用 |
|---|---|
| `shot.mjs <路由> [前缀] [--mock]` | 4 套主题整页截图（通用） |
| `elem-shot.mjs <页> <.卡> [x0,y0,x1,y1] zoom=N` | 元素级放大截图（单张卡看细节） |
| `slot.mjs <路由> key=选择器 [--mock]` | 实测卡片内元素占位（通用） |
| `textzone.mjs` | 实测卡片内**每段文字**的归一化位置 + 横向空白带 |
| `overlap-measure.py` | 量纹理在文字区的实际 alpha（判断图形是否真压字） |
| `check-tex.py` | 按图层模型解出各卡片类允许的最大 opacity |
| `consistency-check.py` | 令牌 ↔ 资产 ↔ 类型 三方对齐 + 引用完整性 |
| `measure-graphic.py` | 量每张纹理里图形的实际尺寸与占比 |
| `ab-compare.py` / `ab-preview.py` | 裁切策略 vs 容纳策略的离线对照 |

**`--mock` 是什么**：会话页 / 对话页的数据来自宿主 WebSocket，没有宿主时
只剩空态、量不到卡片。加上这个开关就装上 `ui-harness` 里的替身连接与假数据
（2 台设备 / 2 个工作区 / 6 条会话），DOM 才有 `.srow` 可量。

```bash
node tools/moss-render/slot.mjs sessions/sessions srow=.srow --mock
node tools/moss-render/shot.mjs sessions/sessions sessions --mock
```

**构建 → 截图**：

```bash
npm run build:h5
node tools/moss-render/serve.mjs          # 后台起 5188 端口
node tools/moss-render/shot.mjs today/today
```

> 服务用后台任务启动，用 `&` / `nohup` 会被 shell 退出带走。
> 构建脚本清空 `dist` 时可能触发安全删除拦截，看 `EXIT=` 确认，别只看 `tail` 的输出。

**截图前必须关浏览器缓存**：改了纹理重截还是旧图，是真实踩过的坑。
`shot.mjs` / `elem-shot.mjs` 里都有 `page.setCacheEnabled(false)`。

### 文字避让区要用实测，不用推断

`safe`（靠 CSS 结构推断）会骗人——实际渲染时文字可能比推断的宽。
`textzone.mjs` 在真实构建产物上量出**每段文字的实际矩形**，
写进规格表的 `text_zone` 字段，`check-tex.py` 优先用实测值。

实测纠正过 3 张真压字的卡：

| 卡片 | 旧 anchor | 新 anchor | 原因 |
|---|---|---|---|
| news | (0.20, 0.085, 0.80, 0.225) | (0.19, 0.775, 0.80, 0.875) | 原位置压在标题上 |
| sync | (0.63, 0.22, 0.87, 0.78) | (0.45, 0.20, 0.90, 0.475) | 原位置压到描述行 |
| dev | (0.485, 0.06, 0.775, 0.33) | (0.49, 0.075, 0.77, 0.20) | 原位置压到「当前」胶囊 |

---

## 7. 每页的产出清单

- [ ] 该页全部独立卡片面已盘点（模板在用 + 有底色）
- [ ] 每类卡片的 DOM 占位已实测
- [ ] 每类卡片的图形语义已定
- [ ] 主图已生成（MOSS + 550W 各 1 张/类）
- [ ] 后处理已生成 4 套主题 WebP
- [ ] `MossTex` 已接入模板
- [ ] CSS 三件套已补齐（relative / overflow / z-index）
- [ ] 浓度令牌已写入 `tokens.scss`
- [ ] 截图确认：文字与按钮未被遮挡，图形可辨识

---

## 8. 踩过的坑（别再踩）

| 坑 | 表现 | 正解 |
|---|---|---|
| 做成"淡纹理" | 看不清，和没做一样 | 图形必须有语义、可辨识 |
| 一图套多卡 | 图案错位、变形 | 每类卡片自己的图 |
| 靠猜 CSS 尺寸 | 图形压到文字 | 实测 DOM 矩形 |
| 弹层缺 `position: relative` | 图形跑到页面右上角 | 补 relative + 拆两层 |
| 弹层可滚动 | 纹理跟着滚走 | 外层 shell 放纹理 |
| 整幅铺 + 遮罩 | 图形被抹光 | 改成 anchor 精确矩形 |
| 浅色主题图形太淡 | 看不见 | 浅色用深色线 + 高 boost |
| 550W 图形糊成一片 | 太密 | 降 boost / 提 cut |
| 手抄令牌常量 | 校验的是假的世界 | 从 `tokens.scss` 解析真值 |
| 只看纹理图 | 不知道实际效果好不好 | 必须进 App 截图看 |
| 拿"恰好空着"的位置当空档 | 长标题一顶过来就压字（列表行尤其明显） | 要么给页面加内边距把位置让出来，要么别放 |
| 列表行按整幅铺 | 行高只有 60px，整幅怎么放都压字 | 只取一条竖带，且由页面预留 |

---

## 9. 图标（MossIcon）—— 2026-10-25 全量重建

和卡片纹理是两条流水线，但共用同一套抠线上色机制：

| | 卡片纹理 `tex-build.py` | 图标 `icons.py` |
|---|---|---|
| 主图 | `raw/` | `raw-icons/` |
| 画布 | 卡片实际宽高 | 固定正方形（96 / 128 / 384） |
| 定位 | anchor 精确矩形 | 由 CSS 决定 |
| 产物 | `src/static/moss/tex/` | `src/static/moss/icon/` |

### 一行多图标的拆法

提示词要求"单行、等距、大间距"，主图文件名用双下划线分隔图标名
（`check__cal__note__clock.png`），脚本按**整列接近全黑**切段。

坑：`scan` 这类"四个角括号"图标内部空腔比图标间距还大，会被多切一段。
兜底 `merge_to()`：段数超了就并回最小间隙。

### 三个不需要额外生图的变体

- **主题色**：`extract_graphic` 本来就按主题重上色，四套主题共用一张主图
- **状态色**（warn/danger/done）：保留 alpha，把 RGB 刷成 `tokens.scss` 的令牌色
- **实心**（已收藏的星）：形态学闭运算补缝 + 洪水填充内部

### 主图必须"闭合轮廓"

要填充实心变体的图标（star），提示词必须写"one single closed continuous curve
with absolutely no gaps"——第一版顶点有断口，闭运算补不上，填充静默失败
（退化成原图，不报错，很难发现）。

### WebP 会抹掉全透明像素的 RGB

给实心区补 alpha 时必须一起写 RGB，否则得到**黑心**图标。

### 清单位置

`<image>` 是 `pointer-events: none`，**点击事件不能挂在 MossIcon 上**，
要在外层包一个 `<view @tap>`。这个坑在 chat 的三个关闭钮上踩过一次。

### 旧的三种图标实现（全部废弃）

1. Unicode 文本符号 —— 字体随系统，🔔 直接变彩色 emoji
2. CSS 画的小色块 —— 各端圆角对齐有偏差
3. 预渲染 3D 图（badge-idle/badge-work/hero.webp）—— 和线稿体系脱节，已删

## 10. 全量复核（位置/大小/样式/清晰度/高宽）—— 2026-10-25

逐页复核已上线的纹理，按五个维度查。工具与结论：

### 工具链

| 工具 | 作用 |
|---|---|
| `slot.mjs <页> key=.选择器` | 实测每张卡的**真实** CSS 尺寸（390 手机 / 1024 / 1180 平板各跑一遍） |
| `vis-check.py` | 把 tex 合成到卡片底色，算锚区的覆盖率 / RMS 对比度 / 图形 CSS 尺寸——**"图案看不看得见"的量化** |
| `elem-shot.mjs <页> <.卡> [x0,y0,x1,y1] zoom=N` | 元素级放大截图（先 scrollIntoView 再量坐标，否则视口外元素截出黑图） |
| `tex-diag.mjs <页> <.卡>` | 查 `<image>` 实况：src 是否加载、盒模型、computed opacity |

### 三个系统性结论

**1) 规格表会过期，卡会长高。**
`card_specs.py` 的 h 是出图时量的，页面后来加了内容（quick 多了提示行、local 多了上传按钮行、
flipcard 多了标签行），实测全部偏高 10%~160%。place 模式的图形虽在锚区内 contain，
但**整张画布被 scaleToFill 各向异性拉到实测尺寸，锚区跟着变形**——
所以卡的实际尺寸必须和规格一致，否则圆变椭圆、正交连线横竖距不等。

**2) 尺寸会漂移的卡，用 `fit="contain"` 而不是 fill。**
MossTex 新增 `fit` prop：`contain` → `mode="aspectFit"`，图形等比放入、绝不拉伸。
比例一致的卡上 contain 与 fill 等价；比例漂移的卡（notes 三形态、ovcard 随内容变高）
只有 contain 能免疫。full_bleed 类（calpage 满幅网格）必须保持 fill，否则 letterbox。

**3) "图案不可见"有三种死法，量化才能发现：**
- 锚区太小：caldate 旧锚区 41×5px，月相缩成 5px 的点 → 改布局让位 + 锚区改 (0.05,0.64,0.95,0.98)
- 锚区太窄：quick 旧锚区 18×33px 挤在两枚不透明控件之间 → 换到提示行中部空白
- 被兄弟盖死：mine 的 `.ov-card` 带不透明背景 + `z-index:1`，把外层 shell 上的纹理
  **整个盖住**（uni-image 在 H5 是内部 div 的 background-image 显示，img opacity:0 是兜底不是病）。
  修法对齐 today `.menu-shell` 的正确模式：shell 出底色、内容层 transparent。

### 已知限制（有意为之，不是 bug）

- **清晰度**：所有纹理按 1.5× CSS 出图（SCALE=1.5，线稿够锐、控包体 912KB）。
  DPR2 屏上采样 1.33×、DPR3 上 2×——淡纹下不可察，但严格不达标。要 2× 包体翻倍。
- **calpage 满幅网格**：卡高随任务数变（92+N×207），按 demo（3 项，781）出图，
  任务增减时格线密度变化。safe 顶带已从 11.8% 收到 5.5%，只护装订条与日期头。
- **pagemid 四主题线高不一**（1560 宽下 34/39/45px）：抠图阈值不同导致，视觉都是通栏细线。
- **pagetail 在长内容页被末张卡片压住**：固定视口 + 内容滚动的固有取舍。
- **比例失配的卡图形偏小**（quick 19×29 CSS、console 36×29 CSS）：
  主图构图比例与锚区比例悬殊时的取舍，见 §4.2。
  quick 的主图是竖长羽毛笔、锚区是扁长条，这个组合本身就不匹配 ——
  要改得从主图构图入手（出一张横向笔尖），不是调 place() 能解决的。

---

## 11. 提交前的一致性检查（2026-10-25）

`consistency-check.py` —— 一条命令跑完四组检查：

| 组 | 检查什么 |
|---|---|
| 1. 纹理三方对齐 | 卡片令牌 ↔ 卡片资产 ↔ `TexKey`；页面层令牌 ↔ 页面层资产（单独列，因为走 `MossPageBg` 不走 `MossTex`） |
| 2. 图标三方对齐 | `IconName` ↔ 基础资产 ↔ 变体组（变体名 = `<name>-<tint>` / `<name>-fill`） |
| 3. 引用完整性 | 已删的资产（badge-idle / badge-work / hero.webp / amb / card / grid / mark）不许还有引用 |
| 4. 孤儿资产 | 磁盘上有、类型里没有的资产 —— 会被打进包体却没人用 |

**校验器本身也会骗人**，两个真实误报：

- `'grid'` 裸字符串匹配 → `genui.ts` 的 `CONTAINERS = new Set([... 'grid' ...])`
  是 CSS 布局容器名，与图标无关。必须按完整图标名匹配（`name="grid"` / `icon/grid-`）。
- 图标变体文件名 `<name>-<tint>-<skin>-<mode>` 被基础正则抢先匹配 → 变体被当成孤儿。
  正则要从右边剥皮和模式，剩下的段再按已知 tint 词表拆。

**最终状态**：纹理 21 卡片 + 3 页面层 / 图标 28 基础 + 5 变体组 / 21 张卡零压字。
