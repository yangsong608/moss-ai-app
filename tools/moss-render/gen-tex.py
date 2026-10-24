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
     程序化生成 + WebP 有损压缩可以精确控体积。

产物（src/static/moss/tex/）：
  card-{skin}-{mode}.webp   卡片纹理（RGBA，图案压在玻璃渐变之上）
  hero-{skin}-{mode}.webp   主视觉卡纹理（浓度更高、构图更满）
  amb-{skin}-{mode}.webp    页面环境纹理（稀疏大尺度，压在页面底渐变之上）

主题（skin × mode）：
  moss  : 冷青绿，菌丝/孢子 —— 生物终端
  550w  : 待机红，热裂纹/警示斜纹 —— 工业告警
  dark  : 深底，靠加色发光制造纵深
  light : 浅底，图案压到极低不透明度，只留质感不抢内容

用法：
  python3 tools/moss-render/gen-tex.py            # 生成全部
  python3 tools/moss-render/gen-tex.py --preview  # 额外产出对照预览图
"""

from __future__ import annotations

import argparse
import math
import os
import random
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))

# ── 画布尺寸 ────────────────────────────────────────────────────────────
# 卡片纹理：卡片最大约 350pt 宽，@3x 需要 1050px，取 900 略软但足够——
# 纹理本身是柔和的抽象图案，锐度损失看不出来，体积却省三分之一。
W_CARD, H_CARD = 900, 560
W_HERO, H_HERO = 960, 460
W_AMB, H_AMB = 720, 720

SS = 2  # 图案绘制时的超采样倍数（抗锯齿）


# ── 主题定义 ────────────────────────────────────────────────────────────
@dataclass
class Theme:
    key: str
    skin: str
    mode: str
    # 图案主色（线条/裂纹）
    motif: tuple[int, int, int]
    # 辉光色（强调色）
    glow: tuple[int, int, int]
    # 暗角颜色：深色模式压黑，浅色模式用暖褐而不是纯黑（纯黑在浅底上会发脏）
    vignette: tuple[int, int, int]
    # 基础不透明度系数
    motif_alpha: float
    glow_alpha: float
    grain: float
    # 质感层（高光）
    sheen: float
    seed: int
    # 图案类型
    motif_kind: str = 'filament'
    # 额外：是否带警示斜纹
    hatch: bool = False


THEMES: list[Theme] = [
    # ── MOSS 冷青绿 ────────────────────────────────────────────────────
    Theme(
        key='moss-dark', skin='moss', mode='dark',
        motif=(126, 255, 205), glow=(70, 227, 166), vignette=(0, 4, 3),
        motif_alpha=0.20, glow_alpha=0.20, grain=0.030, sheen=0.020, seed=20261024,
        motif_kind='filament',
    ),
    Theme(
        key='moss-light', skin='moss', mode='light',
        motif=(14, 138, 95), glow=(14, 138, 95), vignette=(60, 86, 76),
        motif_alpha=0.085, glow_alpha=0.075, grain=0.022, sheen=0.030, seed=20261025,
        motif_kind='filament',
    ),
    # ── 550W 待机红 ────────────────────────────────────────────────────
    Theme(
        key='550w-dark', skin='550w', mode='dark',
        motif=(255, 148, 96), glow=(255, 59, 47), vignette=(6, 2, 1),
        motif_alpha=0.19, glow_alpha=0.20, grain=0.030, sheen=0.018, seed=20261026,
        motif_kind='crack', hatch=True,
    ),
    Theme(
        key='550w-light', skin='550w', mode='light',
        motif=(180, 49, 31), glow=(180, 49, 31), vignette=(122, 78, 60),
        motif_alpha=0.080, glow_alpha=0.070, grain=0.022, sheen=0.028, seed=20261027,
        motif_kind='crack', hatch=True,
    ),
]


# ── 基础工具 ────────────────────────────────────────────────────────────


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def quiet_mask(w: int, h: int, bias: float = 1.0) -> np.ndarray:
    """
    安静区遮罩：左上（文字区）→ 0，右下（图案区）→ 1。

    卡片上的标题、摘要、按钮都在左上或整幅展开，所以图案必须往右下方退。
    这个遮罩让纹理有明确的"呼吸区"，而不是均匀铺满。
    """
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    wx = smoothstep((x - 0.30) / 0.55)
    wy = smoothstep((y - 0.18) / 0.62)
    m = wx * wy
    # 保留一点点底噪分布，避免图案边界出现硬直线
    m = np.clip(m * 1.12 - 0.02, 0.0, 1.0) ** 0.85
    return 0.10 + 0.90 * m * bias


def noise_field(w: int, h: int, octaves: int, seed: int, persistence: float = 0.55) -> np.ndarray:
    """分形噪声（value noise 叠加），返回 0..1 的 float 场。"""
    rng = np.random.default_rng(seed)
    total = np.zeros((h, w), dtype=np.float64)
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        cells = max(2, 2 ** (o + 2))
        gw = max(2, int(cells))
        gh = max(2, int(cells * h / w))
        g = rng.random((gh, gw)).astype(np.float64)
        layer = Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        total += amp * (np.asarray(layer).astype(np.float64) / 255.0)
        norm += amp
        amp *= persistence
    return total / norm


def radial_glow(w: int, h: int, cx: float, cy: float, r: float, strength: float) -> np.ndarray:
    """径向辉光场，0..1。"""
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    d = np.sqrt(((x - cx) / r) ** 2 + ((y - cy) / r) ** 2)
    return np.clip(1.0 - d, 0.0, 1.0) ** 2.0 * strength


def compose_over(dst: Image.Image, layer: Image.Image) -> Image.Image:
    return Image.alpha_composite(dst, layer)


def solid_layer(w: int, h: int, rgb: tuple[int, int, int], alpha: np.ndarray) -> Image.Image:
    """由 alpha 场构造一个纯色图层。"""
    a = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    img = Image.new('RGBA', (w, h), rgb + (0,))
    img.putalpha(Image.fromarray(a, mode='L'))
    return img


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
        steps = max(6, int(length / (6 * SS)))
        step = length / steps
        pts = [(x, y)]
        for _ in range(steps):
            ang += rng.uniform(-0.30, 0.30)
            x += math.cos(ang) * step
            y += math.sin(ang) * step
            pts.append((x, y))
        # 越细的枝越透明：避免所有分支一样重，画面会显得平
        a = max(10, int(max_alpha * (0.45 + 0.55 * (width / 3.0))))
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

    # 若干条主枝，主枝起点散布在画布中下区域
    for _ in range(7):
        x = rng.uniform(0.28, 0.98) * cw
        y = rng.uniform(0.30, 1.02) * ch
        branch(x, y, rng.uniform(0, math.tau), rng.uniform(0.16, 0.34) * cw, 3, 3)

    # 孢子：菌丝的果实，也是暗底上的唯一点状高光
    for _ in range(150):
        x = rng.uniform(0.2, 1.0) * cw
        y = rng.uniform(0.15, 1.0) * ch
        r = rng.uniform(0.8, 2.6) * SS
        a = int(max_alpha * rng.uniform(0.35, 1.0))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (a,))

    layer = layer.resize((w, h), Image.LANCZOS)
    return layer


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
        steps = max(8, int(length / (5 * SS)))
        step = length / steps
        pts = [(x, y)]
        for _ in range(steps):
            ang += rng.uniform(-0.22, 0.22)
            x += math.cos(ang) * step
            y += math.sin(ang) * step
            pts.append((x, y))
        a = max(12, int(max_alpha * (0.40 + 0.60 * (width / 3.0))))
        # 裂纹是"缝"，比菌丝更硬：多段折线拼出来才有金属开裂的感觉
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

    for _ in range(8):
        x = rng.uniform(0.42, 1.02) * cw
        y = rng.uniform(0.34, 1.05) * ch
        crack(x, y, rng.uniform(0, math.tau), rng.uniform(0.10, 0.26) * cw, 3, 3)

    # 余烬：炭化后还没灭的点
    for _ in range(120):
        x = rng.uniform(0.35, 1.0) * cw
        y = rng.uniform(0.25, 1.0) * ch
        r = rng.uniform(0.6, 2.0) * SS
        a = int(max_alpha * rng.uniform(0.3, 1.0))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (a,))

    layer = layer.resize((w, h), Image.LANCZOS)
    return layer


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
    alpha = int(round(theme.motif_alpha * 255 * 0.8))

    # 斜纹带区域（右下）
    x0 = int(cw * 0.58)
    y0 = int(ch * 0.52)
    bw = int(cw * 0.42)
    bh = int(ch * 0.48)
    gap = int(14 * SS)
    wdt = int(6 * SS)
    for i in range(-bh, bw + bh, gap):
        draw.line(
            [(x0 + i, y0), (x0 + i + bh, y0 + bh)],
            fill=rgb + (alpha,), width=wdt,
        )
    # 边界羽化：把带的边缘擦成渐隐，避免出现一条直线切口
    layer = layer.filter(ImageFilter.GaussianBlur(radius=1.6 * SS))
    a = np.asarray(layer.split()[3]).astype(np.float64) / 255.0
    yy = np.linspace(0.0, 1.0, h)[:, None]
    xx = np.linspace(0.0, 1.0, w)[None, :]
    edge = smoothstep((xx - 0.52) / 0.16) * smoothstep((yy - 0.46) / 0.18)
    a = a * edge
    out = Image.new('RGBA', (w, h), rgb + (0,))
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8), mode='L'))
    return out


# ── 合成 ────────────────────────────────────────────────────────────────


def build_texture(theme: Theme, w: int, h: int, density: float, seed_shift: int) -> Image.Image:
    """
    合成一张 RGBA 纹理。

    图层顺序（从下到上）：
      1. 强调色辉光（大尺度，负责纵深）
      2. 主图案（菌丝 / 裂纹）
      3. 警示斜纹（仅 550W）
      4. 颗粒（纸质/屏幕感）
      5. 暗角（把视线收回卡片中心）
      6. 斜向高光带（玻璃质感的那一道反射）

    图案层统一乘以安静区遮罩 —— 这是"不遮挡文字"的结构性保证，
    而不是靠调低整体不透明度（那会让纹理变得没有存在感）。
    """
    seed = theme.seed + seed_shift
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))

    qm = quiet_mask(w, h)

    # 1. 辉光
    glow_a = radial_glow(w, h, 0.80, 0.74, 0.62, theme.glow_alpha * density)
    canvas = compose_over(canvas, solid_layer(w, h, theme.glow, glow_a))

    # 2. 主图案
    if theme.motif_kind == 'filament':
        motif = draw_filament(w, h, theme)
    else:
        motif = draw_crack(w, h, theme)
    ma = np.asarray(motif.split()[3]).astype(np.float64) / 255.0
    ma = ma * qm * density
    motif = Image.new('RGBA', (w, h), theme.motif + (0,))
    motif.putalpha(Image.fromarray((np.clip(ma, 0, 1) * 255).astype(np.uint8), mode='L'))
    canvas = compose_over(canvas, motif)

    # 3. 警示斜纹
    if theme.hatch:
        hatch = draw_hatch(w, h, theme)
        ha = np.asarray(hatch.split()[3]).astype(np.float64) / 255.0
        ha = ha * qm * density
        hatch = Image.new('RGBA', (w, h), theme.motif + (0,))
        hatch.putalpha(Image.fromarray((np.clip(ha, 0, 1) * 255).astype(np.uint8), mode='L'))
        canvas = compose_over(canvas, hatch)

    # 4. 颗粒
    if theme.grain > 0:
        rng = np.random.default_rng(seed)
        n = rng.normal(0.0, 1.0, (h, w))
        pos = np.clip(n, 0, None)
        neg = np.clip(-n, 0, None)
        canvas = compose_over(canvas, solid_layer(w, h, (255, 255, 255), pos * theme.grain * density))
        canvas = compose_over(canvas, solid_layer(w, h, theme.vignette, neg * theme.grain * 1.6 * density))

    # 5. 暗角
    x = np.linspace(0.0, 1.0, w)[None, :]
    y = np.linspace(0.0, 1.0, h)[:, None]
    d = np.sqrt(((x - 0.5) / 0.78) ** 2 + ((y - 0.5) / 0.86) ** 2)
    vig = np.clip(d - 0.55, 0.0, 1.0) ** 1.5
    vig_amt = 0.30 if theme.mode == 'dark' else 0.16
    canvas = compose_over(canvas, solid_layer(w, h, theme.vignette, vig * vig_amt * density))

    # 6. 斜向高光带：玻璃卡右上角那道反射
    band = np.sin((x * 1.5 + y * 2.2) * math.pi) ** 2
    band = band * np.clip(1.0 - (x + y) * 0.6, 0.0, 1.0)
    canvas = compose_over(canvas, solid_layer(w, h, (255, 255, 255), band * theme.sheen * density))

    return canvas


def save_webp(img: Image.Image, path: str, quality: int, max_bytes: int | None = None) -> int:
    """
    保存 WebP 并（在给定上限时）自动降质重试。

    包体是硬约束：纹理必须能被塞进首包预算里，所以这里不是"导出一次就完"，
    而是"导出并验证体积"。降质优先于降分辨率——纹理本来就是柔和图案，
    降质看不出来，降分辨率会看出糊。
    """
    q = quality
    best = None
    for _ in range(6):
        img.save(path, 'WEBP', quality=q, method=6)
        size = os.path.getsize(path)
        best = (path, size, q)
        if max_bytes is None or size <= max_bytes:
            break
        q -= 8
        if q < 26:
            break
    return best[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', action='store_true', help='额外产出对照预览图')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    print(f'输出目录 {OUT}')

    previews: list[tuple[str, Image.Image]] = []

    for theme in THEMES:
        # 卡片纹理：图案密度中等，铺在大面积玻璃卡上
        card = build_texture(theme, W_CARD, H_CARD, density=1.0, seed_shift=0)
        p = os.path.join(OUT, f'card-{theme.key}.webp')
        size = save_webp(card, p, quality=74, max_bytes=34_000)
        print(f'  card-{theme.key}.webp  {W_CARD}x{H_CARD}  {size / 1024:.1f}KB')
        previews.append((f'card · {theme.key}', card))

        # 主视觉卡纹理：更满、更有结构，用在大卡片（今天页大日期卡、我的页控制台）
        hero = build_texture(theme, W_HERO, H_HERO, density=1.55, seed_shift=11)
        p = os.path.join(OUT, f'hero-{theme.key}.webp')
        size = save_webp(hero, p, quality=76, max_bytes=42_000)
        print(f'  hero-{theme.key}.webp  {W_HERO}x{H_HERO}  {size / 1024:.1f}KB')
        previews.append((f'hero · {theme.key}', hero))

        # 页面环境纹理：稀疏大尺度，压在页面底渐变之上
        amb = build_texture(theme, W_AMB, H_AMB, density=0.85, seed_shift=23)
        p = os.path.join(OUT, f'amb-{theme.key}.webp')
        size = save_webp(amb, p, quality=70, max_bytes=26_000)
        print(f'  amb-{theme.key}.webp   {W_AMB}x{H_AMB}  {size / 1024:.1f}KB')
        previews.append((f'amb · {theme.key}', amb))

    total = sum(
        os.path.getsize(os.path.join(OUT, f))
        for f in os.listdir(OUT) if f.endswith('.webp')
    )
    print(f'合计 {total / 1024:.1f}KB')

    if args.preview:
        # 预览图：把 12 张纹理按"深底 + 浅底"两种底色贴出来，肉眼检查
        cols, rows = 3, 4
        cw, ch = 300, 200
        sheet = Image.new('RGB', (cols * cw, rows * ch), (10, 14, 12))
        for i, (label, img) in enumerate(previews):
            bg = Image.new('RGBA', img.size, (12, 20, 17, 255) if i % 2 == 0 else (243, 247, 244, 255))
            comp = Image.alpha_composite(bg, img).convert('RGB')
            comp = comp.resize((cw - 8, ch - 8), Image.LANCZOS)
            sheet.paste(comp, ((i % cols) * cw + 4, (i // cols) * ch + 4))
        out = os.path.join(HERE, 'tex-preview.png')
        sheet.save(out)
        print(f'预览 {out}')


if __name__ == '__main__':
    main()
