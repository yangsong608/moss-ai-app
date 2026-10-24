#!/usr/bin/env python3
"""
纹理可见性量化 —— 按页面实测尺寸把 tex 合成到卡片底色，量锚区对比度。

回答一个问题：**这张卡的图案，用户到底看不看得见？**

三个指标：
  cover    锚区里 alpha>0.08 的像素占比（图案实体覆盖多少）
  rms      合成后锚区的亮度 RMS 偏差（相对纯底色）—— 肉眼可见性
  gpx      图形 contain 进锚区后的 CSS 像素尺寸（太小就是看不见的直接原因）

用法：python3 vis-check.py [page ...]
"""
from __future__ import annotations

import os
import re
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))
sys.path.insert(0, HERE)

import card_specs  # noqa: E402

# 页面实测（slot.mjs，手机 390×844；notes 附平板值）→ key: (实测w, 实测h)
MEASURED = {
    'today': {
        'hero': (358, 132), 'stat': (114, 51), 'quick': (358, 75),
        'calpage': (358, 781), 'flipcard': (328, 207), 'caldate': (56, 57),
    },
    'notes': {'note': (358, 156), 'reader': (520, 534), 'nbcol': (176, 260)},
    'news': {'news': (358, 169)},
    'mine': {'console': (358, 200), 'sync': (358, 68), 'local': (358, 117), 'ovcard': (390, 293)},
    'index': {'dev': (358, 187), 'ondev': (358, 91), 'empty': (358, 210)},
    'sessions': {'srow': (334, 67)},
}

# anchor 从规格表读真值，不在这里抄一份 ——
# 抄的副本已经和 card_specs.py 漂移过一轮（quick / caldate / news / sync / dev
# 都是旧值），照着副本算出来的数字全是错的。
ANCHOR = {
    s['key']: s.get('anchor')
    for s in card_specs.CARD_SPECS
}

# tokens.scss 的浓度（暗色 moss）。
# 同样从 tokens.scss 解析真值 —— 手抄的常量在令牌调整后就是"校验假的世界"。
_TOKENS = os.path.normpath(os.path.join(HERE, '../../src/styles/tokens.scss'))
_OP: dict[str, float] = {}
with open(_TOKENS, encoding='utf-8') as _fh:
    for _line in _fh:
        _m = re.search(r'--tex-([a-z0-9]+)-op:\s*([0-9.]+)\s*;', _line)
        if _m:
            _OP.setdefault(_m.group(1), float(_m.group(2)))

OP = _OP

# 卡片底色（取 --bg-grad-1，深/浅各一套）
BG = {'dark': (13, 21, 18), 'light': (255, 255, 255)}


def lum(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * .2126 + rgb[..., 1] * .7152 + rgb[..., 2] * .0722


def analyse(key: str, page: str, meas: tuple[int, int]) -> dict:
    cw, ch = meas
    im = Image.open(os.path.join(TEX, f'{key}-moss-dark.webp')).convert('RGBA')
    iw, ih = im.size
    a = np.asarray(im).astype(np.float32)

    # scaleToFill：把图拉到实测卡尺寸
    sx, sy = cw / iw, ch / ih
    dw, dh = max(1, round(iw * sx)), max(1, round(ih * sy))
    stretched = Image.new('RGBA', (dw, dh), (0, 0, 0, 0))
    stretched.alpha_composite(im.resize((dw, dh), Image.LANCZOS))
    sa = np.asarray(stretched).astype(np.float32)

    anc = ANCHOR.get(key)
    if anc is None:
        x0, y0, x1, y1 = 0, 0, 1, 1
    else:
        x0, y0, x1, y1 = anc
    ax0, ay0 = int(x0 * dw), int(y0 * dh)
    ax1, ay1 = max(ax0 + 1, int(x1 * dw)), max(ay0 + 1, int(y1 * dh))
    reg = sa[ay0:ay1, ax0:ax1]

    cover = float((reg[..., 3] > 20).mean())

    # 合成到卡片底色（按浓度）
    op = OP.get(key, 0.4)
    for mode, bg in BG.items():
        base = np.zeros_like(reg[..., :3])
        base[:] = bg
        alpha = (reg[..., 3:4] / 255.0) * op
        out = reg[..., :3] * alpha + base * (1 - alpha)
        rms = float(np.sqrt(((lum(out) - lum(base)) ** 2).mean()))
        if mode == 'dark':
            rms_dark = rms

    # 图形 contain 进锚区的 CSS 尺寸（用原图 alpha bbox）
    ys, xs = np.where(a[..., 3] > 20)
    if len(xs):
        gw, gh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    else:
        gw = gh = 0
    tw, th = ax1 - ax0, ay1 - ay0
    sc = min(tw / gw, th / gh) if gw and gh else 0
    gcss = (round(gw * sc), round(gh * sc))

    return dict(cover=cover, rms=rms_dark, gpx=gcss, anchor=(tw, th),
                stretch=round(sy / sx, 3), dpr2=round(iw / cw, 2))


def main() -> int:
    pages = sys.argv[1:] or list(MEASURED)
    print(f'{"页":<10}{"纹理":<12}{"锚区CSS":>10}{"图形CSS":>10}{"覆盖率":>8}{"RMS暗":>8}{"垂直拉伸":>9}{"原生/显示":>10}')
    print('─' * 78)
    for page in pages:
        print(f'【{page}】')
        for key, meas in MEASURED[page].items():
            r = analyse(key, page, meas)
            flag = ''
            if r['cover'] < 0.02 or min(r['gpx']) < 8:
                flag = '  ← 图案几乎不可见'
            elif r['rms'] < 1.2:
                flag = '  ← 对比度偏低'
            print(f'{"":<10}{key:<12}{str(r["anchor"]):>10}{str(r["gpx"]):>10}'
                  f'{r["cover"]*100:>7.1f}%{r["rms"]:>8.2f}{r["stretch"]:>9}{r["dpr2"]:>10}{flag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
