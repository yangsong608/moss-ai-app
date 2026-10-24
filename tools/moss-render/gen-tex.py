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

## 分层职责（关键）

图片负责**质感与结构**，强度由 CSS 的不透明度令牌控制（--tex-*-op）。
两者分开的原因：同一张图要能被不同尺寸、不同底色的卡片复用，
如果把强度烤进图片，就只能一图一用，包体会翻倍。

## 三种角色

| 角色 | 用在哪 | 特征 |
|---|---|---|
| card  | 笔记卡 / 资讯卡 / 看板列 / 设置组 | 图案集中在右下角，安静区留给标题摘要 |
| hero  | 今天页大日期卡 / 我的页控制台卡 / 设备页状态台 | 密度更高，可占据右半幅 |
| amb   | 页面级环境层 | 只有雷达弧环与大范围柔光，无细密图案 |

amb 之所以不给密集图案：它铺在**整页**下面，而页面上的散落文字
（章节标题、页脚说明）位置不可控。整页层必须保证任何位置都读得清，
所以只留大尺度低对比的弧环与柔光。

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
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))

# ── 画布尺寸 ────────────────────────────────────────────────────────────
# 卡片最宽约 350pt，@2x 需要 700px。取 720 是够用又不浪费的平衡点。
# 纹理本身是柔和抽象图案，锐度损失看不出来，体积却省一半。
W_CARD, H_CARD = 720, 448
W_HERO, H_HERO = 840, 420
W_AMB, H_AMB = 640, 640

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


PROFILES = {
    'card': Profile('card', W_CARD, H_CARD, 1.0, True, False, False, 0.44, 0.05, 20_000),
    'hero': Profile('hero', W_HERO, H_HERO, 1.5, True, True, False, 0.46, 0.05, 26_000),
    'amb': Profile('amb', W_AMB, H_AMB, 0.9, False, False, True, 0.72, 0.0, 14_000),
}


# ── 主题定义 ────────────────────────────────────────────────────────────
@dataclass
class Theme:
    key: str
    skin: str
    mode: str
    motif: tuple[int, int, int]      # 图案主色（线条 / 裂纹）
    glow: tuple[int, int, int]       # 辉光色（强调色）
    vignette: tuple[int, int, int]   # 暗角色
    motif_alpha: float
    glow_alpha: float
    sheen: float
    seed: int
    motif_kind: str = 'filament'


THEMES: list[Theme] = [
    # ── MOSS 冷青绿（生物终端）─────────────────────────────────────────
    Theme(
        key='moss-dark', skin='moss', mode='dark',
        motif=(126, 255, 205), glow=(70, 227, 166), vignette=(0, 5, 4),
        motif_alpha=0.30, glow_alpha=0.26, sheen=0.026, seed=20261024,
        motif_kind='filament',
    ),
    Theme(
        key='moss-light', skin='moss', mode='light',
        motif=(14, 138, 95), glow=(14, 138, 95), vignette=(96, 124, 112),
        motif_alpha=0.20, glow_alpha=0.11, sheen=0.030, seed=20261025,
        motif_kind='filament',
    ),
    # ── 550W 待机红（工业告警）─────────────────────────────────────────
    Theme(
        key='550w-dark', skin='550w', mode='dark',
        motif=(255, 152, 104), glow=(255, 59, 47), vignette=(8, 3, 2),
        motif_alpha=0.28, glow_alpha=0.26, sheen=0.022, seed=20261026,
        motif_kind='crack',
    ),
    Theme(
        key='550w-light', skin='550w', mode='light',
        motif=(180, 49, 31), glow=(180, 49, 31), vignette=(158, 112, 94),
        motif_alpha=0.19, glow_alpha=0.10, sheen=0.030, seed=20261027,
        motif_kind='crack',
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

    floor 是文字区允许的残留量。card/hero 取 0.05：
    完全为 0 会让左上出现一块"什么都没发生"的死区，看起来像图片没加载。
    amb 取 0：整页层不留任何图案残留。
    """
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    wx = smoothstep((x - 0.28) / 0.52)
    wy = smoothstep((y - 0.16) / 0.58)
    m = np.clip(wx * wy * 1.14 - 0.02, 0.0, 1.0) ** 0.80
    return floor + (1.0 - floor) * m


def radial_glow(w: int, h: int, cx: float, cy: float, r: float, strength: float) -> np.ndarray:
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    d = np.sqrt(((x - cx) / r) ** 2 + ((y - cy) / r) ** 2)
    return np.clip(1.0 - d, 0.0, 1.0) ** 2.0 * strength


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
        a = max(12, int(max_alpha * (0.42 + 0.58 * (width / 3.0))))
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

    # 若干条主枝，起点散布在画布中下区域（安静区遮罩会再压一次）
    for _ in range(6):
        x = rng.uniform(0.30, 0.98) * cw
        y = rng.uniform(0.32, 1.02) * ch
        branch(x, y, rng.uniform(0, math.tau), rng.uniform(0.18, 0.36) * cw, 3, 3)

    # 孢子：菌丝的果实，也是暗底上的唯一点状高光。
    # 数量刻意压到 70 且半径放大——又小又密的点在 WebP 里最贵。
    for _ in range(70):
        x = rng.uniform(0.24, 1.0) * cw
        y = rng.uniform(0.18, 1.0) * ch
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
        a = max(14, int(max_alpha * (0.38 + 0.62 * (width / 3.0))))
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
        x = rng.uniform(0.44, 1.02) * cw
        y = rng.uniform(0.36, 1.05) * ch
        crack(x, y, rng.uniform(0, math.tau), rng.uniform(0.12, 0.28) * cw, 3, 3)

    # 余烬：炭化后还没灭的点
    for _ in range(60):
        x = rng.uniform(0.36, 1.0) * cw
        y = rng.uniform(0.26, 1.0) * ch
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
    alpha = int(round(theme.motif_alpha * 255 * 0.62))

    x0 = int(cw * 0.60)
    y0 = int(ch * 0.54)
    bw = int(cw * 0.40)
    bh = int(ch * 0.46)
    gap = int(13 * SS)
    wdt = int(4 * SS)
    for i in range(-bh, bw + bh, gap):
        draw.line([(x0 + i, y0), (x0 + i + bh, y0 + bh)], fill=rgb + (alpha,), width=wdt)

    # 边界羽化：把带的边缘擦成渐隐，避免出现一条直线切口。
    # 半径必须小——羽化一大，斜纹就糊成一片色块，"警示条"的语义就没了。
    layer = layer.filter(ImageFilter.GaussianBlur(radius=0.9 * SS))
    layer = layer.resize((w, h), Image.LANCZOS)
    a = np.asarray(layer.split()[3]).astype(np.float64) / 255.0
    yy = np.linspace(0.0, 1.0, h)[:, None]
    xx = np.linspace(0.0, 1.0, w)[None, :]
    edge = smoothstep((xx - 0.54) / 0.16) * smoothstep((yy - 0.48) / 0.18)
    return tint_alpha(layer, a * edge, theme.motif)


def draw_arcs(w: int, h: int, theme: Theme) -> Image.Image:
    """
    雷达弧环 —— 页面级环境层的主角。

    取自本产品已有的视觉语言（docs/07 §3：MOSS 状态台的雷达扫描线）。
    弧环的好处：线条平滑、对比度低、尺度大，
    铺满整页时不会在任何位置形成高频干扰，文字始终读得清。
    """
    rng = random.Random(theme.seed + 31)
    cw, ch = w * SS, h * SS
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgb = theme.motif
    max_alpha = int(round(theme.motif_alpha * 255 * 0.42))

    # 圆心在右下角，弧线向左上扩散
    cx, cy = cw * 1.06, ch * 1.04
    r = cw * 0.20
    i = 0
    while r < cw * 1.5:
        a = max(8, int(max_alpha * (1.0 - i / 26.0) * rng.uniform(0.75, 1.0)))
        width = max(1, int((2.6 - i * 0.07) * SS))
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=rgb + (a,), width=width,
        )
        r += cw * rng.uniform(0.055, 0.085)
        i += 1

    layer = layer.filter(ImageFilter.GaussianBlur(radius=0.5 * SS))
    return layer.resize((w, h), Image.LANCZOS)


# ── 合成 ────────────────────────────────────────────────────────────────


def build_texture(theme: Theme, prof: Profile, seed_shift: int) -> Image.Image:
    """
    合成一张 RGBA 纹理。

    图层顺序（从下到上）：
      1. 强调色辉光（大尺度，负责纵深）
      2. 主图案（菌丝 / 裂纹 / 雷达弧环）
      3. 警示斜纹（仅 550W 的 card/hero）
      4. 暗角（把视线收回卡片中心）
      5. 斜向高光带（玻璃质感的那一道反射）

    **辉光与高光同样乘安静区遮罩**。最初只有图案层乘了遮罩，
    于是辉光溢进文字区，--t1 的对比度从 16.6 掉到 3.7——
    这是"看起来有纹理但字看不清"的典型成因。
    """
    w, h = prof.w, prof.h
    density = prof.density
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    qm = quiet_mask(w, h, prof.quiet_floor)

    # 1. 辉光
    #
    # 辉光**也要**乘安静区遮罩。漏了这一步是最初的 bug：
    # 图案层压住了、辉光层没压住，而辉光的亮度远高于图案，
    # 于是文字区被一团绿色雾笼罩，--t1 的对比度从 16.6 掉到 3.7。
    #
    # 辉光强度也不随 profile.density 线性放大：density 是给"图案密度"用的，
    # 辉光是"底光"，跟着放大就成了一片发光的雾。
    glow_a = radial_glow(w, h, 0.84, 0.78, prof.glow_r, theme.glow_alpha * (0.55 + 0.45 * density))
    canvas = Image.alpha_composite(canvas, solid_layer(w, h, theme.glow, glow_a * qm))

    # 2. 主图案
    if prof.motif:
        motif = draw_filament(w, h, theme) if theme.motif_kind == 'filament' else draw_crack(w, h, theme)
    elif prof.arcs:
        motif = draw_arcs(w, h, theme)
    else:
        motif = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    if motif.size != (w, h):
        motif = motif.resize((w, h), Image.LANCZOS)
    ma = np.asarray(motif.split()[3]).astype(np.float64) / 255.0
    canvas = Image.alpha_composite(canvas, tint_alpha(motif, ma * qm * density, theme.motif))

    # 3. 警示斜纹
    if prof.hatch:
        hatch = draw_hatch(w, h, theme)
        ha = np.asarray(hatch.split()[3]).astype(np.float64) / 255.0
        canvas = Image.alpha_composite(canvas, tint_alpha(hatch, ha * qm * density, theme.motif))

    # 4. 暗角
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    d = np.sqrt(((x - 0.5) / 0.80) ** 2 + ((y - 0.5) / 0.88) ** 2)
    vig = np.clip(d - 0.62, 0.0, 1.0) ** 1.6
    vig_amt = 0.30 if theme.mode == 'dark' else 0.14
    canvas = Image.alpha_composite(canvas, solid_layer(w, h, theme.vignette, vig * vig_amt * density))

    # 5. 斜向高光带：玻璃卡右上角那道反射。
    # 同样乘安静区遮罩——它是白色，在浅色主题上会把背景提亮，
    # 直接吃掉深色文字的对比度。
    band = np.sin((x * 1.5 + y * 2.2) * math.pi) ** 2
    band = band * np.clip(1.0 - (x + y) * 0.6, 0.0, 1.0)
    canvas = Image.alpha_composite(canvas, solid_layer(w, h, (255, 255, 255), band * theme.sheen * density * qm))

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

    os.makedirs(OUT, exist_ok=True)
    print(f'输出目录 {OUT}')

    # (标签, 纹理, 底色) —— 预览用
    previews: list[tuple[str, Image.Image, tuple[int, int, int]]] = []

    for theme in THEMES:
        for name, prof in PROFILES.items():
            tex = build_texture(theme, prof, seed_shift=0)
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
