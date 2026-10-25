#!/usr/bin/env python3
"""
图形背景后处理 —— 从 AI 主图变成可直接用的卡片背景图。

输入：tools/moss-render/raw/ 下的 16 张主图
      （8 类图形 × MOSS 青绿 / 550W 赤红，各一张黑底发光线稿）
输出：src/static/moss/tex/<key>-<skin>-<mode>.webp

## 核心模型：图形锚点（anchor）

上一版是"整幅铺满 + 矩形遮罩"，结果：
  - hero 的天球仪正好压在环形进度上（两个圆环打架）
  - flipcard 的节点连线穿过标题文字
  - stat 的柱状图被数字盖住

所以改成：**先把图形从主图里抠出来，再精确贴到卡片内的目标矩形**。

  1) 抠图：主图是黑底 + 发光线稿，亮度 > 阈值就是图形。
     取亮度图的 bbox，抠出来。
  2) 适配：把抠出的图形按 contain 放进 anchor 定义的矩形。
  3) 贴图：输出图 = 卡片尺寸 × 2，图形贴在 anchor 位置，其余透明。

这样**文字和控件所在的区域天然没有图形** —— 不是靠遮罩"擦掉"，
而是图形压根不画在那儿。卡片尺寸变了也不影响（按归一化坐标贴）。

anchor = (x0, y0, x1, y1)，归一化到卡片自身尺寸。
anchor 为 None → 整幅材质模式（适合有大面积留白、或内部控件不透明的卡）。
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '../../src/static/moss/tex'))
# 主图放在 tools/ 下，不进 src/static —— 否则原始 PNG 会被打进包体。
RAW = os.path.join(HERE, 'raw')
# 主图的皮肤归属清单（见 find_raw）
SKIN_MANIFEST = os.path.join(HERE, 'raw-skin.json')

sys.path.insert(0, HERE)
from card_specs import CARD_SPECS, PAGE_SPECS  # noqa: E402

# ── 主题 ────────────────────────────────────────────────────────────────
#
# line   线稿颜色。深色主题用发光色；浅色主题用能压住白底的深色。
# boost  线稿强度增益。
# cut    抠图阈值（亮度高于此值算图形）。
#
# ## cut / boost 怎么定的
#
# 母版亮度分布实测（灰度化后，两套皮肤几乎一样）：
#   线稿像素 p50 ≈ 0.20，均值 ≈ 0.28，p99 ≈ 0.9
#
# 所以 cut 必须压得比 p50 低，才不会把线稿主体切没；
# boost 则决定线稿能达到多亮。
#
# 之前 550w-dark 用 boost=0.70 + cut=0.20，线稿峰值只有 178，
# 而 moss-dark 是 255 —— 同一张主版差这么多，纯粹是参数问题，
# 不是母版弱。赤红线稿在深色底上偏暗，会显得"没画出来"。
# 现在两套深色皮肤对齐（boost 1.15 / cut 0.15），
# 浅色两套也对齐（boost 1.60 / cut 0.11）。
THEMES = {
    'moss-dark': {
        'line': (0x46, 0xe3, 0xa6),   # --acc 同色系发光青绿
        'boost': 1.15,
        'cut': 0.15,
    },
    'moss-light': {
        'line': (0x0a, 0x6b, 0x4a),   # 深青绿，浅底上清晰
        'boost': 1.60,
        'cut': 0.11,
    },
    '550w-dark': {
        'line': (0xff, 0x4d, 0x3a),   # 赤红
        'boost': 1.15,
        'cut': 0.15,
    },
    '550w-light': {
        'line': (0x9c, 0x24, 0x18),   # 深赤陶
        'boost': 1.60,
        'cut': 0.11,
    },
}

# 主题 → 主图（浅色版复用深色版主图，只换配色）
SKIN_MATCH = {
    'moss-dark': 'moss',
    'moss-light': 'moss',
    '550w-dark': '550w',
    '550w-light': '550w',
}

# 图形语义关键词 → 卡片 key。文件名是生图工具给的提示词摘要。
KEY_MATCH = {
    'hero': 'astronomical',
    'stat': 'data_visualization',
    'quick': 'quill_pen',
    'calpage': 'calendar_time_grid',
    'flipcard': 'task_flow',
    'caldate': 'celestial_moon',
    'menu': 'stacked_drawer',
    'modal': 'fractured_warning',
    # 笔记页
    'note': 'wide_horizontal_document_tab',
    'reader': 'open_book_page_spread',
    'placeholder': 'reading_search_schematic',
    'nbcol': 'narrow_horizontal_row_of_boo',
    'news': 'flat_wide_horizontal_news_fe',
    'console': 'device_network_topology',
    'sync': 'bidirectional_sync',
    'local': 'offline_local_storage',
    'ovcard': 'tall_vertical_sync_pipeline',
    # 首页
    'dev': 'remote_workstation',
    'pair': 'pairing_scan',
    'ondev': 'on_device',
    'empty': 'disconnected_link',
    'srow': 'conversation_thread',
    # 日历页
    'agenda': 'vertical_timeline_ax',
    # 专注页
    'timer': 'hourglass',
    'statbox': 'radial_gauge',
    # 关于页
    'brand': 'minimal_emblem',
    # 整页环境背景
    'pagehead': 'wide_and_shallow_celestial',
    'pagemid': 'extremely_simple',
    'pagetail': 'horizon_com',
}

# 两套皮肤共用一张主图的 key —— 只换线条色，形状不变。
#
# ## 为什么需要显式声明
#
# 母版入库时做过灰度归一化（RGB → max 通道灰度），色相信息在压缩时就丢了，
# 抠图又只用亮度当 alpha、颜色全部取自 THEMES[skin]['line']。
# 也就是说：**一张母版本来就足以供给两套皮肤**，形状完全由它决定。
#
# 之前是每套皮肤各出一版主图（两张 AI 生成图），结果 22 张卡片纹理
# 在两套皮肤下形状都不一样 —— 换肤等于换画，alpha IoU 只有 0.02~0.26。
# 页面背景层 pagehead / pagemid / pagetail 一直靠 find_raw 的兜底路径
# 共用主图（IoU = 1.00），卡片纹理也应该这样。
#
# 新出的 4 类（日历议程 / 计时 / 统计 / 品牌徽记）直接按这个规则走。
SHARED_MASTER_KEYS = {'agenda', 'timer', 'statbox', 'brand'}


def _load_skin_manifest() -> dict[str, str]:
    """读 raw-skin.json：{'raw/文件名.png': 'moss' | '550w'}。"""
    global _SKIN_CACHE
    if _SKIN_CACHE is None:
        try:
            with open(SKIN_MANIFEST, encoding='utf-8') as fh:
                _SKIN_CACHE = json.load(fh)
        except (OSError, ValueError):
            _SKIN_CACHE = {}
    return _SKIN_CACHE


_SKIN_CACHE: dict[str, str] | None = None


def find_raw(key: str, skin: str) -> str | None:
    """
    按图形语义 + 皮肤定位主图。

    皮肤不靠文件名或排序判断（生图文件名带随机时间戳，排序不可靠），
    而是查 **raw-skin.json 清单**：清单里记着每张主图属于哪套皮肤。

    ## 为什么用清单而不是看图的颜色

    母版入库时做过一次无损压缩：把 RGB 归一化成「最大通道灰度」。
    抠图只取 max 通道当 alpha，所以这一步对产物是无损的，
    但颜色信息（青绿 / 赤红的色相）就没了。

    而色相正是判断"这张是 MOSS 版还是 550W 版"的唯一依据：
    靠 G - (R+B)/2 的正负来分。灰度后这个值恒为 0，
    全部母版都会被误判成同一套皮肤，550W 的图就会用上 MOSS 的主图。

    所以：颜色信息在压缩时丢一次，就用清单把它记下来一次。
    清单由 raw-skin.json 直接读，不重新分析像素 —— 确定性更高。
    """
    if not os.path.isdir(RAW):
        return None
    want = KEY_MATCH.get(key, key)
    want_skin = SKIN_MATCH[skin]

    hits = []
    for name in sorted(os.listdir(RAW)):
        if not name.lower().endswith('.png'):
            continue
        if want not in name.lower():
            continue
        hits.append(os.path.join(RAW, name))
    if not hits:
        return None

    manifest = _load_skin_manifest()

    if key in SHARED_MASTER_KEYS:
        # 共用主图：只认清单里标为 moss 的那一张，两套皮肤都用它。
        # 清单缺失时退回第一张（母版只有一版时天然就是这个结果）。
        shared = [h for h in hits
                  if manifest.get(f'raw/{os.path.basename(h)}') == 'moss']
        return shared[0] if shared else hits[0]

    if manifest:
        matched = [
            h for h in hits
            if manifest.get(f'raw/{os.path.basename(h)}') == want_skin
        ]
        if matched:
            return matched[0]
        # 这组图里没有该皮肤的主版 —— 退回第一张，只换配色。
        # 页面背景层（pagehead / pagemid / pagetail）就是这种情况：
        # 构图是通用的，只出一版 MOSS 主图，550W 复用它、只改线条色。
        return hits[0]

    def dominant_skin(path: str) -> str:
        """判断主图是青绿系还是赤红系（无清单时的兜底）。"""
        a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255.0
        bright = a.max(axis=2) > 0.25
        if bright.sum() < 10:
            return 'moss'
        px = a[bright]
        green = float((px[:, 1] - (px[:, 0] + px[:, 2]) / 2).mean())
        return 'moss' if green >= 0 else '550w'

    matched = [h for h in hits if dominant_skin(h) == want_skin]
    if matched:
        return matched[0]
    return hits[0]


# ── 1. 去水印 ──────────────────────────────────────────────────────────

def remove_watermark(img: Image.Image) -> Image.Image:
    """
    抹掉右下角的"AI生成 / WORKBUDDY"标记。

    标记是右下角约 14% 宽 × 10% 高的浅色矩形。主图是黑底，
    直接涂黑不会破坏图形；接缝处做羽化。
    """
    img = img.convert('RGB')
    w, h = img.size
    x0, y0 = int(w * 0.855), int(h * 0.895)
    x1, y1 = w, h
    if x1 - x0 < 8 or y1 - y0 < 8:
        return img

    a = np.asarray(img).astype(np.float32)
    ref = a[y0:y1, max(0, x0 - (x1 - x0) * 2):x0]
    fill = np.percentile(ref.reshape(-1, 3), 15, axis=0) if ref.size else np.zeros(3)
    a[y0:y1, x0:x1] = fill[None, None, :]

    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')

    feather = max(2, int((x1 - x0) * 0.4))
    m = np.zeros((h, w), dtype=np.float32)
    m[y0:y1, x0:x1] = 1.0
    ramp = np.ones(w, dtype=np.float32)
    ramp[:x0] = 0
    ramp[x0:x0 + feather] = np.linspace(0, 1, feather)
    m *= ramp[None, :]
    mask = Image.fromarray((m * 255).astype(np.uint8), 'L').filter(
        ImageFilter.GaussianBlur(feather / 3)
    )
    return Image.composite(out, img, mask)


# ── 2. 抠出图形 ────────────────────────────────────────────────────────

def extract_graphic(img: Image.Image, theme: dict) -> Image.Image:
    """
    从黑底发光线稿里抠出图形（RGBA，alpha = 亮度）。

    亮度取三通道最大值 —— 线稿是单色发光的，底色是黑的。
    """
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    lum = a.max(axis=2)

    line = np.clip((lum - theme['cut']) / (1.0 - theme['cut']), 0.0, 1.0)
    line = line ** 1.05          # 稍微压一下低亮度，避免糊成一团
    line = np.clip(line * theme['boost'], 0.0, 1.0)

    color = np.asarray(theme['line'], dtype=np.float32)
    rgb = np.broadcast_to(color[None, None, :], line.shape + (3,))

    out = np.dstack([rgb, (line * 255).astype(np.uint8)]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def trim(graphic: Image.Image, thresh: int = 10) -> Image.Image:
    """裁掉图形四周的全透明区域，保留最小包围盒。"""
    a = np.asarray(graphic)
    ys, xs = np.nonzero(a[..., 3] > thresh)
    if len(xs) == 0:
        return graphic
    return graphic.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


# ── 3. 贴到卡片里的目标矩形 ────────────────────────────────────────────

# 图形裁切后至少要保留这么大比例的面积，否则改成完整容纳。
#
# 为什么需要这个阈值：图形和锚区的比例常常差很远
# （比如控制台的设备拓扑图是 1.26:1，锚区却是一条 6.9:1 的扁带）。
# 硬按锚区比例裁，只能留下图形中间的一小条 ——
# 设备拓扑图变成几根断线，语义全丢了。
#
# 低于阈值时改为**完整容纳**：图形整体缩进锚区（两侧留透明边）。
# 视觉上小一点，但看得出是什么东西；比"几根看不懂的线"强得多。
MIN_KEEP = 0.55


def _alpha_centroid(img: Image.Image) -> tuple[float, float]:
    """图形 alpha 的加权重心（归一化）。"""
    a = np.asarray(img)[..., 3].astype(np.float32)
    total = a.sum()
    if total <= 0:
        return 0.5, 0.5
    ys, xs = np.nonzero(a > 10)
    w = a[ys, xs]
    return (float((xs * w).sum() / total / img.width),
            float((ys * w).sum() / total / img.height))


def place(graphic: Image.Image, out_w: int, out_h: int,
          anchor: tuple[float, float, float, float],
          focus: tuple[float, float] | None = None,
          force_contain: bool = False) -> Image.Image:
    """
    把图形放进 anchor 矩形里，贴在输出图的对应位置。

    输出图 = 卡片尺寸。图形之外全透明 —— 卡片底色（--s1）透出来。

    ## 裁切策略

    早期版本把整个图形 contain 进 anchor 矩形，结果：主图里图形是
    992×810 的方块（比如控制台的设备拓扑图），anchor 是 231×28 的扁条
    → contain 后图形只有 28px 高，非零像素占比掉到 0.2%，等于没画。

    现在改成**先按 anchor 的宽高比从主图里裁一块**（以 focus 为锚点），
    再缩放到 anchor 矩形。裁切保留了图形在该比例下的全部细节，
    且不会因为比例悬殊而浪费空间。

    ## 三道保险

    1. **比例失配保护**（MIN_KEEP）：按锚区比例裁完只剩不到 55% 的图形时，
       改为完整容纳 —— 图形小一点，但语义完整。
    2. **重心自适应**：focus 手写容易偏（实测 20 张卡里 4 张偏了 0.3+），
       所以裁切中心优先取图形自己的 alpha 重心，focus 只作微调。
    3. **显式完整容纳**（force_contain）：有些图形是**闭合框**，
       裁一刀就破相 —— 关于页的 MOSS 徽记（圆角方框 + 菱形），
       按宽高比裁掉 6% 就会把上下两条边框切没，只剩一个菱形。
       这种图不能用比例启发式判断，规格里显式写 'place': 'contain'。
    """
    canvas = Image.new('RGBA', (out_w, out_h), (0, 0, 0, 0))

    x0, y0, x1, y1 = anchor
    tx0, ty0 = int(round(x0 * out_w)), int(round(y0 * out_h))
    tx1, ty1 = int(round(x1 * out_w)), int(round(y1 * out_h))
    tw, th = max(1, tx1 - tx0), max(1, ty1 - ty0)

    g = graphic
    target_ratio = tw / th
    src_ratio = g.width / g.height
    keep = min(src_ratio, target_ratio) / max(src_ratio, target_ratio)

    if keep >= MIN_KEEP and not force_contain:
        # 比例接近 → 按锚区比例裁一块，保留细节
        # 裁切中心：图形 alpha 重心，focus 作为微调偏移
        cx0, cy0 = _alpha_centroid(g)
        if focus:
            cx0 = 0.75 * cx0 + 0.25 * focus[0]
            cy0 = 0.75 * cy0 + 0.25 * focus[1]
        if src_ratio > target_ratio:
            # 源更宽 → 裁两侧
            nh = g.height
            nw = max(1, int(round(nh * target_ratio)))
            cx = int(round(cx0 * g.width - nw / 2))
            cx = max(0, min(cx, g.width - nw))
            g = g.crop((cx, 0, cx + nw, nh))
        else:
            # 源更高 → 裁上下
            nw = g.width
            nh = max(1, int(round(nw / target_ratio)))
            cy = int(round(cy0 * g.height - nh / 2))
            cy = max(0, min(cy, g.height - nh))
            g = g.crop((0, cy, nw, cy + nh))

    # contain：保持比例塞进目标矩形
    scale = min(tw / g.width, th / g.height)
    nw, nh = max(1, int(round(g.width * scale))), max(1, int(round(g.height * scale)))
    g = g.resize((nw, nh), Image.LANCZOS)

    # 居中放进目标矩形
    ox = tx0 + (tw - nw) // 2
    oy = ty0 + (th - nh) // 2
    canvas.alpha_composite(g, (max(0, ox), max(0, oy)))
    return canvas


# ── 4. 整幅材质模式（anchor 为 None 时）────────────────────────────────

def full_bleed(graphic: Image.Image, out_w: int, out_h: int,
               spec: dict) -> Image.Image:
    """
    整幅铺：把图形拉伸铺满整张卡。

    只用在「图形要连续铺开才成立」的卡（台历卡的网格线）。
    keep_band = 只保留图形的矩形带（归一化），带外清零。
    这样台历卡只在顶部装订条那一带露出网格线 ——
    那一带只有装订孔和日期头，网格是"台历纸的格线"，语义正好。
    """
    g = graphic.resize((out_w, out_h), Image.LANCZOS)
    canvas = Image.new('RGBA', (out_w, out_h), (0, 0, 0, 0))
    canvas.alpha_composite(g, (0, 0))

    alpha = np.asarray(canvas).astype(np.float32)
    h, w = alpha.shape[:2]
    xs = np.arange(w)[None, :]
    ys = np.arange(h)[:, None]

    band = spec.get('keep_band')
    if band:
        # 只保留带内
        keep = ((xs >= band[0] * w) & (xs <= band[2] * w)
                & (ys >= band[1] * h) & (ys <= band[3] * h))
        alpha[..., 3] = np.where(keep, alpha[..., 3], 0.0)
    else:
        # safe 是"要保护的矩形"，safe 之外保持原样
        safe = spec.get('safe', (0, 0, 1, 1))
        inside = ((xs >= safe[0] * w) & (xs <= safe[2] * w)
                  & (ys >= safe[1] * h) & (ys <= safe[3] * h))
        alpha[..., 3] = np.where(inside, 0.0, alpha[..., 3])

    return Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), 'RGBA')


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def attenuate(alpha: np.ndarray, safe: tuple[float, float, float, float],
              strength: float) -> np.ndarray:
    """文字安全区里的图案强度压下去，边界平滑过渡。"""
    h, w = alpha.shape
    x0, y0, x1, y1 = safe

    band = 0.10
    sx0, sy0 = x0 * w, y0 * h
    sx1, sy1 = x1 * w, y1 * h

    xs = np.arange(w)[None, :]
    ys = np.arange(h)[:, None]
    inside = (xs >= sx0) & (xs <= sx1) & (ys >= sy0) & (ys <= sy1)
    dx = np.maximum(np.maximum(sx0 - xs, xs - sx1), 0)
    dy = np.maximum(np.maximum(sy0 - ys, ys - sy1), 0)
    dist = np.sqrt(dx * dx + dy * dy)

    edge = max(1e-6, band * min(w, h))
    wgt = 1.0 - _smoothstep(np.clip(dist / edge, 0, 1))
    wgt = np.where(inside, 1.0, wgt) * strength

    return alpha.astype(np.float32) * (1.0 - wgt)


# ── 4. 整页环境背景层 ────────────────────────────────────────────────

def layer(graphic: Image.Image, out_w: int) -> Image.Image:
    """
    页面背景层：按目标宽度等比缩放，不加画布、不做定位。

    和 place() 的区别：卡片纹理要知道"该贴到卡片哪个矩形"，
    页面背景是独立的一层，位置和大小由 CSS 决定（手机/平板各自适配），
    所以这里只负责把图形缩放到合适的基准宽度，剩下全透明边距都不留。
    """
    h = max(1, int(round(graphic.height * out_w / graphic.width)))
    return graphic.resize((out_w, h), Image.LANCZOS)


# ── 5. 输出 ────────────────────────────────────────────────────────────

# 输出分辨率倍率。线稿不是照片，1.5 倍已经足够锐利；
# 2 倍图会让包体直接翻倍（48 张图一度到 948KB）。
SCALE = 1.5

# 单张体积上限（KB）。超了就降 quality 重试。
CAP_KB = 28.0


def build(skin: str, spec: dict, raw: Image.Image) -> tuple[str, int]:
    is_layer = spec.get('mode') == 'layer'
    # layer 模式只有宽（高按图形比例算），没有 h
    out_w = int(spec['w'] * SCALE)
    out_h = int(spec.get('h', 0) * SCALE)

    graphic = trim(extract_graphic(raw, THEMES[skin]))

    if is_layer:
        # 整页背景层：只有宽，高按图形比例算
        im = layer(graphic, out_w)
    else:
        anchor = spec.get('anchor')
        if anchor:
            im = place(graphic, out_w, out_h, anchor, spec.get('focus'),
                       force_contain=(spec.get('place') == 'contain'))
        else:
            im = full_bleed(graphic, out_w, out_h, spec)

    name = f'{spec["key"]}-{skin}.webp'
    path = os.path.join(OUT, name)

    # 体积是硬约束：超了就降质量重试。
    # 线稿的 alpha 通道是压缩率杀手（RGBA WebP 的 alpha 用无损或高成本编码），
    # 所以先降 alpha_quality，再降整体 quality。
    quality, alpha_q = 82, 70
    while True:
        im.save(path, 'WEBP', quality=quality, method=6, alpha_quality=alpha_q)
        size = os.path.getsize(path)
        if size <= CAP_KB * 1024 or quality <= 40:
            break
        quality -= 10
        alpha_q = max(30, alpha_q - 15)

    return path, size


def main() -> int:
    only = None
    args = sys.argv[1:]
    if '--only' in args:
        only = set(args[args.index('--only') + 1].split(','))

    if not os.path.isdir(OUT):
        print(f'找不到输出目录 {OUT}')
        return 2
    os.makedirs(OUT, exist_ok=True)

    total = 0
    count = 0
    skipped: list[str] = []
    print(f'{"卡片":<10}{"主题":<13}{"尺寸":>14}{"体积":>9}')
    print('─' * 48)

    cache: dict[str, Image.Image] = {}
    for skin in THEMES:
        for spec in list(CARD_SPECS) + list(PAGE_SPECS):
            if only and spec['key'] not in only:
                continue
            path_raw = find_raw(spec['key'], skin)
            if path_raw is None:
                # 这个页面还没出主图 —— 跳过，不中断其它卡片
                skipped.append(f'{spec["key"]}/{skin}')
                continue
            if path_raw not in cache:
                cache[path_raw] = remove_watermark(Image.open(path_raw))
            path, size = build(skin, spec, cache[path_raw])
            total += size
            count += 1
            dim = f'{int(spec["w"] * SCALE)}×{int(spec.get("h", 0) * SCALE)}'
            print(f'{spec["key"]:<10}{skin:<13}{dim:<16}{size / 1024:>8.1f}K')

    print('─' * 48)
    print(f'合计 {count} 张，{total / 1024:.1f} KB')
    if skipped:
        keys = sorted(set(s.split('/')[0] for s in skipped))
        print(f'跳过 {len(skipped)} 项（还没出主图）：{", ".join(keys)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
