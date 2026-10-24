#!/usr/bin/env python3
"""量纹理在文字区里的实际 alpha —— 判断"图形是否真的压到字"的硬数据。

用法：python3 tools/moss-render/overlap-measure.py [key ...]
"""
from __future__ import annotations

import importlib.util
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '../..'))
TEX = os.path.join(ROOT, 'src/static/moss/tex')
sys.path.insert(0, HERE)

_spec = importlib.util.spec_from_file_location('ct', os.path.join(HERE, 'check-tex.py'))
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)

import card_specs  # noqa: E402

keys = sys.argv[1:] or [s['key'] for s in card_specs.CARD_SPECS]
for key in keys:
    spec = next((s for s in card_specs.CARD_SPECS if s['key'] == key), None)
    if spec is None:
        continue
    path = os.path.join(TEX, f'{key}-moss-dark.webp')
    if not os.path.exists(path):
        continue
    a = np.asarray(Image.open(path).convert('RGBA'))[..., 3]
    H, W = a.shape
    kind, tz, pz = ct._zones(spec)
    print(f'=== {key} 图 {W}x{H} anchor={spec.get("anchor")}')
    for name, z in tz:
        x0, y0 = int(z[0] * W), int(z[2] * H)
        x1, y1 = int(z[1] * W), int(z[3] * H)
        reg = a[y0:y1, x0:x1]
        if reg.size == 0:
            continue
        nz = reg > 10
        print(f'   {name:8s} 文字区 alpha max={reg.max():3d} '
              f'非零占比={nz.mean() * 100:5.1f}%')
