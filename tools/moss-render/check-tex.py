#!/usr/bin/env python3
"""
MOSS AI App · 纹理可读性校验。

回答一个具体问题：**把纹理铺到卡片上以后，卡片里的字还读得清吗？**

## 判据为什么是"相对劣化"而不是"绝对阈值"

第一版用的是绝对阈值（对比度必须 ≥ 4.5:1），结果报了一堆"不通过"。
但查下去发现：**那些不通过项在没有纹理时就已经不达标了**——
本项目的 --t3（元信息色，如时间戳、计数）在卡片底色上本来就只有 3.5:1，
这是既有的设计决策（它是弱化信息，不是正文）。

用绝对阈值会把"项目原有的设计取舍"误判成"纹理引入的缺陷"，
于是校验脚本给出的结论是错的。

真正该问的问题是：**纹理相对"什么都不加"的基线，劣化了多少？**
所以这里的判据是两条：

  1. **绝对下限**：正文色 --t1 与卡片底色的对比度，加纹理后仍需 ≥ 4.5:1。
     这条不打折——正文可读性是硬要求。
  2. **相对劣化**：任何文字色（含弱化的 --t3）加上纹理后，
     对比度不得比基线下降超过 35%。
     换句话说：纹理的贡献必须是"可感知的质感"，不是"读不清的字"。

文字区定义为卡片的左上 62% × 72%（标题 / 摘要 / 按钮所在处）。
图案区（右下的密集纹理）允许更激进——那里的对比度只要不塌到 3:1 以下即可，
因为那儿本来就不放正文。

用法：
  python3 tools/moss-render/check-tex.py
退出码非 0 表示有主题没过门槛。
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))

# 与 src/styles/tokens.scss 一一对应。改主题必须同步改这里——
# 校验脚本读的是"令牌真相"，不是图片自己。
# surface = 卡片玻璃渐变在文字区的等效底色（s1→s2 的中值）
THEMES = {
    'moss-dark': {
        'surface': (0x0b, 0x12, 0x10),
        'text': (0xe6, 0xf3, 0xec),     # --t1 正文
        'text2': (0x8f, 0xa7, 0x9b),    # --t2 次要
        'text3': (0x5b, 0x6f, 0x66),    # --t3 元信息
    },
    'moss-light': {
        'surface': (0xff, 0xff, 0xff),
        'text': (0x0b, 0x15, 0x12),
        'text2': (0x4a, 0x5d, 0x55),
        'text3': (0x7b, 0x8d, 0x85),
    },
    '550w-dark': {
        'surface': (0x12, 0x09, 0x08),
        'text': (0xf2, 0xea, 0xe4),
        'text2': (0xb4, 0x9a, 0x92),
        'text3': (0x7a, 0x60, 0x58),
    },
    '550w-light': {
        'surface': (0xff, 0xfd, 0xf9),
        'text': (0x1a, 0x0f, 0x0c),
        'text2': (0x6b, 0x53, 0x4c),
        'text3': (0x95, 0x80, 0x6f),
    },
}

# 卡片文字区：左上 62% × 72%
TEXT_ZONE = (0.00, 0.62, 0.00, 0.72)
# 卡片图案区：右下密集纹理
PATTERN_ZONE = (0.62, 1.00, 0.45, 1.00)

_LUT = np.array([(c / 255.0 / 12.92) if (c / 255.0) <= 0.04045
                 else (((c / 255.0) + 0.055) / 1.055) ** 2.4
                 for c in range(256)])


def rel_luminance(rgb) -> float:
    r, g, b = (float(v) for v in rgb)
    return float(0.2126 * _LUT[int(r)] + 0.7152 * _LUT[int(g)] + 0.0722 * _LUT[int(b)])


def contrast(a, b) -> float:
    la, lb = rel_luminance(a), rel_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def composite_over(surface, tex: Image.Image) -> Image.Image:
    bg = Image.new('RGBA', tex.size, tuple(surface) + (255,))
    return Image.alpha_composite(bg, tex).convert('RGB')


def zone_lum(img: Image.Image, zone) -> tuple[float, float]:
    """返回区域内像素相对亮度的 (最暗, 最亮)。"""
    w, h = img.size
    x0, x1, y0, y1 = zone
    crop = img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
    a = np.asarray(crop).astype(np.uint8)
    lum = (0.2126 * _LUT[a[:, :, 0]] + 0.7152 * _LUT[a[:, :, 1]] + 0.0722 * _LUT[a[:, :, 2]])
    return float(lum.min()), float(lum.max())


def worst_contrast(text_rgb, img: Image.Image, zone) -> float:
    """
    文字色 vs 区域内最不利的底色像素，取对比度最小值。

    浅色文字怕底色太亮，深色文字怕底色太暗，中等亮度文字（--t3）
    两种都要考虑——所以这里取两个方向的较小值。
    """
    lo, hi = zone_lum(img, zone)
    lt = rel_luminance(text_rgb)
    c_light_text = contrast(text_rgb, _lum_to_rgb(hi))
    c_dark_text = contrast(text_rgb, _lum_to_rgb(lo))
    return min(c_light_text, c_dark_text)


def _lum_to_rgb(lum: float) -> tuple[int, int, int]:
    """把相对亮度反解成灰色 RGB（用于计算对比度）。"""
    if lum <= 0.0031308:
        srgb = lum * 12.92
    else:
        srgb = 1.055 * (lum ** (1 / 2.4)) - 0.055
    v = int(round(max(0.0, min(1.0, srgb)) * 255))
    return (v, v, v)


def main() -> int:
    if not os.path.isdir(TEX):
        print(f'找不到纹理目录 {TEX}，先跑 gen-tex.py')
        return 2

    failures: list[str] = []
    print(f'{"主题":<13}{"纹理":<7}{"区域":<7}{"文字":<6}{"基线":>7}{"带纹理":>8}{"劣化":>8}  结论')
    print('─' * 70)

    for key, t in THEMES.items():
        surface = t['surface']
        for kind in ('card', 'hero', 'amb'):
            path = os.path.join(TEX, f'{kind}-{key}.webp')
            if not os.path.exists(path):
                failures.append(f'{kind}-{key}: 文件缺失')
                continue
            tex = Image.open(path).convert('RGBA')
            comp = composite_over(surface, tex)

            for zone_name, zone, is_text_zone in (
                ('文字区', TEXT_ZONE, True),
                ('图案区', PATTERN_ZONE, False),
            ):
                for text_name, text_rgb in (
                    ('--t1', t['text']), ('--t2', t['text2']), ('--t3', t['text3'])
                ):
                    # 基线 = 纯卡片底色（不加纹理）
                    base = contrast(text_rgb, surface)
                    ratio = worst_contrast(text_rgb, comp, zone)
                    drop = 1.0 - (ratio / base) if base > 0 else 0.0

                    ok = True
                    if is_text_zone:
                        # 正文色绝对下限：4.5:1（正文与元信息字号都 < 18px）
                        if text_name == '--t1' and ratio < 4.5:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: {ratio:.2f} < 4.5（正文绝对下限）'
                            )
                        # 相对劣化不超过 35%
                        if drop > 0.35:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: '
                                f'劣化 {drop * 100:.0f}% > 35%（基线 {base:.2f} → {ratio:.2f}）'
                            )
                    else:
                        # 图案区不放大字，但也不能塌到读不清
                        if ratio < 3.0:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: {ratio:.2f} < 3.0'
                            )

                    print(
                        f'{key:<13}{kind:<7}{zone_name:<7}{text_name:<6}'
                        f'{base:>6.2f}:{ratio:>7.2f}:{drop * 100:>6.0f}%  {"通过" if ok else "不通过"}'
                    )

    print('─' * 70)
    if failures:
        print(f'✗ {len(failures)} 项未通过：')
        for f in failures:
            print(f'  · {f}')
        return 1
    print('✓ 全部主题通过')
    print('  · 正文色 --t1 在文字区 ≥ 4.5:1')
    print('  · 所有文字色相对无纹理基线的劣化 ≤ 35%')
    print('  · 图案区任意文字色 ≥ 3.0:1')
    return 0


if __name__ == '__main__':
    sys.exit(main())
