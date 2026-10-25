#!/usr/bin/env python3
"""
量一下每张纹理里"图形本体"的实际像素尺寸与占比。

背景：place() 加了 MIN_KEEP 比例失配保护后，比例悬殊的卡会改成
完整容纳，图形就变小了。这里量出来确认"还看得见"。

输出：每个 key 的
  bbox   图形包围盒（输出像素）
  ratio  图形尺寸 / 锚区尺寸
  nz     非零 alpha 像素占整幅比例
  peak   alpha 峰值
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from card_specs import CARD_SPECS, PAGE_SPECS  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))
SCALE = 1.5

KEYS = ['news', 'console', 'quick', 'note', 'dev', 'sync', 'flipcard',
        'caldate', 'nbcol', 'modal', 'hero', 'stat', 'empty', 'ovcard',
        'agenda', 'timer', 'statbox', 'brand']

specs = {}
for s in list(CARD_SPECS) + list(PAGE_SPECS):
    specs[s['key']] = s

print(f'{"key":<10}{"图框":>12}{"锚区":>12}{"占锚区":>9}{"nz%":>8}{"peak":>7}')
print('─' * 60)
for k in KEYS:
    sp = specs.get(k)
    path = os.path.join(OUT, f'{k}-moss-dark.webp')
    if not os.path.exists(path):
        print(f'{k:<10}  (缺文件)')
        continue
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im)[..., 3]
    ys, xs = np.nonzero(a > 10)
    if len(xs) == 0:
        print(f'{k:<10}  (全透明)')
        continue
    bw = xs.max() - xs.min() + 1
    bh = ys.max() - ys.min() + 1
    nz = (a > 10).sum() / a.size * 100
    peak = a.max()
    anchor = sp.get('anchor') if sp else None
    if anchor:
        out_w, out_h = im.width, im.height
        tw = int(round((anchor[2] - anchor[0]) * out_w))
        th = int(round((anchor[3] - anchor[1]) * out_h))
        r = f'{bw / tw:.0%}×{bh / th:.0%}'
        aw = f'{tw}×{th}'
    else:
        r = '—'
        aw = '—'
    print(f'{k:<10}{f"{bw}×{bh}":>12}{aw:>12}{r:>9}{nz:>7.2f}%{peak:>7}')
