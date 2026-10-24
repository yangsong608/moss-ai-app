#!/usr/bin/env python3
"""
MOSS AI App · 卡片与环境纹理生成器。

## 为什么是程序化生成而不是 AI 出图

  1. **配色必须精确对齐设计令牌**（--acc / --s1 / --bg…）。AI 出图的色相不可控，
     一旦和 4 套主题（2 皮肤 × 明暗）都对不齐，界面就会"脏"。
  2. **文字安全区必须可度量**。程序化生成能保证安静区（文字所在区域）的
     亮度扰动可控，而 AI 出图无法保证（常见问题是纹理里出现高对比硬边，
     压在小标题下面就变成"看不清"）。
  3. **包体**。App 首包预算是 400KB（docs/05 §8），纹理必须能压到几十 KB。
     程序化生成 + WebP 有损压缩（含有损 alpha）可以精确控体积。

## 分层职责

图片只负责**图案与颜色**，最终强度由 CSS 的 opacity 令牌控制
（--tex-card-op / --tex-hero-op / --tex-amb-op）。

这个分工是刻意的：
  - PNG 里的 alpha 是"图案遮罩"（哪里有纹、哪里干净），CSS opacity 是"整体强度"。
  - 同一张图能被不同尺寸、不同底色的卡片复用，强度可以按场景调；
    如果把强度烤进图片，就只能一图一用，包体会翻倍。
  - 换成 <image> 组件 + CSS opacity 后，**整套主题只换一次 opacity 即可**，
    换肤时不必重新解码图片。

## 四种角色（按"文字占多满"来分，而不是按"卡片大不大"）

判定一个容器能不能放**可辨识图案**，看的是它的角上有没有控件，
不是它的尺寸。今天页任务卡（flipcard）四角分别是时间/状态、⋯菜单、
完成/删除按钮、页码序号——四角全被占满，所以它只能用 `flat`。

| 角色 | 用在哪 | 图案强度 | 卡片底色 |
|---|---|---|---|
| hero  | 今天页大日期卡、我的页控制台卡 | 弱（卡片矮，角落放不下大块） | s1→s2 渐变 |
| card  | 笔记卡 / 资讯卡 / 设备卡 / 日历卡 | 中（右下角有空间） | s1 不透明 |
| flat  | 今天页任务卡 / 任何四角被控件占满的卡 | 无图案，只留材质基底 | s1 不透明 |
| amb   | 页面级环境层 | 强（雷达弧环，页面背景上无正文压着） | 页面底 |

`flat` 不是"低配 card"：它保留了完整的大尺度材质基底（深浅斑块 + 纤维），
所以照样是**一张图片背景**，只是不叠加可辨识图案。这样文字压在上面
时不会与图案争夺注意力，而卡片仍有"这是张图不是块纯色"的质感。

## 主题（skin × mode）

  moss  : 冷青绿，菌丝/孢子 —— 生物终端
  550w  : 待机红，热裂纹/警示斜纹 —— 工业告警
  dark  : 深底，靠加色发光制造纵深
  light : 浅底，图案压到极低不透明度，只留质感不抢内容

**不加逐像素颗粒**：CSS 里已经有 .grain 噪点层（moss.scss），
再在图片里加一遍只会摧毁 WebP 的压缩率（实测同一张图 570KB → 28KB）。

用法：
  python3 tools/moss-render/gen-tex.py            # 生成全部
  python3 tools/moss-render/gen-tex.py --preview  # 额外产出对照预览图
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))

# ── 画布尺寸 ────────────────────────────────────────────────────────────
#
# 按**实际卡片的宽高比**定，而不是随手取整——因为 <image> 用 scaleToFill 铺满，
# 比例差太远会把斜纹拉成 bizarre 的形状。
#
#   card / flat  800×400 (2.0:1)  今天页任务卡 ≈330×168，笔记卡 ≈358×150
#   hero        1000×360 (2.8:1)  今天页大日期卡 ≈358×120
#   amb          640×640 (1:1)    页面层
#
# 卡片高宽比会随内容浮动（备注、标签行会撑高），所以纹理是柔和抽象图案，
# 拉伸一点看不出来——但**不能**放方向性强的几何图形。

SS = 2  # 图案绘制时的超采样倍数（抗锯齿）


# ── 角色剖面 ────────────────────────────────────────────────────────────
@dataclass
class Profile:
    name: str
    w: int
    h: int
    density: float
    motif: bool          # 是否画主图案（菌丝/裂纹）
    hatch: bool          # 是否叠加警示斜纹
    arcs: bool           # 是否画雷达弧环
    glow_r: float        # 辉光半径
    quiet_floor: float   # 安静区的残留系数（0 = 完全干净）
    cap_bytes: int       # 体积上限
    base_gain: float = 1.0   # 基底层的整体增益（flat 角色要压得更平）
    text_x: float = 0.0      # 文字栏右边界（0 = 无文字栏概念）
    text_floor: float = 0.0  # 文字栏内的残留系数


PROFILES = {
    # hero 的左侧是日期大标题 + 实时时钟，文字栏右边界取 0.58
    'hero': Profile('hero', 840, 300, 1.15, True, False, False, 0.52, 0.42, 20_000,
                    1.0, 0.58, 0.16),
    'card': Profile('card', 680, 340, 1.00, True, True, False, 0.46, 0.32, 14_000,
                    1.0, 0.60, 0.14),
    # flat 的文字区是整幅（四角控件 + 中间标题备注标签），
    # 所以基底必须压得更平：base_gain 0.62 让它只留一点材质暗示。
    'flat': Profile('flat', 680, 340, 0.85, False, False, False, 0.00, 1.00, 9_000, 0.62),
    'amb': Profile('amb', 560, 560, 0.90, False, False, True, 0.82, 1.00, 11_000),
}


# ── 主题定义 ────────────────────────────────────────────────────────────
@dataclass
class Theme:
    key: str
    skin: str
    mode: str
    base_hi: tuple[int, int, int]     # 基底亮斑（比 s1 亮一点）
    base_lo: tuple[int, int, int]     # 基底暗斑
    motif: tuple[int, int, int]      # 图案主色（线条 / 裂纹）
    glow: tuple[int, int, int]       # 辉光色（强调色）
    base_alpha: float
    motif_alpha: float
    glow_alpha: float
    sheen: float
    seed: int
    motif_kind: str = 'filament'


THEMES: list[Theme] = [
    # ── MOSS 冷青绿（生物终端）─────────────────────────────────────────
    Theme(
        key='moss-dark', skin='moss', mode='dark',
        base_hi=(0x1c, 0x2e, 0x26), base_lo=(0x03, 0x06, 0x05),
        motif=(0x7e, 0xff, 0xcd), glow=(0x46, 0xe3, 0xa6),
        base_alpha=0.34, motif_alpha=0.60, glow_alpha=0.20, sheen=0.045,
        seed=20261024, motif_kind='filament',
    ),
    Theme(
        key='moss-light', skin='moss', mode='light',
        base_hi=(0xd7, 0xe9, 0xe0), base_lo=(0xfd, 0xff, 0xfe),
        motif=(0x0e, 0x8a, 0x5f), glow=(0x0e, 0x8a, 0x5f),
        base_alpha=0.34, motif_alpha=0.40, glow_alpha=0.18, sheen=0.055,
        seed=20261025, motif_kind='filament',
    ),
    # ── 550W 待机红（工业告警）─────────────────────────────────────────
    Theme(
        key='550w-dark', skin='550w', mode='dark',
        base_hi=(0x30, 0x1c, 0x15), base_lo=(0x04, 0x02, 0x02),
        motif=(0xff, 0x98, 0x68), glow=(0xff, 0x3b, 0x2f),
        base_alpha=0.34, motif_alpha=0.58, glow_alpha=0.20, sheen=0.040,
        seed=20261026, motif_kind='crack',
    ),
    Theme(
        key='550w-light', skin='550w', mode='light',
        base_hi=(0xeb, 0xd6, 0xc6), base_lo=(0xfe, 0xfc, 0xf9),
        motif=(0xb4, 0x31, 0x1f), glow=(0xb4, 0x31, 0x1f),
        base_alpha=0.34, motif_alpha=0.38, glow_alpha=0.17, sheen=0.055,
        seed=20261027, motif_kind='crack',
    ),
]


# ── 基础工具 ────────────────────────────────────────────────────────────


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def quiet_mask(w: int, h: int, floor: float) -> np.ndarray:
    """
    安静区遮罩：左上（文字区）→ floor，右下（图案区）→ 1.0。

    卡片上的标题、摘要、按钮都在左上或整幅展开，所以图案必须往右下方退。
    这个遮罩让纹理有明确的"呼吸区"，而不是均匀铺满——
    这是"不遮挡文字"的结构性保证，而不是靠调低整体不透明度
    （那会让纹理失去存在感）。

    过渡带的位置是调出来的，不是拍脑袋定的：最初用 x-0.28 / y-0.16 起跳，
    结果在 x=0.62（文字区右边界）处遮罩已经升到 0.72，
    图案实质上铺了半张卡，hero 主题的文字区对比度直接掉 37%。
    现在从 0.40/0.30 起跳、带宽 0.46/0.55，图案被压回真正的右下角。

    floor 是文字区允许的残留量：
      · card 0.32：文字区仍保留三成图案，换来"整张卡都是一张图"的观感
      · hero 0.42：主视觉卡更高，文字区更宽容
      · flat 1.00：整幅统一（它本来就没有图案层）
      · amb 1.00：整页层，不留任何安静区概念
    """
    if floor >= 1.0:
        return np.ones((h, w), dtype=np.float64)

    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    wx = smoothstep((x - 0.40) / 0.46)
    wy = smoothstep((y - 0.30) / 0.55)
    m = np.clip(wx * wy * 1.14 - 0.02, 0.0, 1.0) ** 0.80
    return floor + (1.0 - floor) * m


def text_safe_mask(w: int, h: int, floor: float, x0: float) -> np.ndarray:
    """
    文字区专用的遮罩：在 quiet_mask 之上，再把**左侧文字栏**彻底压干净。

    为什么需要额外一层：quiet_mask 只保证"图案往右下退"，
    但白��的斜向高光带（sheen）和强调色辉光是**全幅叠加**的，
    即使乘了 quiet_mask，在文字栏里仍会留下一层亮雾。

    实测：hero 的左栏在 quiet_floor=0.42 时 alpha 峰值仍有 0.59、
    RGB 峰值 254（纯白高光），正文对比度从 15.6 掉到 11.4（劣化 27%）。
    单独把 floor 降到 0.20 会让整个右下角也变干净，图案就消失了。

    所以这里加一道**竖直分界**：x < x0 的文字栏另乘一个更低的系数。
    文字栏保留一点点材质（不是死白），图案区照旧。
    """
    x = np.linspace(0.0, 1.0, w)[None, :]
    # 文字栏：从 0 到 x0，系数由 floor_text 过渡到 1
    t = smoothstep((x - x0 * 0.55) / (x0 * 0.45))
    col = floor + (1.0 - floor) * t
    return col


def radial(w: int, h: int, cx: float, cy: float, r: float, power: float = 1.6) -> np.ndarray:
    """归一化坐标里的径向衰减场。"""
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    d = np.sqrt(((x - cx) / r) ** 2 + ((y - cy) / r) ** 2)
    return np.clip(1.0 - d, 0.0, 1.0) ** power


def radial_glow(w: int, h: int, cx: float, cy: float, r: float, strength: float) -> np.ndarray:
    return radial(w, h, cx, cy, r, 2.0) * strength


def solid_layer(w: int, h: int, rgb: tuple[int, int, int], alpha: np.ndarray) -> Image.Image:
    a = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    img = Image.new('RGBA', (w, h), rgb + (0,))
    img.putalpha(Image.fromarray(a, mode='L'))
    return img


def tint_alpha(src: Image.Image, alpha: np.ndarray, rgb: tuple[int, int, int]) -> Image.Image:
    """把一个图层的 alpha 场替换成给定的，并统一颜色（避免再存一份 RGB）。"""
    out = Image.new('RGBA', src.size, rgb + (0,))
    out.putalpha(Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8), mode='L'))
    return out


def layer_alpha(img: Image.Image) -> np.ndarray:
    return np.asarray(img.split()[3]).astype(np.float64) / 255.0


# ── 材质基底 ────────────────────────────────────────────────────────────


def draw_base(w: int, h: int, theme: Theme) -> Image.Image:
    """
    大尺度材质基底：深浅斑块。

    这一层是"卡片有图片感"的主要来源，也是 flat 角色**唯一**的图案。
    它刻意做成低频（斑块直径占画布 22%–52%）：低频意味着任何位置都只有
    平缓的明暗起伏，不会形成与文字竞争的边缘。

    **斑块数量必须少**：数量一多，alpha 场就变成中高频，
    WebP 有损 alpha 压不动（实测 7 块 + 纤维层 → 单张 17KB；
    去掉纤维层、减到 5 块 → 9KB）。

    **不加逐像素颗粒、也不加斜向纤维**：CSS 里已经有 .grain 噪点层，
    图片里再来一遍只会摧毁压缩率（同一张图 570KB → 28KB）。
    """
    rng = random.Random(theme.seed + 7)
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))

    count = 5 if theme.mode == 'dark' else 4
    for i in range(count):
        cx = rng.uniform(-0.10, 1.10)
        cy = rng.uniform(-0.10, 1.10)
        r = rng.uniform(0.34, 0.62)
        a = radial(w, h, cx, cy, r, 1.5) * theme.base_alpha * rng.uniform(0.7, 1.0)
        col = theme.base_hi if i % 2 == 0 else theme.base_lo
        canvas = Image.alpha_composite(canvas, solid_layer(w, h, col, a))

    return canvas


# ── 图案：MOSS 菌丝 ─────────────────────────────────────────────────────


def draw_filament(w: int, h: int, theme: Theme) -> Image.Image:
    """
    递归分枝的菌丝网络。

    为什么是菌丝而不是几何网格：MOSS 这个名字的调性是"长出来的东西"，
    直角网格会和终端风的直角边框打架；分枝曲线在暗底上像微弱的生物荧光，
    在浅底上像纸里的纤维。
    """
    rng = random.Random(theme.seed)
    cw, ch = w * SS, h * SS
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgb = theme.motif
    max_alpha = int(round(theme.motif_alpha * 255))

    def branch(x: float, y: float, ang: float, length: float, width: int, depth: int) -> None:
        steps = max(6, int(length / (7 * SS)))
        step = length / steps
        pts = [(x, y)]
        for _ in range(steps):
            ang += rng.uniform(-0.30, 0.30)
            x += math.cos(ang) * step
            y += math.sin(ang) * step
            pts.append((x, y))
        # 越细的枝越透明：避免所有分支一样重，画面会显得平
        a = max(24, int(max_alpha * (0.40 + 0.60 * (width / 3.0))))
        draw.line(pts, fill=rgb + (a,), width=width, joint='curve')
        if depth <= 0:
            return
        for _ in range(rng.randint(1, 2)):
            i = rng.randint(len(pts) // 3, len(pts) - 1)
            branch(
                pts[i][0], pts[i][1],
                ang + rng.choice((-1, 1)) * rng.uniform(0.25, 0.75),
                length * rng.uniform(0.45, 0.72),
                max(1, width - 1), depth - 1,
            )

    # 主枝起点偏向右下（图案区），安静区遮罩会再压一次
    for _ in range(6):
        x = rng.uniform(0.42, 1.00) * cw
        y = rng.uniform(0.40, 1.04) * ch
        branch(x, y, rng.uniform(0, math.tau), rng.uniform(0.16, 0.32) * cw, 3, 3)

    # 孢子：菌丝的果实，也是暗底上的唯一点状高光。
    # 数量刻意压到 70 且半径放大——又小又密的点在 WebP 里最贵。
    for _ in range(70):
        x = rng.uniform(0.36, 1.02) * cw
        y = rng.uniform(0.28, 1.02) * ch
        r = rng.uniform(1.6, 4.0) * SS
        a = int(max_alpha * rng.uniform(0.45, 1.0))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (a,))

    return layer.resize((w, h), Image.LANCZOS)


# ── 图案：550W 热裂纹 ───────────────────────────────────────────────────


def draw_crack(w: int, h: int, theme: Theme) -> Image.Image:
    """
    热裂纹 + 炭化余烬。

    550W 的语义是"设备待机红"——机器在过热边缘。所以纹理是受热的金属：
    从右下角烧出裂纹网络，裂纹里透出橙红，边缘是炭黑。
    """
    rng = random.Random(theme.seed)
    cw, ch = w * SS, h * SS
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgb = theme.motif
    max_alpha = int(round(theme.motif_alpha * 255))

    def crack(x: float, y: float, ang: float, length: float, width: int, depth: int) -> None:
        steps = max(8, int(length / (6 * SS)))
        step = length / steps
        pts = [(x, y)]
        for _ in range(steps):
            ang += rng.uniform(-0.22, 0.22)
            x += math.cos(ang) * step
            y += math.sin(ang) * step
            pts.append((x, y))
        a = max(28, int(max_alpha * (0.36 + 0.64 * (width / 3.0))))
        draw.line(pts, fill=rgb + (a,), width=width)
        if depth <= 0:
            return
        for _ in range(rng.randint(1, 2)):
            i = rng.randint(len(pts) // 3, len(pts) - 1)
            crack(
                pts[i][0], pts[i][1],
                ang + rng.choice((-1, 1)) * rng.uniform(0.3, 0.9),
                length * rng.uniform(0.40, 0.70),
                max(1, width - 1), depth - 1,
            )

    for _ in range(7):
        x = rng.uniform(0.52, 1.04) * cw
        y = rng.uniform(0.44, 1.06) * ch
        crack(x, y, rng.uniform(0, math.tau), rng.uniform(0.11, 0.25) * cw, 3, 3)

    # 余烬：炭化后还没灭的点
    for _ in range(60):
        x = rng.uniform(0.46, 1.02) * cw
        y = rng.uniform(0.34, 1.02) * ch
        r = rng.uniform(1.4, 3.6) * SS
        a = int(max_alpha * rng.uniform(0.35, 1.0))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (a,))

    return layer.resize((w, h), Image.LANCZOS)


def draw_hatch(w: int, h: int, theme: Theme) -> Image.Image:
    """
    工业警示斜纹，只落在右下角一小块。

    斜纹是强符号，一整片铺上去会和正文打架，所以限制在角落，
    并且叠在安静区遮罩之后 —— 文字区域永远看不到它。
    """
    cw, ch = w * SS, h * SS
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgb = theme.motif
    alpha = int(round(theme.motif_alpha * 255 * 0.55))

    x0 = int(cw * 0.62)
    y0 = int(ch * 0.56)
    bw = int(cw * 0.38)
    bh = int(ch * 0.44)
    gap = int(13 * SS)
    wdt = int(4 * SS)
    for i in range(-bh, bw + bh, gap):
        draw.line([(x0 + i, y0), (x0 + i + bh, y0 + bh)], fill=rgb + (alpha,), width=wdt)

    # 边界羽化：把带的边缘擦成渐隐，避免出现一条直线切口。
    # 半径取 1.6：既足够把边缘擦干净，又不至于把斜纹糊成一片色块
    # （糊了"警示条"的语义就没了）。这也是省体积的关键一步——
    # 锐利的 45° 斜线是 WebP 最难压的图案。
    layer = layer.filter(ImageFilter.GaussianBlur(radius=1.6 * SS))
    layer = layer.resize((w, h), Image.LANCZOS)
    a = layer_alpha(layer)
    yy = np.linspace(0.0, 1.0, h)[:, None]
    xx = np.linspace(0.0, 1.0, w)[None, :]
    edge = smoothstep((xx - 0.56) / 0.16) * smoothstep((yy - 0.50) / 0.18)
    return tint_alpha(layer, a * edge, theme.motif)


def draw_arcs(w: int, h: int, theme: Theme) -> Image.Image:
    """
    页面级环境层的主角：柔光晕 + 极淡的同心波纹。

    ## 这里踩过的坑

    最初画的是**锐利的雷达弧环**（同心圆描边）。结果单张 27.9KB——
    比整个 amb 合成（15.3KB）还大。原因是同心圆的边缘是高频曲线，
    WebP 的预测编码完全失效：像素块之间没有可复用的规律。

    解决办法不是"降低质量"（质量降到 26 仍有 12.6KB），而是**改变形状**：
    把圆环从"线"变成"面"——用极低 alpha 的同心圆**填充**代替描边，
    再重羽化。一圈圈填出来的低透明度色带编码起来是平滑渐变，
    体积立刻回落到 6KB 级别，而且视觉上更像"扫描波纹"而不是"几何线条"。

    页面层本来就该是低对比的背景素材，没人盯着看细节，
    糊一点反而更干净。
    """
    rng = random.Random(theme.seed + 31)
    cw, ch = w * SS, h * SS
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgb = theme.motif
    max_alpha = int(round(theme.motif_alpha * 255 * 0.10))

    # 圆心在右下角，色带向左上扩散
    cx, cy = cw * 1.04, ch * 1.02
    r = cw * 0.16
    i = 0
    band = cw * 0.045
    while r < cw * 1.15:
        a = max(6, int(max_alpha * (1.0 - i / 16.0) * rng.uniform(0.85, 1.0)))
        # 填充式色带：外圈实心圆覆盖内圈，形成一条环带
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgb + (a,))
        r += band
        band *= 1.16
        i += 1

    # 重羽化：把色带糊成柔和的光波
    layer = layer.filter(ImageFilter.GaussianBlur(radius=2.4 * SS))
    return layer.resize((w, h), Image.LANCZOS)


# ── 合成 ────────────────────────────────────────────────────────────────


def build_texture(theme: Theme, prof: Profile) -> Image.Image:
    """
    合成一张 RGBA 纹理。

    图层顺序（从下到上）：
      1. 材质基底（深浅斑块 + 纤维）—— 全幅，"这是张图"的来源
      2. 强调色辉光（大尺度，负责纵深）
      3. 主图案（菌丝 / 裂纹 / 雷达弧环）
      4. 警示斜纹（仅 550W 的 card）
      5. 斜向高光带（玻璃质感的那一道反射）

    **辉光与高光同样乘安静区遮罩**。最初只有图案层乘了遮罩，
    于是辉光溢进文字区，--t1 的对比度从 16.6 掉到 3.7——
    这是"看起来有纹理但字看不清"的典型成因。
    """
    w, h = prof.w, prof.h
    density = prof.density
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    qm = quiet_mask(w, h, prof.quiet_floor)

    # 文字栏遮罩：把左侧文字列额外压干净（辉光与高光带这类全幅层要乘它）
    tsm = (
        text_safe_mask(w, h, prof.text_floor, prof.text_x)
        if prof.text_x > 0
        else np.ones((h, w), dtype=np.float64)
    )

    # 1. 材质基底
    #
    # 基底在文字区保留七成、图案区满值：这样整张卡都有材质，
    # 而图案（菌丝/裂纹）依然只待在右下角。两件事分开控制。
    #
    # 这里**直接合成**而不是走 tint_alpha：基底本身含亮斑/暗斑两种颜色，
    # tint 会把暗斑也染成亮色，材质就平了。只缩放它的 alpha 场。
    base = draw_base(w, h, theme)
    base_mask = Image.fromarray(
        (
            np.clip(
                layer_alpha(base) * prof.base_gain * (0.68 + 0.32 * qm) * tsm, 0, 1
            )
            * 255
        ).astype(np.uint8),
        mode='L',
    )
    canvas = Image.alpha_composite(canvas, Image.merge('RGBA', (*base.split()[:3], base_mask)))

    # 2. 辉光
    #
    # 辉光**也要**乘安静区遮罩。漏了这一步是最初的 bug：
    # 图案层压住了、辉光层没压住，而辉光的亮度远高于图案，
    # 于是文字区被一团绿色雾笼罩，--t1 的对比度从 16.6 掉到 3.7。
    #
    # 辉光强度也不随 profile.density 线性放大：density 是给"图案密度"用的，
    # 辉光是"底光"，跟着放大就成了一片发光的雾。
    if prof.glow_r > 0:
        glow_a = radial_glow(
            w, h, 0.80, 0.76, prof.glow_r, theme.glow_alpha * (0.55 + 0.45 * density)
        )
        canvas = Image.alpha_composite(
            canvas, solid_layer(w, h, theme.glow, glow_a * qm * tsm)
        )

    # 3. 主图案
    if prof.motif:
        motif = (
            draw_filament(w, h, theme)
            if theme.motif_kind == 'filament'
            else draw_crack(w, h, theme)
        )
    elif prof.arcs:
        motif = draw_arcs(w, h, theme)
    else:
        motif = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    if motif.size != (w, h):
        motif = motif.resize((w, h), Image.LANCZOS)
    canvas = Image.alpha_composite(
        canvas, tint_alpha(motif, layer_alpha(motif) * qm * density, theme.motif)
    )

    # 4. 警示斜纹
    if prof.hatch:
        hatch = draw_hatch(w, h, theme)
        canvas = Image.alpha_composite(
            canvas, tint_alpha(hatch, layer_alpha(hatch) * qm * density, theme.motif)
        )

    # 5. 斜向高光带：玻璃卡右上角那道反射。
    # 同样乘安静区遮罩——它是白色，在浅色主题上会把背景提亮，
    # 直接吃掉深色文字的对比度。
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    band = np.sin((x * 1.5 + y * 2.2) * math.pi) ** 2
    band = band * np.clip(1.0 - (x + y) * 0.6, 0.0, 1.0)
    canvas = Image.alpha_composite(
        canvas,
        solid_layer(w, h, (255, 255, 255), band * theme.sheen * density * qm * tsm),
    )

    return canvas


def save_webp(img: Image.Image, path: str, quality: int, max_bytes: int) -> tuple[int, int]:
    """
    保存 WebP 并在超出体积上限时自动降质重试。

    `alpha_quality` 必须调低：默认 alpha 通道是无损压缩，
    而我们的 alpha 场是平滑渐变，无损压不动（有损 alpha 只要 1/4 的码率，
    肉眼几乎看不出差别）。

    包体是硬约束：纹理必须塞得进首包预算，所以这里不是"导出一次就完"，
    而是"导出并验证体积"。降质优先于降分辨率——纹理本来就是柔和图案，
    降质看不出来，降分辨率会看出糊。
    """
    q = quality
    size = 0
    for _ in range(8):
        img.save(path, 'WEBP', quality=q, method=5, alpha_quality=40)
        size = os.path.getsize(path)
        if size <= max_bytes:
            break
        q -= 6
        if q < 24:
            break
    return size, q


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', action='store_true', help='额外产出对照预览图')
    args = ap.parse_args()

    # ── 护栏：本脚本已被 tex-build.py 取代 ──────────────────────────
    #
    # 现在真正在用的是 tex-build.py（AI 出图 → 抠图 → 上色 → anchor 定位），
    # 产物是 src/static/moss/tex/<key>-<skin>-<mode>.webp，每类卡片一张。
    #
    # 本脚本是更早的"程序化生成"方案，产物只有 hero / card / flat / amb 四种角色，
    # 而且**写到同一个目录**（OUT）—— 跑一次就会：
    #   1. 用程序化的 hero 覆盖掉 tex-build.py 生成的 hero（AI 图形没了）
    #   2. 复活 card / flat / amb 三个已废弃的纹理名
    #
    # 所以默认直接退出，要跑必须显式加 --legacy。
    if '--legacy' not in sys.argv:
        print('本脚本已被 tex-build.py 取代（AI 出图 → 抠图 → 上色 → anchor 定位）。')
        print('它的产物 hero/card/flat/amb 会覆盖 tex-build.py 的同名文件，故默认不执行。')
        print('如确实要跑旧方案：python3 gen-tex.py --legacy [--preview]')
        return

    os.makedirs(OUT, exist_ok=True)
    print(f'输出目录 {OUT}  ⚠ 旧方案，会覆盖同名文件')

    # (标签, 纹理, 底色) —— 预览用
    previews: list[tuple[str, Image.Image, tuple[int, int, int]]] = []

    for theme in THEMES:
        for name, prof in PROFILES.items():
            tex = build_texture(theme, prof)
            path = os.path.join(OUT, f'{name}-{theme.key}.webp')
            size, q = save_webp(tex, path, quality=74, max_bytes=prof.cap_bytes)
            flag = '  ' if size <= prof.cap_bytes else '⚠ '
            print(f'{flag}{name}-{theme.key}.webp  {prof.w}x{prof.h}  q={q}  {size / 1024:.1f}KB')
            base = (11, 18, 16) if theme.mode == 'dark' else (243, 247, 244)
            previews.append((f'{name} · {theme.key}', tex, base))

    total = sum(
        os.path.getsize(os.path.join(OUT, f))
        for f in os.listdir(OUT) if f.endswith('.webp')
    )
    print(f'合计 {total / 1024:.1f}KB')

    if args.preview:
        cols = 3
        rows = (len(previews) + cols - 1) // cols
        cw, ch = 320, 210
        sheet = Image.new('RGB', (cols * cw, rows * ch), (8, 12, 10))
        for i, (label, img, base) in enumerate(previews):
            bg = Image.new('RGBA', img.size, base + (255,))
            comp = Image.alpha_composite(bg, img).convert('RGB')
            comp = comp.resize((cw - 8, ch - 8), Image.LANCZOS)
            sheet.paste(comp, ((i % cols) * cw + 4, (i // cols) * ch + 4))
        out = os.path.join(HERE, 'tex-preview.png')
        sheet.save(out)
        print(f'预览 {out}')


if __name__ == '__main__':
    main()
