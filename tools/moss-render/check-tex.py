#!/usr/bin/env python3
"""
MOSS AI App · 纹理可读性校验与浓度求解。

回答一个具体问题：**把纹理铺到卡片上以后，卡片里的字还读得清吗？**

## 一、真实的图层模型（这一点决定结论对不对）

卡片是三层结构，纹理是**中间那层**：

    ┌─ 文字 ────────────────────────┐
    │  纹理层  <image>，opacity = op │  ← 在卡片内容之下
    │  卡片底  玻璃渐变 / 不透明 s1   │
    │  页面底  页面背景              │
    └───────────────────────────────┘

因为纹理用 <image> 组件实现（uni-app App 端对 CSS 里引本地静态资源有限制，
而 <image> 的 src="/static/..." 是本工程已验证的路径），
它是卡片的**子元素**，必然渲染在卡片自身背景**之上**、内容**之下**。

第一版校验脚本假设的是"玻璃盖在纹理上"，与实现相反，
于是算出来的结论是错的。这次把模型和实现对齐，并且反过来**求解允许的最大浓度**。

## 二、两类卡片都要查

| 卡片 | 背景 | 谁更危险 |
|---|---|---|
| 不透明卡 | `background: var(--s1)`（笔记/资讯/日历） | 纹理直接压在上面，最危险 |
| 玻璃卡 | s1 @80% 叠在页面底上（我的/专注） | 底色更深，纹理相对更刺眼 |

两种都查，取更差的作为该主题的结论。

## 三、判据

  1. **绝对下限**：正文色 --t1 在文字区仍需 ≥ 4.5:1（正文 14–15px，不是大字）。
  2. **相对劣化**：任何文字色加上纹理后，对比度相对"无纹理基线"下降不超过 35%。
     用相对判据而不是绝对阈值，是因为 --t3（元信息色）在无纹理时本来就只有
     3.4–3.7:1——那是项目既有的设计取舍（弱化信息），不是纹理引入的缺陷。
     用绝对阈值会把既有问题误判成新缺陷。
  3. **图案区**：不放正文，但 --t1/--t2 可能被用到（卡片角上的计数、状态标签），
     要求 ≥ 3.0:1；--t3 允许 ≥ 2.0:1。

文字区 = 卡片左上 62% × 72%（标题 / 摘要 / 按钮所在处）。
图案区 = 右下密集纹理区。

## 四、输出

对每个（角色 × 主题 × 卡片类型）**二分求解允许的最大 opacity**，
再汇总出 tokens.scss 里该填的 --tex-card-op / --tex-hero-op / --tex-amb-op。

用法：
  python3 tools/moss-render/check-tex.py
退出码非 0 表示求解出的浓度低于当前 tokens.scss 里的值。
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
# page_bg : 页面底色
# s1      : 卡片底色（不透明卡的背景；玻璃卡用它 @glass_a 叠在 page_bg 上）
# glass_a : 玻璃卡的不透明度
# text*   : --t1 / --t2 / --t3
THEMES = {
    'moss-dark': {
        'page_bg': (0x05, 0x08, 0x06),
        's1': (0x0b, 0x12, 0x10), 'glass_a': 0.80,
        'text': (0xe6, 0xf3, 0xec),
        'text2': (0x8f, 0xa7, 0x9b),
        'text3': (0x5b, 0x6f, 0x66),
    },
    'moss-light': {
        'page_bg': (0xf2, 0xf7, 0xf4),
        's1': (0xff, 0xff, 0xff), 'glass_a': 0.84,
        'text': (0x0b, 0x15, 0x12),
        'text2': (0x4a, 0x5d, 0x55),
        'text3': (0x7b, 0x8d, 0x85),
    },
    '550w-dark': {
        'page_bg': (0x0a, 0x05, 0x04),
        's1': (0x12, 0x09, 0x08), 'glass_a': 0.80,
        'text': (0xf2, 0xea, 0xe4),
        'text2': (0xb4, 0x9a, 0x92),
        'text3': (0x7a, 0x60, 0x58),
    },
    '550w-light': {
        'page_bg': (0xf7, 0xf1, 0xe7),
        's1': (0xff, 0xfd, 0xf9), 'glass_a': 0.84,
        'text': (0x1a, 0x0f, 0x0c),
        'text2': (0x6b, 0x53, 0x4c),
        'text3': (0x95, 0x80, 0x6f),
    },
}

# 卡片文字区：左上 62% × 72%
TEXT_ZONE = (0.00, 0.62, 0.00, 0.72)
# 卡片图案区：右下密集纹理
PATTERN_ZONE = (0.62, 1.00, 0.45, 1.00)

# 相对劣化上限（正文区）
MAX_DROP = 0.35

# tokens.scss 里当前使用的浓度（用于比对）
CURRENT_OP = {
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


def card_base(theme: dict, kind: str) -> Image.Image:
    """无纹理时卡片的底色。"""
    if kind == 'opaque':
        # 不透明卡：background: var(--s1)
        return Image.new('RGB', (64, 64), tuple(theme['s1']))
    # 玻璃卡：s1 @glass_a 叠在页面底色上
    bg = Image.new('RGBA', (64, 64), tuple(theme['page_bg']) + (255,))
    glass = Image.new('RGBA', (64, 64), tuple(theme['s1']) + (int(theme['glass_a'] * 255),))
    return Image.alpha_composite(bg, glass).convert('RGB')


def card_with_tex(theme: dict, kind: str, tex: Image.Image, op: float) -> Image.Image:
    """纹理按 op 叠在卡片底色之上（与 <image> 子元素的真实渲染顺序一致）。"""
    t = tex.copy()
    t.putalpha(tex.split()[3].point(lambda v: int(v * op)))
    base = card_base(theme, kind).resize(tex.size, Image.LANCZOS)
    return Image.alpha_composite(base.convert('RGBA'), t).convert('RGB')


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


def check(theme: dict, kind: str, tex: Image.Image, op: float) -> list[str]:
    """返回该配置下的问题列表（空 = 通过）。"""
    problems: list[str] = []
    base_img = card_base(theme, kind)
    comp = card_with_tex(theme, kind, tex, op)

    for zone_name, zone, is_text_zone in (
        ('文字区', TEXT_ZONE, True),
        ('图案区', PATTERN_ZONE, False),
    ):
        for text_name, text_rgb in (
            ('--t1', theme['text']), ('--t2', theme['text2']), ('--t3', theme['text3'])
        ):
            base = worst_contrast(text_rgb, base_img, zone)
            ratio = worst_contrast(text_rgb, comp, zone)
            drop = 1.0 - (ratio / base) if base > 0 else 0.0

            if is_text_zone:
                if text_name == '--t1' and ratio < 4.5:
                    problems.append(f'{zone_name} {text_name}: {ratio:.2f} < 4.5')
                if drop > MAX_DROP:
                    problems.append(f'{zone_name} {text_name}: 劣化 {drop * 100:.0f}% > {MAX_DROP * 100:.0f}%')
            else:
                floor = 3.0 if text_name != '--t3' else 2.0
                if ratio < floor:
                    problems.append(f'{zone_name} {text_name}: {ratio:.2f} < {floor}')
    return problems


def solve_max_op(theme: dict, kind: str, tex: Image.Image, hi: float = 1.0) -> float:
    """二分求解满足全部判据的最大 opacity。"""
    if check(theme, kind, tex, hi):
        return 0.0
    lo = 0.0
    for _ in range(18):
        mid = (lo + hi) / 2
        if check(theme, kind, tex, mid):
            hi = mid
        else:
            lo = mid
    return lo


def main() -> int:
    if not os.path.isdir(TEX):
        print(f'找不到纹理目录 {TEX}，先跑 gen-tex.py')
        return 2

    print(f'求解各主题允许的最大纹理浓度（判据：--t1 文字区 ≥ 4.5:1，劣化 ≤ {MAX_DROP * 100:.0f}%）')
    print()
    print(f'{"主题":<13}{"角色":<6}{"不透明卡":>10}{"玻璃卡":>10}{"建议值":>9}')
    print('─' * 52)

    suggested: dict[str, dict[str, float]] = {}
    failures: list[str] = []

    for key, t in THEMES.items():
        for role in ('card', 'hero', 'amb'):
            path = os.path.join(TEX, f'{role}-{key}.webp')
            if not os.path.exists(path):
                failures.append(f'{role}-{key}: 文件缺失')
                continue
            tex = Image.open(path).convert('RGBA')
            op_opaque = solve_max_op(t, 'opaque', tex)
            op_glass = solve_max_op(t, 'glass', tex)
            # 取两种卡片里更严的那个
            worst = min(op_opaque, op_glass)
            suggested.setdefault(role, {})[key] = worst

            cur = CURRENT_OP[role]
            flag = '' if cur <= worst + 1e-9 else '  ⚠ 当前值过高'
            if cur > worst + 1e-9:
                failures.append(
                    f'{role}-{key}: 当前 op={cur} 超过允许上限 {worst:.2f}')
            print(f'{key:<13}{role:<6}{op_opaque:>10.2f}{op_glass:>10.2f}{worst:>8.2f} {flag}')

    print('─' * 52)
    print('建议写入 tokens.scss 的浓度（取同角色各主题的最小值，保证换肤不越界）：')
    for role in ('card', 'hero', 'amb'):
        vals = suggested.get(role, {})
        if not vals:
            continue
        safe = min(vals.values())
        print(f'  --tex-{role}-op: {safe:.2f}   （各主题上限 ' +
              ', '.join(f'{k.replace("moss-", "").replace("550w-", "")}: {v:.2f}'
                        for k, v in vals.items()) + '）')

    print()
    if failures:
        print(f'✗ {len(failures)} 项未通过：')
        for f in failures:
            print(f'  · {f}')
        return 1
    print('✓ 全部主题通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
