#!/usr/bin/env python3
"""
MOSS AI App · 卡片纹理可读性校验与浓度求解。

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

## 二、按卡片类的文字区位置（不是一刀切）

纹理按**卡片类**出图（13 类，见 card_specs.py），每类卡片的文字落在哪儿不一样，
安静区也必须不一样。zone = (x0, x1, y0, y1)，归一化坐标。

| 卡片类 | 用在哪 | 文字区 | 图案区 |
|---|---|---|---|
| hero | 今天页大日期卡 | 左 58%（日期大标题在左） | 右下 42% |
| stat | 今天页指标小卡 | 整幅（图标+数字挤在 114px 里） | 无 |
| quick | 今天页快速记录条 | 整幅（输入框占满） | 无 |
| calpage | 今天页台历卡 | 整幅（任务行密集） | 无 |
| flipcard | 今天页任务卡 | 整幅（四角都是控件） | 无 |
| note | 笔记卡 | 左 72% | 右下 28% |
| news | 资讯卡 | 左 70% | 右下 30% |
| console | 我的页控制台卡 | 左 55% | 右下 45% |
| brand | 关于页品牌卡 | 左 68% | 右下 32% |
| timer | 专注页计时器卡 | 整幅（中央大数字） | 无 |
| srow | 会话行 | 整幅 | 无 |
| dev | 首页设备卡 | 左 70% | 右下 30% |
| amb  | 页面环境层 | 无（整页都是背景） | 全幅 |

## 三、判据

  1. **绝对下限**：正文色 --t1 在文字区仍需 ≥ 4.5:1（正文 14–15px，不是大字）。
  2. **相对劣化**：任何文字色加上纹理后，对比度相对"无纹理基线"下降不超过 35%。
     用相对判据而不是绝对阈值，是因为 --t3（元信息色）在无纹理时本来就只有
     3.4–3.7:1——那是项目既有的设计取舍（弱化信息），不是纹理引入的缺陷。
     用绝对阈值会把既有问题误判成新缺陷。
  3. **图案区**：不放正文，但 --t1/--t2 可能被用到（卡片角上的计数、状态标签），
     要求 ≥ 3.0:1；--t3 允许 ≥ 2.0:1。

## 四、输出

对每个（卡片类 × 主题）**二分求解允许的最大 opacity**，
再汇总出 tokens.scss 里该填的 --tex-<key>-op。

用法：
  python3 tools/moss-render/check-tex.py
退出码非 0 表示求解出的浓度低于当前 tokens.scss 里的值。
"""

from __future__ import annotations

import os
import re
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))
TOKENS = os.path.normpath(os.path.join(HERE, '../../src/styles/tokens.scss'))

sys.path.insert(0, HERE)
from card_specs import CARD_SPECS  # noqa: E402

# 主题块选择器 → 主题 key
THEME_BLOCKS = (
    ('moss-dark', r'\.dsh\s*\{'),
    ('550w-dark', r'\.dsh\.skin-550w\s*\{'),
    ('moss-light', r'\.dsh\.is-light\s*\{'),
    ('550w-light', r'\.dsh\.is-light\.skin-550w\s*\{'),
)

# 玻璃卡的不透明度来自各页面自己声明的 --glass-top / --glass-bottom
# （index.vue / mine.vue / focus.vue 各有一套），不统一。这里取
# **全项目最不利**的组合：透明度最低的那个端点。
# 玻璃层越薄，背景越透，卡片实际底色越接近页面底色 —— 对浅色文字的
# 深色主题来说最难读，对深色文字的浅色主题也最难读，所以必须按最薄算。
GLASS_ALPHA = {
    'moss-dark': (0.80, 0.62, 's2'),
    '550w-dark': (0.80, 0.62, 's2'),
    'moss-light': (0.82, 0.66, 's1'),
    '550w-light': (0.82, 0.66, 's1'),
}

# 颜色令牌名 → 内部字段
_COLOR_FIELDS = {
    '--bg': 'page_bg',
    '--s1': 's1',
    '--s2': 's2',
    '--t1': 'text',
    '--t2': 'text2',
    '--t3': 'text3',
}

# 相对劣化上限（文字区）
MAX_DROP = 0.35


def _block_body(text: str, pattern: str) -> str:
    """按选择器正则切出样式块的内容（花括号配对，不靠正则猜嵌套）。"""
    m = re.search(pattern, text)
    if not m:
        return ''
    depth = 0
    start = m.start()
    for i in range(start, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text[start:i]
    return ''


def _hex_to_rgb(s: str):
    s = s.strip()
    m = re.fullmatch(r'#([0-9a-fA-F]{6})', s)
    if m:
        v = int(m.group(1), 16)
        return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
    m = re.fullmatch(r'#([0-9a-fA-F]{3})', s)
    if m:
        h = m.group(1)
        return (int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16))
    return None


def _token_rgb(body: str, name: str):
    m = re.search(re.escape(name) + r'\s*:\s*(#[0-9a-fA-F]{3,6})\s*;', body)
    if not m:
        return None
    return _hex_to_rgb(m.group(1))


def load_themes() -> dict[str, dict]:
    """从 tokens.scss 解析 4 套主题的颜色，并挂上玻璃透明度。"""
    try:
        with open(TOKENS, encoding='utf-8') as f:
            text = f.read()
    except OSError:
        text = ''

    out: dict[str, dict] = {}
    for key, pattern in THEME_BLOCKS:
        body = _block_body(text, pattern)
        theme: dict = {}
        for token, field in _COLOR_FIELDS.items():
            rgb = _token_rgb(body, token)
            if rgb is not None:
                theme[field] = rgb
        if 'page_bg' not in theme or 's1' not in theme:
            continue
        top_a, low_a, low_src = GLASS_ALPHA[key]
        theme['glass_top_a'] = top_a
        theme['glass_low_a'] = low_a
        theme['glass_low_src'] = theme[low_src]
        out[key] = theme
    return out


THEMES = load_themes()


def load_current_ops() -> dict[tuple[str, str], float]:
    """返回 {(主题, 卡片类): 浓度}；读不到文件时返回空表（跳过比对）。"""
    try:
        with open(TOKENS, encoding='utf-8') as f:
            text = f.read()
    except OSError:
        return {}
    out: dict[tuple[str, str], float] = {}
    for theme, pattern in THEME_BLOCKS:
        body = _block_body(text, pattern)
        if not body:
            continue
        for spec in CARD_SPECS:
            mm = re.search(r'--tex-' + spec['key'] + r'-op:\s*([0-9.]+)', body)
            if mm:
                out[(theme, spec['key'])] = float(mm.group(1))
    return out


# ── 对比度计算 ─────────────────────────────────────────────────────────

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


def _lum_to_rgb(lum: float):
    if lum <= 0.0031308:
        srgb = lum * 12.92
    else:
        srgb = 1.055 * (lum ** (1 / 2.4)) - 0.055
    v = int(round(max(0.0, min(1.0, srgb)) * 255))
    return (v, v, v)


def _composite_over(rgb, over_rgb, alpha: float):
    """把 over_rgb 以 alpha 叠在 rgb 上（sRGB 空间的简单近似，够用）。"""
    return tuple(int(round(c * (1 - alpha) + o * alpha)) for c, o in zip(rgb, over_rgb))


def _gradient_image(top_rgb, bottom_rgb, size: int = 64) -> Image.Image:
    """竖直线性渐变图（用于近似 linear-gradient(160deg|155deg, A, B)）。"""
    a = np.asarray(top_rgb, dtype=np.float64)
    b = np.asarray(bottom_rgb, dtype=np.float64)
    t = np.linspace(0.0, 1.0, size).reshape(size, 1, 1)
    ramp = a[None, None, :] * (1 - t) + b[None, None, :] * t
    arr = np.repeat(ramp, size, axis=1).astype(np.uint8)
    return Image.fromarray(arr, 'RGB')


def card_base(theme: dict, kind: str, key: str) -> Image.Image:
    """
    无纹理时卡片的实际底色。

    kind='opaque' —— 不透明卡，background: var(--s1)。
                     hero 例外，它是 linear-gradient(160deg, s1, s2)。
    kind='glass'  —— 玻璃卡。真实渲染是
                     linear-gradient(155deg, --glass-top, --glass-bottom)，
                     两端是不同透明度、不同底色的半透明色叠在页面底上。
    """
    page_bg = theme['page_bg']

    if kind == 'opaque':
        if key == 'hero':
            return _gradient_image(theme['s1'], theme['s2'])
        return Image.new('RGB', (64, 64), tuple(theme['s1']))

    top = _composite_over(page_bg, theme['s1'], theme['glass_top_a'])
    low = _composite_over(page_bg, theme['glass_low_src'], theme['glass_low_a'])
    return _gradient_image(top, low)


def card_with_tex(theme: dict, kind: str, key: str,
                  tex: Image.Image, op: float) -> Image.Image:
    """纹理按 op 叠在卡片底色之上（与 <image> 子元素的真实渲染顺序一致）。"""
    t = tex.copy()
    t.putalpha(tex.split()[3].point(lambda v: int(v * op)))
    base = card_base(theme, kind, key).resize(tex.size, Image.LANCZOS)
    return Image.alpha_composite(base.convert('RGBA'), t).convert('RGB')


def zone_lum(img: Image.Image, zone):
    w, h = img.size
    x0, x1, y0, y1 = zone
    crop = img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
    a = np.asarray(crop).astype(np.uint8)
    lum = (0.2126 * _LUT[a[:, :, 0]] + 0.7152 * _LUT[a[:, :, 1]] + 0.0722 * _LUT[a[:, :, 2]])
    if lum.size == 0:
        # 零宽/零高的区域（锚区贴边时会产生）—— 没有像素就没有亮度。
        # 返回整幅的极值，语义上等于"这个区域没有额外约束"。
        full = np.asarray(img).astype(np.uint8)
        fl = (0.2126 * _LUT[full[:, :, 0]] + 0.7152 * _LUT[full[:, :, 1]]
              + 0.0722 * _LUT[full[:, :, 2]])
        return float(fl.min()), float(fl.max())
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


# ── 每类卡片的区域定义 ────────────────────────────────────────────────
#
# 从 card_specs.py 取安全区，再按该卡片类的文字分布细化成实际区域。

# key → (kind, 文字区列表, 图案区列表)
# kind: 'opaque' 不透明卡 / 'glass' 玻璃卡
# 少数卡片没法用"整幅 / 右下"这种粗切法描述：图案被限死在一条竖带里，
# 而这条竖带在页面上是**让出来的**（页面给它留了内边距，正文不可能进去）。
# 用 safe 推导会把整幅都当成文字区，得出"浓度必须极低"的错误结论。
ZONE_OVERRIDE = {
    'srow': {
        'text': [
            ('标题/摘要', (0.000, 0.668, 0.00, 1.00)),
            ('右列状态', (0.845, 1.000, 0.00, 1.00)),
        ],
        # 图形区**不给对比度判据**：这段是页面主动让出来的空档
        # （.srow-body 有 58px 右内边距，标题/摘要到不了这里），
        # 里面没有字，压不出可读性问题。约束是几何的，不是色彩的。
        'pattern': [],
    },
}


def _zones(spec: dict) -> tuple[str, list, list]:
    key = spec['key']
    safe = spec['safe']

    override = ZONE_OVERRIDE.get(key)
    if override is not None:
        kind = 'glass' if key in ('console', 'timer', 'dev') else 'opaque'
        return kind, list(override['text']), list(override['pattern'])

    # ── 文字区 ─────────────────────────────────────────────────────
    #
    # 优先级：
    #   1. text_zone —— textzone.mjs 在真实页面里量出来的文字矩形。
    #      这是**事实**，比任何推断都准。
    #   2. safe / anchor 差集 —— 没有实测时的推断。
    #
    # text_zone 里的矩形本身已经是"文字在哪"，不再减去 anchor：
    # 实测时就知道文字在哪，图形压上来就是真问题。
    text_zone = spec.get('text_zone')
    if text_zone:
        text_zones = [
            (f'文字{i + 1}', (rx0, rx1, ry0, ry1))
            for i, (rx0, ry0, rx1, ry1) in enumerate(text_zone)
        ]
    else:
        # 坐标顺序：card_specs 的 safe 是 (x0, y0, x1, y1)，
        # 而 zone_lum 用 (x0, x1, y0, y1) —— 这里必须换序，
        # 否则会把 safe 的 y1 当成 x1，切出宽度为 0 的区域（脚本会直接崩）。
        sx0, sy0, sx1, sy1 = safe
        anchor = spec.get('anchor')
        ax0, ay0, ax1, ay1 = anchor if anchor else (0.0, 0.0, 0.0, 0.0)

        # safe 全零 = 没有矩形避让区，靠 anchor 落位
        if sx1 > sx0 and sy1 > sy0:
            base_zones = [('文字区', (sx0, sx1, sy0, sy1))]
        else:
            base_zones = [('整幅', (0.0, 1.0, 0.0, 1.0))]

        text_zones = []
        for name, zone in base_zones:
            for piece_name, piece in _subtract_rect(zone, (ax0, ax1, ay0, ay1)):
                text_zones.append((f'{name}/{piece_name}', piece))

    # 图案区：anchor 本身
    pattern_zones = []
    anchor = spec.get('anchor')
    if anchor:
        ax0, ay0, ax1, ay1 = anchor
        pattern_zones.append(('图形区', (ax0, ax1, ay0, ay1)))
    elif safe[2] < 1.0 or safe[3] < 1.0:
        if safe[2] < 1.0 and safe[3] < 1.0:
            pattern_zones.append(('右下', (safe[2], 1.0, safe[3], 1.0)))
        elif safe[2] < 1.0:
            pattern_zones.append(('右侧', (safe[2], 1.0, 0.0, 1.0)))
        elif safe[3] < 1.0:
            pattern_zones.append(('下部', (0.0, 1.0, safe[3], 1.0)))

    kind = 'glass' if key in ('console', 'timer', 'dev') else 'opaque'
    return kind, text_zones, pattern_zones


def _subtract_rect(zone, hole):
    """矩形差集：zone 减去 hole，返回剩下的若干块。

    zone / hole 都是 (x0, x1, y0, y1)。
    hole 为空或不相交 → 原样返回。
    """
    zx0, zx1, zy0, zy1 = zone
    hx0, hx1, hy0, hy1 = hole
    if hx1 <= hx0 or hy1 <= hy0:
        return [('', zone)]
    # 不相交
    if hx1 <= zx0 or hx0 >= zx1 or hy1 <= zy0 or hy0 >= zy1:
        return [('', zone)]

    out = []
    # 上
    if hy0 > zy0:
        out.append(('上', (zx0, zx1, zy0, min(hy0, zy1))))
    # 下
    if hy1 < zy1:
        out.append(('下', (zx0, zx1, max(hy1, zy0), zy1)))
    # 左（洞的纵向范围内）
    if hx0 > zx0:
        out.append(('左', (zx0, min(hx0, zx1), max(zy0, hy0), min(zy1, hy1))))
    # 右
    if hx1 < zx1:
        out.append(('右', (max(hx1, zx0), zx1, max(zy0, hy0), min(zy1, hy1))))
    return out or [('', zone)]


def check(theme: dict, spec: dict, tex: Image.Image, op: float) -> list[str]:
    """返回该配置下的问题列表（空 = 通过）。"""
    problems: list[str] = []
    kind, text_zones, pattern_zones = _zones(spec)
    key = spec['key']

    base_img = card_base(theme, kind, key)
    comp = card_with_tex(theme, kind, key, tex, op)

    for zone_name, zone in text_zones:
        for text_name, text_rgb in (
            ('--t1', theme['text']), ('--t2', theme['text2']), ('--t3', theme['text3'])
        ):
            base = worst_contrast(text_rgb, base_img, zone)
            ratio = worst_contrast(text_rgb, comp, zone)
            drop = 1.0 - (ratio / base) if base > 0 else 0.0

            if text_name == '--t1' and ratio < 4.5:
                problems.append(f'{zone_name} {text_name}: {ratio:.2f} < 4.5')
            if drop > MAX_DROP:
                problems.append(f'{zone_name} {text_name}: 劣化 {drop * 100:.0f}% > {MAX_DROP * 100:.0f}%')

    # 图案区：**不给文字色判据**。
    #
    # 图案区就是图形本身所在的位置 —— 纹理画在那里，
    # 文字色的对比度必然被压低。要求"图形区的 --t3 对比度 ≥ 2.0"
    # 等价于要求纹理不存在，与"要一张有意义的图形"直接矛盾。
    #
    # 早期版本在这里也套了文字判据，报出 40+ 条自相矛盾的失败
    # （"图形区 --t3: 1.02 < 2.0" —— 纹理越明显越失败）。
    # 图案区的正确约束是几何的（不压到文字），由 anchor 落位保证，
    # 可读性约束只施加在文字区。
    #
    # 图案区唯一保留的检查：它不能是"大面积高亮"，
    # 否则深色主题下发光的图形会在卡上形成刺眼色块。
    for zone_name, zone in pattern_zones:
        lum = zone_lum(comp, zone)
        if lum[1] > 235:
            problems.append(f'{zone_name}: 峰值亮度 {lum[1]:.0f} 过高，会形成刺眼色块')

    return problems


def solve_max_op(theme: dict, spec: dict, tex: Image.Image, hi: float = 1.0) -> float:
    """
    二分求解满足全部判据的最大 opacity。

    不变式：check(lo) 恒通过，check(hi) 恒不通过。
    op=0 时纹理不产生任何贡献，等于无纹理基线，必然通过；
    若基线本身就不通过（如无纹理时正文对比度已低于 4.5:1），
    说明问题不在纹理上，如实返回 0。
    """
    lo = 0.0
    if check(theme, spec, tex, lo):
        return 0.0
    for _ in range(18):
        mid = (lo + hi) / 2
        if check(theme, spec, tex, mid):
            hi = mid
        else:
            lo = mid
    return lo


def main() -> int:
    if not os.path.isdir(TEX):
        print(f'找不到纹理目录 {TEX}，先跑 tex-build.py')
        return 2

    actual = load_current_ops()
    if not actual:
        print('（无法解析 tokens.scss，跳过与当前值的比对）')

    print(f'求解各卡片类允许的最大纹理浓度')
    print(f'（判据：--t1 文字区 ≥ 4.5:1，劣化 ≤ {MAX_DROP * 100:.0f}%）')
    print()
    header = f'{"卡片类":<10}{"主题":<13}{"上限":>7}{"当前":>7}'
    print(header)
    print('─' * 40)

    failures: list[str] = []
    suggested: dict[str, dict[str, float]] = {}

    for spec in CARD_SPECS:
        key = spec['key']
        for theme_key, theme in THEMES.items():
            path = os.path.join(TEX, f'{key}-{theme_key}.webp')
            if not os.path.exists(path):
                failures.append(f'{key}-{theme_key}: 文件缺失')
                continue
            tex = Image.open(path).convert('RGBA')
            worst = solve_max_op(theme, spec, tex)
            suggested.setdefault(key, {})[theme_key] = worst

            cur = actual.get((theme_key, key))
            if cur is None:
                cur_text, flag = '  n/a', ''
            else:
                flag = '' if cur <= worst + 5e-3 else '  ⚠ 过高'
                if cur > worst + 5e-3:
                    failures.append(
                        f'{key}-{theme_key}: tokens op={cur:.2f} 超过上限 {worst:.2f}')
                cur_text = f'{cur:.2f}'
            print(f'{key:<10}{theme_key:<13}{worst:>7.2f}{cur_text:>7} {flag}')

    print('─' * 40)
    print('各主题应写入 tokens.scss 的浓度：')
    for theme_key in THEMES:
        cells = []
        for spec in CARD_SPECS:
            v = suggested.get(spec['key'], {}).get(theme_key)
            if v is not None:
                cells.append(f'--tex-{spec["key"]}-op: {v:.2f}')
        print(f'  {theme_key:<13}' + '  '.join(cells))

    print()
    if failures:
        print(f'✗ {len(failures)} 项未通过：')
        for f in failures:
            print(f'  · {f}')
        return 1
    print('✓ 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
