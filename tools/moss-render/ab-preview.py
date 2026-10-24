#!/usr/bin/env python3
"""
生成 A/B 两套纹理并排对比图，用来肉眼判断"裁切"会不会把图形裁碎。

  A = 裁切优先：按锚区比例从主图裁一块，铺满锚区（可见度高）
  B = 容纳优先：图形完整保留，缩进锚区（语义完整但可能小到看不见）

每行一张卡：左 A 右 B，叠在卡片底色上，按 CSS 像素等比放大。
"""

from __future__ import annotations

import importlib.util
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from card_specs import CARD_SPECS  # noqa: E402

_spec = importlib.util.spec_from_file_location('tex_build', os.path.join(HERE, 'tex-build.py'))
TB = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(TB)

SCALE = TB.SCALE
ZOOM = 2.0
BG = (11, 18, 16)          # 深色卡片底
PAD = 10
LABEL_H = 22


def simulate(graphic, out_w, out_h, anchor, focus, mode):
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

    scale = min(tw / g.width, th / g.height)
    nw, nh = max(1, int(round(g.width * scale))), max(1, int(round(g.height * scale)))
    g = g.resize((nw, nh), Image.LANCZOS)
    canvas.alpha_composite(g, (tx0 + (tw - nw) // 2, ty0 + (th - nh) // 2))
    return canvas


def main() -> None:
    skin = 'moss-dark'
    theme = TB.THEMES[skin]
    only = sys.argv[1].split(',') if len(sys.argv) > 1 else None

    rows = []
    for spec in CARD_SPECS:
        anchor = spec.get('anchor')
        if not anchor:
            continue
        if only and spec['key'] not in only:
            continue
        path = TB.find_raw(spec['key'], skin)
        if path is None:
            continue
        raw = TB.remove_watermark(Image.open(path))
        graphic = TB.trim(TB.extract_graphic(raw, theme))
        out_w = int(spec['w'] * SCALE)
        out_h = int(spec.get('h', 0) * SCALE)
        focus = spec.get('focus')
        a = simulate(graphic, out_w, out_h, anchor, focus, 'crop')
        b = simulate(graphic, out_w, out_h, anchor, focus, 'contain')
        rows.append((spec['key'], a, b, out_w, out_h))

    if not rows:
        print('没有可比的卡')
        return

    # 每行：标签 + A + B
    cw = max(r[3] for r in rows)
    row_h = max(r[4] for r in rows)
    total_w = 150 + cw * 2 + PAD * 4
    total_h = len(rows) * (row_h + LABEL_H + PAD) + PAD
    sheet = Image.new('RGB', (total_w, total_h), (6, 9, 8))
    draw = ImageDraw.Draw(sheet)

    y = PAD
    for key, a, b, ow, oh in rows:
        draw.text((PAD, y + 6), key, fill=(150, 200, 175))
        for i, (im, tag) in enumerate(((a, 'A 裁切'), (b, 'B 容纳'))):
            bg = Image.new('RGBA', im.size, BG + (255,))
            comp = Image.alpha_composite(bg, im).convert('RGB')
            comp = comp.resize((int(ow * ZOOM), int(oh * ZOOM)), Image.LANCZOS)
            x = 150 + PAD + i * (cw + PAD)
            sheet.paste(comp, (x, y))
            draw.text((x + 4, y + int(oh * ZOOM) + 3), tag, fill=(120, 150, 135))
        y += int(oh * ZOOM) + LABEL_H + PAD

    out = os.path.join(HERE, 'ab-preview.png')
    sheet.save(out)
    print(f'→ {out}  {sheet.width}×{sheet.height}')


if __name__ == '__main__':
    main()
