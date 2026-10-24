#!/usr/bin/env python3
"""
MOSS AI App · 纹理可读性校验。

回答一个具体问题：**把纹理铺到卡片上以后，卡片里的字还读得清吗？**

## 一、真实的图层模型（这一点决定结论对不对）

卡片不是"底色 + 纹理"这么简单。项目已有的玻璃卡是三层结构：

    ┌─ 文字 ────────────────────────┐
    │  玻璃层  rgba(s1, 80%)          │  ← 半透明，压在纹理之上
    │  纹理层  纹理图（RGBA）          │  ← 底部
    │  基底层  页面底色                │
    └───────────────────────────────┘

所以最终背景色 = 玻璃盖在（纹理盖在底色）之上。

**第一版校验错在这里**：它把纹理直接叠在底色上，得出"文字区对比度只有 1.7:1"
的结论——但那不是真实渲染结果。真实的玻璃层会自动把纹理的贡献压到 ~20%，
这既是现成的视觉语言（玻璃卡本来就该有透光感），
也是天然的亮度上限：再亮的纹理也透不过 80% 的玻璃。

## 二、判据

  1. **绝对下限**：正文色 --t1 在文字区仍需 ≥ 4.5:1（正文 14–15px，不是大字）。
  2. **相对劣化**：任何文字色加上纹理后，对比度相对"无纹理基线"下降不超过 35%。
     用相对判据而不是绝对阈值，是因为 --t3（元信息色）在无纹理时本来就只有
     3.4–3.7:1——那是项目既有的设计取舍（弱化信息），不是纹理引入的缺陷。
     第一版用绝对阈值，把既有问题误判成了新缺陷。
  3. **图案区**：不放正文，但 --t1/--t2 可能被用到（卡片角上的计数、状态标签），
     要求 ≥ 3.0:1；--t3 允许 ≥ 2.0:1。

文字区 = 卡片左上 62% × 72%（标题 / 摘要 / 按钮所在处）。
图案区 = 右下密集纹理区。

## 三、应用不透明度

图片里烘焙的是**图案遮罩**（哪里有纹、哪里干净），最终强度由 CSS 的
opacity 令牌控制（--tex-card-op / --tex-hero-op / --tex-amb-op）。
必须按最终叠加结果算，否则会出现"校验通过、实际看不清"。

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

# ── 主题令牌（与 src/styles/tokens.scss 一一对应）─────────────────────
#
# page_bg : 卡片背后的页面底色（玻璃层下面的基底层）
# glass   : 玻璃层的颜色与不透明度（--console-glass / --console-glass-low）
# text*   : --t1 / --t2 / --t3
THEMES = {
    'moss-dark': {
        'page_bg': (0x05, 0x08, 0x06),
        'glass': (0x0b, 0x12, 0x10), 'glass_a': 0.80,
        'text': (0xe6, 0xf3, 0xec),
        'text2': (0x8f, 0xa7, 0x9b),
        'text3': (0x5b, 0x6f, 0x66),
    },
    'moss-light': {
        'page_bg': (0xf2, 0xf7, 0xf4),
        'glass': (0xff, 0xff, 0xff), 'glass_a': 0.84,
        'text': (0x0b, 0x15, 0x12),
        'text2': (0x4a, 0x5d, 0x55),
        'text3': (0x7b, 0x8d, 0x85),
    },
    '550w-dark': {
        'page_bg': (0x0a, 0x05, 0x04),
        'glass': (0x12, 0x09, 0x08), 'glass_a': 0.80,
        'text': (0xf2, 0xea, 0xe4),
        'text2': (0xb4, 0x9a, 0x92),
        'text3': (0x7a, 0x60, 0x58),
    },
    '550w-light': {
        'page_bg': (0xf7, 0xf1, 0xe7),
        'glass': (0xff, 0xfd, 0xf9), 'glass_a': 0.84,
        'text': (0x1a, 0x0f, 0x0c),
        'text2': (0x6b, 0x53, 0x4c),
        'text3': (0x95, 0x80, 0x6f),
    },
}

# 卡片文字区：左上 62% × 72%
TEXT_ZONE = (0.00, 0.62, 0.00, 0.72)
# 卡片图案区：右下密集纹理
PATTERN_ZONE = (0.62, 1.00, 0.45, 1.00)

# ── 应用不透明度（与 tokens.scss 的 --tex-*-op 一致）──────────────────
#
# 卡片纹理是 <image> 组件，铺在卡片的玻璃渐变**之下**；
# 所以最终背景 = 纹理（按 op 缩放）→ 玻璃盖在上面 → 页面底色。
APPLY_OPACITY = {
    'card': 0.85,
    'hero': 1.00,
    'amb': 0.40,
}

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


def _lum_to_rgb(lum: float) -> tuple[int, int, int]:
    if lum <= 0.0031308:
        srgb = lum * 12.92
    else:
        srgb = 1.055 * (lum ** (1 / 2.4)) - 0.055
    v = int(round(max(0.0, min(1.0, srgb)) * 255))
    return (v, v, v)


def _alpha_scaled(tex: Image.Image, opacity: float) -> Image.Image:
    if opacity == 1.0:
        return tex
    t = tex.copy()
    t.putalpha(tex.split()[3].point(lambda v: int(v * opacity)))
    return t


def render_card(theme: dict, tex: Image.Image, opacity: float) -> Image.Image:
    """
    渲染卡片的真实底色：玻璃层盖在（纹理盖在页面底色）之上。

    amb 是页面级环境层，没有玻璃，直接叠在页面底色上。
    """
    tex = _alpha_scaled(tex, opacity)
    bg = Image.new('RGBA', tex.size, tuple(theme['page_bg']) + (255,))
    if 'glass' in theme:
        base = Image.alpha_composite(bg, tex)
        glass = Image.new('RGBA', tex.size, tuple(theme['glass']) + (int(theme['glass_a'] * 255),))
        return Image.alpha_composite(base, glass).convert('RGB')
    return Image.alpha_composite(bg, tex).convert('RGB')


def render_baseline(theme: dict) -> Image.Image:
    """无纹理时卡片的底色（玻璃盖在页面底色上）。"""
    bg = Image.new('RGBA', (64, 64), tuple(theme['page_bg']) + (255,))
    if 'glass' in theme:
        glass = Image.new('RGBA', (64, 64), tuple(theme['glass']) + (int(theme['glass_a'] * 255),))
        return Image.alpha_composite(bg, glass).convert('RGB')
    return bg.convert('RGB')


def zone_lum(img: Image.Image, zone) -> tuple[float, float]:
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
    return min(
        contrast(text_rgb, _lum_to_rgb(hi)),
        contrast(text_rgb, _lum_to_rgb(lo)),
    )


def main() -> int:
    if not os.path.isdir(TEX):
        print(f'找不到纹理目录 {TEX}，先跑 gen-tex.py')
        return 2

    failures: list[str] = []
    print(f'{"主题":<13}{"纹理":<6}{"区域":<7}{"文字":<6}{"基线":>7}{"带纹理":>8}{"劣化":>7}  结论')
    print('─' * 68)

    for key, t in THEMES.items():
        for kind in ('card', 'hero', 'amb'):
            path = os.path.join(TEX, f'{kind}-{key}.webp')
            if not os.path.exists(path):
                failures.append(f'{kind}-{key}: 文件缺失')
                continue
            tex = Image.open(path).convert('RGBA')
            comp = render_card(t, tex, APPLY_OPACITY[kind])
            base_img = render_baseline(t)

            for zone_name, zone, is_text_zone in (
                ('文字区', TEXT_ZONE, True),
                ('图案区', PATTERN_ZONE, False),
            ):
                for text_name, text_rgb in (
                    ('--t1', t['text']), ('--t2', t['text2']), ('--t3', t['text3'])
                ):
                    base = worst_contrast(text_rgb, base_img, zone)
                    ratio = worst_contrast(text_rgb, comp, zone)
                    drop = 1.0 - (ratio / base) if base > 0 else 0.0

                    ok = True
                    if is_text_zone:
                        if text_name == '--t1' and ratio < 4.5:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: {ratio:.2f} < 4.5（正文绝对下限）')
                        if drop > 0.35:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: '
                                f'劣化 {drop * 100:.0f}% > 35%（基线 {base:.2f} → {ratio:.2f}）')
                    else:
                        floor = 3.0 if text_name != '--t3' else 2.0
                        if ratio < floor:
                            ok = False
                            failures.append(
                                f'{kind}-{key} {zone_name} {text_name}: {ratio:.2f} < {floor}')

                    print(
                        f'{key:<13}{kind:<6}{zone_name:<7}{text_name:<6}'
                        f'{base:>6.2f}:{ratio:>7.2f}:{drop * 100:>5.0f}%  {"通过" if ok else "不通过"}')

    print('─' * 68)
    if failures:
        print(f'✗ {len(failures)} 项未通过：')
        for f in failures:
            print(f'  · {f}')
        return 1
    print('✓ 全部主题通过')
    print('  · 正文色 --t1 在文字区 ≥ 4.5:1')
    print('  · 所有文字色相对无纹理基线的劣化 ≤ 35%')
    print('  · 图案区 --t1/--t2 ≥ 3.0:1，--t3 ≥ 2.0:1')
    return 0


if __name__ == '__main__':
    sys.exit(main())
