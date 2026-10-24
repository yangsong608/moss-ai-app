#!/usr/bin/env python3
"""
MOSS AI App · 卡片与环境纹理生成器。

为什么是程序化生成而不是 AI 出图：
  1. **配色必须精确对齐设计令牌**（--acc / --s1 / --bg…）。AI 出图的色相不可控，
     一旦和 4 套主题（2 皮肤 × 明暗）都对不齐，界面就会"脏"。
  2. **文字安全区必须可度量**。程序化生成能保证安静区（文字所在区域）的
     亮度扰动 < 3%，而 AI 出图无法保证（常见问题是纹理里出现高对比硬边，
     压在小标题下面就变成"看不清"）。
  3. **包体**。App 首包预算是 400KB（docs/05 §8），纹理必须能压到几十 KB。
     程序化生成 + WebP 有损压缩（含有损 alpha）可以精确控体积。

产物（src/static/moss/tex/）：
  card-{skin}-{mode}.webp   卡片纹理（RGBA，图案压在玻璃渐变之上）
  hero-{skin}-{mode}.webp   主视觉卡纹理（浓度更高、构图更满）
  amb-{skin}-{mode}.webp    页面环境纹理（稀疏大尺度，压在页面底渐变之上）

主题（skin × mode）：
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
W_AMB, H_AMB = 520, 520

SS = 2  # 图案绘制时的超采样倍数（抗锯齿）


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
    hatch: bool = False               # 是否带工业警示斜纹


THEMES: list[Theme] = [
    # ── MOSS 冷青绿（生物终端）─────────────────────────────────────────
    Theme(
        key='moss-dark', skin='moss', mode='dark',
        motif=(126, 255, 205), glow=(70, 227, 166), vignette=(0, 5, 4),
        motif_alpha=0.34, glow_alpha=0.30, sheen=0.030, seed=20261024,
        motif_kind='filament',
    ),
    Theme(
        key='moss-light', skin='moss', mode='light',
        motif=(14, 138, 95), glow=(14, 138, 95), vignette=(96, 124, 112),
        motif_alpha=0.22, glow_alpha=0.13, sheen=0.038, seed=20261025,
        motif_kind='filament',
    ),
    # ── 550W 待机红（工业告警）─────────────────────────────────────────
    Theme(
        key='550w-dark', skin='550w', mode='dark',
        motif=(255, 152, 104), glow=(255, 59, 47), vignette=(8, 3, 2),
        motif_alpha=0.32, glow_alpha=0.30, sheen=0.026, seed=20261026,
        motif_kind='crack', hatch=True,
    ),
    Theme(
        key='550w-light', skin='550w', mode='light',
        motif=(180, 49, 31), glow=(180, 49, 31), vignette=(158, 112, 94),
        motif_alpha=0.21, glow_alpha=0.12, sheen=0.036, seed=20261027,
        motif_kind='crack', hatch=True,
    ),
]


# ── 基础工具 ────────────────────────────────────────────────────────────


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def quiet_mask(w: int, h: int) -> np.ndarray:
    """
    安静区遮罩：左上（文字区）→ 0.10，右下（图案区）→ 1.0。

    卡片上的标题、摘要、按钮都在左上或整幅展开，所以图案必须往右下方退。
    这个遮罩让纹理有明确的"呼吸区"，而不是均匀铺满——
    这是"不遮挡文字"的结构性保证，而不是靠调低整体不透明度
    （那会让纹理失去存在感）。

    残留在文字区的 0.10 系数是刻意的：完全为 0 会让左上出现
    一块"什么都没发生"的死区，看起来像图片没加载。
    """
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    wx = smoothstep((x - 0.30) / 0.55)
    wy = smoothstep((y - 0.18) / 0.62)
    m = np.clip(wx * wy * 1.12 - 0.02, 0.0, 1.0) ** 0.85
    return 0.10 + 0.90 * m


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
    rng = random.Random(theme.seed + 7)
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


# ── 合成 ────────────────────────────────────────────────────────────────


def build_texture(theme: Theme, w: int, h: int, density: float, seed_shift: int) -> Image.Image:
    """
    合成一张 RGBA 纹理。

    图层顺序（从下到上）：
      1. 强调色辉光（大尺度，负责纵深）
      2. 主图案（菌丝 / 裂纹）
      3. 警示斜纹（仅 550W）
      4. 暗角（把视线收回卡片中心）
      5. 斜向高光带（玻璃质感的那一道反射）

    图案层统一乘以安静区遮罩 —— 这是"不遮挡文字"的结构性保证。
    """
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    qm = quiet_mask(w, h)

    # 1. 辉光
    #
    # 辉光**也要**乘安静区遮罩。漏了这一步是最初的 bug：
    # 图案层压住了、辉光层没压住，而辉光的亮度远高于图案，
    # 于是文字区被一团绿色雾笼罩，--t1 的对比度从 16.6 掉到 3.7。
    # 辉光中心本来就在右下（qm≈1），遮罩不会削弱它的主体，
    # 只是掐掉了溢进文字区的那一圈。
    glow_a = radial_glow(w, h, 0.82, 0.76, 0.66, theme.glow_alpha * density)
    canvas = Image.alpha_composite(canvas, solid_layer(w, h, theme.glow, glow_a * qm))

    # 2. 主图案
    motif = draw_filament(w, h, theme) if theme.motif_kind == 'filament' else draw_crack(w, h, theme)
    ma = np.asarray(motif.split()[3]).astype(np.float64) / 255.0
    canvas = Image.alpha_composite(canvas, tint_alpha(motif, ma * qm * density, theme.motif))

    # 3. 警示斜纹
    if theme.hatch:
        hatch = draw_hatch(w, h, theme)
        ha = np.asarray(hatch.split()[3]).astype(np.float64) / 255.0
        canvas = Image.alpha_composite(canvas, tint_alpha(hatch, ha * qm * density, theme.motif))

    # 4. 暗角
    #
    # 暗角只压**边缘**（d > 0.56），文字区在左上角，d≈0.85 反而落在
    # 暗角最强处——但那正是"卡片外沿"，视觉上本来就该暗。
    # 为了不伤文字，这里把暗角上限从纯黑换成"接近底色的暗色"，
    # 并把浓度按明暗区分：浅色底上同样的暗角会把底色拉脏。
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
        specs = [
            ('card', W_CARD, H_CARD, 1.0, 0, 20_000),
            ('hero', W_HERO, H_HERO, 1.55, 11, 26_000),
            ('amb', W_AMB, H_AMB, 0.85, 23, 14_000),
        ]
        for name, w, h, density, shift, cap in specs:
            tex = build_texture(theme, w, h, density=density, seed_shift=shift)
            path = os.path.join(OUT, f'{name}-{theme.key}.webp')
            size, q = save_webp(tex, path, quality=74, max_bytes=cap)
            flag = '  ' if size <= cap else '⚠ '
            print(f'{flag}{name}-{theme.key}.webp  {w}x{h}  q={q}  {size / 1024:.1f}KB')
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
