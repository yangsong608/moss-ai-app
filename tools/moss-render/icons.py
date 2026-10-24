#!/usr/bin/env python3
"""
图标构建：把 AI 生成的黑底线稿（可一行多个）拆成单个图标，
按四套主题重新上色，输出到 src/static/moss/icon/。

和 tex-build.py 的分工：
  tex-build  → 卡片/页面纹理（大图，靠 anchor 定位）
  icons.py   → UI 图标（小图，正方形画布，直接 <MossIcon> 用）

复用同一套抠线与上色机制（extract_graphic / THEMES），
所以图标和卡片纹理在任何主题下都是同一个色系。

主图放在 tools/moss-render/raw-icons/，两种形态：
  1) 一行多个：文件名 = <名字1>__<名字2>__....png（用双下划线分隔）
     生图提示词要求"单行、等距、大间距"，脚本按透明列间隙自动切。
  2) 单个：文件名 = <名字>.png

画布统一正方形 ICON_PX，图形按包围盒等比缩放到 FILL 比例，
保证不同密度的图标（✕ 很空、日历很满）视觉量感一致。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

_spec = importlib.util.spec_from_file_location('tb', HERE / 'tex-build.py')
tb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tb)

RAW = HERE / 'raw-icons'
OUT = ROOT / 'src' / 'static' / 'moss' / 'icon'

# UI 图标画布。96px 给 18–32px 的显示尺寸留足 3–5 倍降采样余量，
# 线稿 downsample 后边缘是抗锯齿的，不会出现毛刺。
ICON_PX = 96
FILL = 0.78          # 图形占画布的比例
BADGE_PX = 128       # 状态角标（28px 显示）
HERO_PX = 384        # 品牌图（大）


# 状态色图标：不重新生图，直接把 alpha 刷成令牌色就行。
# 色值抄自 src/styles/tokens.scss 四个主题块，改令牌要同步改这里。
#
# 结构：图标名 → (配色名, {主题: RGB})
# 文件名：<name>-<配色名>-<skin>-<mode>.webp，MossIcon 用 tint prop 选中。
TINTS: dict[str, tuple[str, dict[str, tuple[int, int, int]]]] = {
    'clock': ('warn', {   # 待专注 / 提醒 —— --warn
        'moss-dark': (0xE8, 0xC2, 0x4A), '550w-dark': (0xE8, 0xC2, 0x4A),
        'moss-light': (0xA3, 0x74, 0x1A), '550w-light': (0x8A, 0x64, 0x14),
    }),
    'alert': ('danger', {  # 高优先 / 异常 —— --danger
        'moss-dark': (0xFF, 0x5C, 0x4D), '550w-dark': (0xFF, 0x3B, 0x2F),
        'moss-light': (0xC0, 0x39, 0x2B), '550w-light': (0xB4, 0x31, 0x1F),
    }),
    'check': ('done', {   # 已完成 —— --st-done
        'moss-dark': (0x3F, 0xAE, 0x73), '550w-dark': (0x15, 0x80, 0x3D),
        'moss-light': (0x0E, 0x8A, 0x5F), '550w-light': (0x1F, 0x7A, 0x52),
    }),
    'bell': ('warn', {    # 提醒 —— 跟随 warn
        'moss-dark': (0xE8, 0xC2, 0x4A), '550w-dark': (0xE8, 0xC2, 0x4A),
        'moss-light': (0xA3, 0x74, 0x1A), '550w-light': (0x8A, 0x64, 0x14),
    }),
}


def alpha_map(img: Image.Image, cut: float = 0.15) -> np.ndarray:
    """
    黑底稿没有 alpha 通道，先用亮度算一张"哪些列有内容"的图。
    阈值取得比 extract_graphic 的 cut 低一档，宁可多切不可漏切。
    """
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    return a.max(axis=2)


def split_boxes(img: Image.Image, min_gap_ratio: float = 0.018) -> list[tuple[int, int]]:
    """
    按"整列都接近全黑"把一行图标切开，返回 [(x0, x1), ...]。

    间隙判定用亮度的列最大值：一列只要有一个亮像素就不是间隙。
    min_gap_ratio 是相对图宽的极小间隙宽度，防止把图标内部的断裂当成分隔。
    """
    lum = alpha_map(img)
    col = lum.max(axis=0)
    w = img.width
    min_gap = max(8, int(w * min_gap_ratio))

    occupied = col > 0.10
    segs: list[tuple[int, int]] = []
    start = None
    gap = 0
    for x in range(w):
        if occupied[x]:
            if start is None:
                start = x
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap >= min_gap:
                    segs.append((start, x - gap + 1))
                    start = None
                    gap = 0
    if start is not None:
        segs.append((start, w))

    # 过滤噪声段：生图工具偶尔会在边角留下淡淡的水印痕
    real = []
    for x0, x1 in segs:
        seg = lum[:, x0:x1]
        if seg.max() <= 0.10:
            continue
        if (seg > 0.10).sum() < 0.0006 * seg.size:
            continue
        real.append((x0, x1))
    return real


def merge_to(boxes: list[tuple[int, int]], n: int) -> list[tuple[int, int]]:
    """
    切出的段比期望多时，把最小间隙并回去。

    典型受害者是"四个角括号"这类本身带大空腔的图标（scan）：
    它左右两半之间的空腔比图标之间的间距还大，会被误切成两个。
    段数少于期望时没法自动补，只能报错让人工看。
    """
    out = list(boxes)
    while len(out) > n:
        gaps = [(out[i + 1][0] - out[i][1], i) for i in range(len(out) - 1)]
        _, i = min(gaps)
        out[i] = (out[i][0], out[i + 1][1])
        del out[i + 1]
    return out


def fit(graphic: Image.Image, canvas: int = ICON_PX, fill: float = FILL) -> Image.Image:
    """把裁剪后的图形放进正方形画布，等比缩放，居中。"""
    box = min(canvas * fill, canvas)
    g = tb.trim(graphic)
    if g.width == 0 or g.height == 0:
        return Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    s = min(box / g.width, box / g.height)
    nw, nh = max(1, round(g.width * s)), max(1, round(g.height * s))
    g = g.resize((nw, nh), Image.LANCZOS)
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(g, ((canvas - nw) // 2, (canvas - nh) // 2))
    return out


def build_one(name: str, raw: Image.Image, canvas: int = ICON_PX, fill: float = FILL) -> int:
    """四套主题各出一张，返回总字节数。"""
    total = 0
    for theme_name, theme in tb.THEMES.items():
        skin, mode = theme_name.split('-')
        graphic = tb.extract_graphic(raw, theme)
        im = fit(graphic, canvas, fill)
        dst = OUT / f'{name}-{skin}-{mode}.webp'
        dst.parent.mkdir(parents=True, exist_ok=True)
        q = 88 if canvas >= HERO_PX else 92
        im.save(dst, 'WEBP', quality=q, method=6)
        total += dst.stat().st_size
    return total


# 实心变体：轮廓图 + 程序填色。用于"已收藏"这类同形不同填充的状态，
# 不需要再出一张主图 —— 把轮廓内部填满即可。
FILLED = {'star'}

# 主图里有、但界面上用不到的图标。不产出，避免打进包里占体积。
#
# grid / mark 都来自组合主图（scan__file__folder__grid、mark.png）：
#   grid —— 原计划给"网格视图"切换用，那个控件后来删了
#   mark —— 原计划给"标记"用，功能并进了笔记的标签
# 主图仍然保留在 raw-icons/ 里（万一路上要用，删母版不如删产物）。
DEAD = {'grid', 'mark'}


def fill_holes(graphic: Image.Image, line: tuple[int, int, int], thresh: int = 60) -> Image.Image:
    # 按阈值取二值 mask → 形态学闭运算补上抗锯齿的接缝 → 从四角洪水填充"外部"，
    # 剩下的（轮廓 + 内部）就是实心区。
    # 不做闭运算的话，线稿接缝会漏光，内部连到外部一起被填掉，填充失败。
    a = np.asarray(graphic)[..., 3]
    mask = Image.fromarray(((a > thresh) * 255).astype(np.uint8))
    # MaxFilter = 膨胀，MinFilter = 腐蚀；先后各来一次就是闭运算
    closed = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    ImageDraw.floodfill(closed, (0, 0), 128)
    solid = np.asarray(closed) != 128

    # 注意：WebP 会把"全透明像素"的 RGB 抹成 0，所以只补 alpha 会得到黑心。
    # 实心区的 RGB 必须一起写上主题色。
    out = np.asarray(graphic).copy()
    color = np.asarray(line, dtype=np.uint8)
    out[solid, :3] = color
    out[..., 3] = np.maximum(out[..., 3], (solid * 255).astype(np.uint8))
    return Image.fromarray(out, 'RGBA')


def build_filled(name: str, raw: Image.Image, canvas: int, fill: float) -> int:
    total = 0
    for theme_name, theme in tb.THEMES.items():
        skin, mode = theme_name.split('-')
        g = fill_holes(fit(tb.extract_graphic(raw, theme), canvas, fill), theme['line'])
        dst = OUT / f'{name}-fill-{skin}-{mode}.webp'
        g.save(dst, 'WEBP', quality=92, method=6)
        total += dst.stat().st_size
    return total


def recolor(graphic: Image.Image, line: tuple[int, int, int]) -> Image.Image:
    """保留 alpha，只把 RGB 换成目标色。"""
    a = np.asarray(graphic).astype(np.float32)
    color = np.asarray(line, dtype=np.float32)
    rgb = np.broadcast_to(color[None, None, :], a.shape[:2] + (3,))
    out = np.dstack([rgb, a[..., 3]]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def build_tints(name: str, raw: Image.Image, canvas: int, fill: float) -> int:
    """给带状态语义的图标补一套配色变体，返回新增字节数。"""
    label, colors = TINTS[name]
    total = 0
    for theme_key, line in colors.items():
        theme = dict(tb.THEMES[theme_key])
        theme['line'] = line
        im = fit(tb.extract_graphic(raw, theme), canvas, fill)
        skin, mode = theme_key.split('-')
        dst = OUT / f'{name}-{label}-{skin}-{mode}.webp'
        im.save(dst, 'WEBP', quality=92, method=6)
        total += dst.stat().st_size
    return total


def main() -> None:
    only = set(a for a in sys.argv[1:] if not a.startswith('-'))
    if not RAW.exists():
        print(f'没有主图目录：{RAW}')
        return

    jobs: list[tuple[str, Image.Image, int, float]] = []
    for f in sorted(RAW.glob('*.png')):
        names = [n for n in f.stem.split('__') if n]
        raw = tb.remove_watermark(Image.open(f))
        boxes = split_boxes(raw)
        if len(boxes) < len(names):
            print(f'!! {f.name}: 期望 {len(names)} 个，只切出 {len(boxes)} 个，跳过')
            continue
        boxes = merge_to(boxes, len(names))
        canvas, fill = ICON_PX, FILL
        if names[0].startswith('badge'):
            canvas, fill = BADGE_PX, 0.86
        elif names[0].startswith('hero'):
            canvas, fill = HERO_PX, 0.90
        for name, (x0, x1) in zip(names, boxes):
            jobs.append((name, raw.crop((x0, 0, x1, raw.height)), canvas, fill))

    if only:
        jobs = [j for j in jobs if j[0] in only]

    jobs = [j for j in jobs if j[0] not in DEAD]

    total = 0
    for name, part, canvas, fill in jobs:
        n = build_one(name, part, canvas, fill)
        total += n
        print(f'{name:<12}{canvas}×{canvas:<6}4 张 {n / 1024:>7.1f}K')
        if name in TINTS:
            n = build_tints(name, part, canvas, fill)
            total += n
            print(f'{name + "-" + TINTS[name][0]:<12}{canvas}×{canvas:<6}4 张 {n / 1024:>7.1f}K')
        if name in FILLED:
            n = build_filled(name, part, canvas, fill)
            total += n
            print(f'{name + "-fill":<12}{canvas}×{canvas:<6}4 张 {n / 1024:>7.1f}K')
    print(f'\n共 {len(jobs)} 个图标，{total / 1024:.1f}K')


if __name__ == '__main__':
    main()
