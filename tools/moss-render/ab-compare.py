#!/usr/bin/env python3
"""
对照实验：比例失配时，两种策略各会得到多大的图形？

  A = 裁切优先（MIN_KEEP≈0）：按锚区比例从主图裁一块，铺满锚区
  B = 容纳优先（当前 MIN_KEEP=0.55）：图形完整保留，缩进锚区

两种策略各有代价：
  A 图形满锚区（看得见），但可能被裁成"几根断线"（语义碎）
  B 语义完整，但图形可能小到看不见

这个脚本离线模拟两者，输出最终图形在 **CSS 像素** 下的尺寸，
以及"非零像素占比"（另一个可见度代理指标）。
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from card_specs import CARD_SPECS  # noqa: E402

# 模块文件名带连字符（tex-build.py），不能直接 import —— 用 importlib 按路径加载。
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location('tex_build', os.path.join(HERE, 'tex-build.py'))
TB = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(TB)

SCALE = TB.SCALE


def measure(im: Image.Image) -> tuple[int, int, float]:
    a = np.asarray(im)[..., 3]
    ys, xs = np.nonzero(a > 10)
    if len(xs) == 0:
        return 0, 0, 0.0
    bw = int(xs.max() - xs.min() + 1)
    bh = int(ys.max() - ys.min() + 1)
    return bw, bh, float((a > 10).sum() / a.size * 100)


def simulate(graphic: Image.Image, out_w: int, out_h: int,
             anchor: tuple[float, float, float, float],
             focus: tuple[float, float] | None,
             mode: str) -> Image.Image:
    """模拟 place() 的两种策略，返回最终画布。"""
    canvas = Image.new('RGBA', (out_w, out_h), (0, 0, 0, 0))
    x0, y0, x1, y1 = anchor
    tx0, ty0 = int(round(x0 * out_w)), int(round(y0 * out_h))
    tx1, ty1 = int(round(x1 * out_w)), int(round(y1 * out_h))
    tw, th = max(1, tx1 - tx0), max(1, ty1 - ty0)

    g = graphic
    target_ratio = tw / th
    src_ratio = g.width / g.height

    if mode == 'crop':
        cx0, cy0 = TB._alpha_centroid(g)
        if focus:
            cx0 = 0.75 * cx0 + 0.25 * focus[0]
            cy0 = 0.75 * cy0 + 0.25 * focus[1]
        if src_ratio > target_ratio:
            nh = g.height
            nw = max(1, int(round(nh * target_ratio)))
            cx = int(round(cx0 * g.width - nw / 2))
            cx = max(0, min(cx, g.width - nw))
            g = g.crop((cx, 0, cx + nw, nh))
        else:
            nw = g.width
            nh = max(1, int(round(nw / target_ratio)))
            cy = int(round(cy0 * g.height - nh / 2))
            cy = max(0, min(cy, g.height - nh))
            g = g.crop((0, cy, nw, cy + nh))
    else:  # contain
        pass

    scale = min(tw / g.width, th / g.height)
    nw, nh = max(1, int(round(g.width * scale))), max(1, int(round(g.height * scale)))
    g = g.resize((nw, nh), Image.LANCZOS)
    ox = tx0 + (tw - nw) // 2
    oy = ty0 + (th - nh) // 2
    canvas.alpha_composite(g, (max(0, ox), max(0, oy)))
    return canvas


def main() -> None:
    skin = 'moss-dark'
    theme = TB.THEMES[skin]
    print(f'{"key":<11}{"锚区CSS":>12} | {"A裁切 CSS":>13}{"nz%":>7} | '
          f'{"B容纳 CSS":>13}{"nz%":>7} | 胜者')
    print('─' * 84)
    for spec in CARD_SPECS:
        anchor = spec.get('anchor')
        if not anchor:
            continue
        path = TB.find_raw(spec['key'], skin)
        if path is None:
            continue
        raw = TB.remove_watermark(Image.open(path))
        graphic = TB.trim(TB.extract_graphic(raw, theme))

        out_w = int(spec['w'] * SCALE)
        out_h = int(spec.get('h', 0) * SCALE)
        focus = spec.get('focus')

        bw_a, bh_a, nz_a = measure(simulate(graphic, out_w, out_h, anchor, focus, 'crop'))
        bw_b, bh_b, nz_b = measure(simulate(graphic, out_w, out_h, anchor, focus, 'contain'))

        a_css = f'{bw_a/SCALE:.0f}×{bh_a/SCALE:.0f}'
        b_css = f'{bw_b/SCALE:.0f}×{bh_b/SCALE:.0f}'
        # 判据：CSS 短边 ≥ 25px 且 nz ≥ 0.5% 视为"看得见"
        def ok(bw, bh, nz):
            return min(bw, bh) / SCALE >= 25 and nz >= 0.5
        if ok(bw_a, bh_a, nz_a) and not ok(bw_b, bh_b, nz_b):
            win = 'A 裁切'
        elif ok(bw_b, bh_b, nz_b) and not ok(bw_a, bh_a, nz_a):
            win = 'B 容纳'
        elif ok(bw_a, bh_a, nz_a) and ok(bw_b, bh_b, nz_b):
            win = '都可'
        else:
            win = '都不行'
        print(f'{spec["key"]:<11}{f"{spec["w"]}×{spec["h"]}":>12} | '
              f'{a_css:>13}{nz_a:>7.2f} | {b_css:>13}{nz_b:>7.2f} | {win}')


if __name__ == '__main__':
    main()
