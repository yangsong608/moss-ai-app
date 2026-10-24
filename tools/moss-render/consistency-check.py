#!/usr/bin/env python3
"""
提交前一致性检查：令牌 ↔ 资产 ↔ 类型 三方对齐 + 引用完整性。

分四组：

  1. **纹理三方对齐**
     tokens.scss 里的 --tex-*-op
     src/static/moss/tex/ 下的 .webp 资产
     MossTex.vue 的 TexKey 联合类型
     三者必须严格相等（多一个少一个都算错）。

  2. **图标三方对齐**
     MossIcon.vue 的 IconName
     src/static/moss/icon/ 下的资产
     （图标没有 CSS 令牌，但每个图标名有 4 套主题变体，变体数也要对齐）

  3. **引用完整性**
     已删除的资产名（amb / card / badge / hero / grid / mark）
     不许在源码里还有任何引用。

  4. **孤儿资产**
     磁盘上有、但类型系统里没有的资产 → 会被打进包体却没人用。
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '../..'))
SRC = os.path.join(ROOT, 'src')

errors: list[str] = []
warnings: list[str] = []


def read(path: str) -> str:
    with open(path, encoding='utf-8') as fh:
        return fh.read()


# ── 1. 纹理三方对齐 ──────────────────────────────────────────────────
#
# 纹理分两族，各走各的组件：
#   卡片纹理  → MossTex.vue（TexKey 联合类型）
#   页面层    → MossPageBg.vue（页头/页中/页尾三层构图）
#
# 两族都有令牌、也都有资产，区别只在渲染组件不同 ——
# 所以校验时必须把页面层单独列出来，否则会误报成"孤儿资产"。

PAGE_LAYER = {'pagehead', 'pagemid', 'pagetail'}

tokens_src = read(os.path.join(SRC, 'styles/tokens.scss'))
tex_tokens = set(re.findall(r'--tex-([a-z0-9]+)-op\s*:', tokens_src))

tex_assets: set[str] = set()
tex_dir = os.path.join(SRC, 'static/moss/tex')
for name in os.listdir(tex_dir):
    if not name.endswith('.webp'):
        continue
    key = name[:-len('.webp')]
    # 去掉 -<skin>-<mode> 后缀
    m = re.match(r'^(.*?)-(moss|550w)-(dark|light)$', key)
    if m:
        tex_assets.add(m.group(1))
    else:
        warnings.append(f'纹理文件名不带 skin-mode 后缀：{name}')

texvue = read(os.path.join(SRC, 'components/moss/MossTex.vue'))
tex_keys: set[str] = set()
m = re.search(r'type TexKey\s*=\s*(.*?)\n\n', texvue, re.S)
if m:
    tex_keys = set(re.findall(r"'([a-z0-9]+)'", m.group(1)))

# 页面层必须真的被 MossPageBg 引用
pagevue = read(os.path.join(SRC, 'components/moss/MossPageBg.vue'))
for key in sorted(PAGE_LAYER):
    if f'{key}-${{' not in pagevue and f'{key}-' not in pagevue:
        errors.append(f'页面层纹理 {key} 没有被 MossPageBg.vue 引用')
    if key in tex_keys:
        errors.append(f'页面层纹理 {key} 不该出现在 MossTex 的 TexKey 里（它走 MossPageBg）')

card_tokens = tex_tokens - PAGE_LAYER
card_assets = tex_assets - PAGE_LAYER

for label, a, b in (
    ('卡片令牌 vs 卡片资产', card_tokens, card_assets),
    ('卡片令牌 vs TexKey', card_tokens, tex_keys),
    ('卡片资产 vs TexKey', card_assets, tex_keys),
    ('页面层令牌 vs 页面层资产', tex_tokens & PAGE_LAYER, tex_assets & PAGE_LAYER),
):
    only_a = a - b
    only_b = b - a
    if only_a:
        errors.append(f'{label}：只在左边有 {sorted(only_a)}')
    if only_b:
        errors.append(f'{label}：只在右边有 {sorted(only_b)}')

print(f'纹理：卡片令牌 {len(card_tokens)} / 卡片资产 {len(card_assets)} / '
      f'TexKey {len(tex_keys)} + 页面层 {len(PAGE_LAYER)}')

# 每个纹理必须齐 4 套主题
for key in sorted(tex_keys | PAGE_LAYER):
    variants = [f'{key}-{s}-{d}' for s in ('moss', '550w') for d in ('dark', 'light')]
    missing = [v for v in variants if not os.path.exists(os.path.join(tex_dir, f'{v}.webp'))]
    if missing:
        errors.append(f'纹理 {key} 缺主题变体：{missing}')

# ── 2. 图标三方对齐 ──────────────────────────────────────────────────
#
# 图标资产分两类文件名（MossIcon.vue 的 src 计算）：
#   <name>-<skin>-<mode>.webp            基础图标，对应 IconName
#   <name>-<tint>-<skin>-<mode>.webp     状态配色变体（icons.py 的 TINTS）
#   <name>-fill-<skin>-<mode>.webp       实心变体（icons.py 的 FILLED）
#
# 从右边剥皮和模式，剩下的 `<name>[-<tint>|-fill]` 里，
# 已知 tint（warn/danger/done）与 fill 标记都是固定词表 ——
# IconName 里没有哪个图标名以它们结尾，所以不会有歧义。

TINT_WORDS = {'warn', 'danger', 'done'}

iconvue = read(os.path.join(SRC, 'components/moss/MossIcon.vue'))
icon_keys: set[str] = set()
m = re.search(r'type IconName\s*=\s*(.*?)\n\n', iconvue, re.S)
if m:
    icon_keys = set(re.findall(r"'([a-z0-9-]+)'", m.group(1)))

icon_assets: set[str] = set()
icon_variants: dict[str, set[str]] = {}
icon_dir = os.path.join(SRC, 'static/moss/icon')
for name in sorted(os.listdir(icon_dir)):
    if not name.endswith('.webp'):
        continue
    key = name[:-len('.webp')]
    m = re.match(r'^(.*)-(moss|550w)-(dark|light)$', key)
    if not m:
        warnings.append(f'图标文件名不带 skin-mode 后缀：{name}')
        continue
    rest = m.group(1)
    parts = rest.split('-')
    if len(parts) > 1 and parts[-1] == 'fill':
        icon_variants.setdefault('-'.join(parts[:-1]), set()).add('fill')
        icon_assets.add('-'.join(parts[:-1]))
    elif len(parts) > 1 and parts[-1] in TINT_WORDS:
        icon_variants.setdefault('-'.join(parts[:-1]), set()).add(parts[-1])
        icon_assets.add('-'.join(parts[:-1]))
    else:
        icon_assets.add(rest)

if icon_keys - icon_assets:
    errors.append(f'图标类型有、资产无：{sorted(icon_keys - icon_assets)}')
if icon_assets - icon_keys:
    errors.append(f'图标资产有、类型无：{sorted(icon_assets - icon_keys)}')
print(f'图标：类型 {len(icon_keys)} / 基础资产 {len(icon_assets)} / '
      f'变体组 {len(icon_variants)}')

for key in sorted(icon_keys):
    variants = [f'{key}-{s}-{d}' for s in ('moss', '550w') for d in ('dark', 'light')]
    missing = [v for v in variants if not os.path.exists(os.path.join(icon_dir, f'{v}.webp'))]
    if missing:
        errors.append(f'图标 {key} 缺主题变体：{missing}')

# ── 3. 引用完整性（已删除的资产不许还有引用）─────────────────────────

DEAD = ['amb', 'card', 'badge', 'hero.webp', 'grid', 'mark']
# hero 作为纹理 key 仍存在；这里只查「已删除的旧资产路径」
#
# 'grid' / 'mark' 只能按完整图标名查（IconName="grid"），
# 不能查裸字符串 'grid' —— genui.ts 里有 CONTAINERS = new Set([... 'grid' ...])，
# 那是 CSS 布局容器名，跟图标无关，误报过一次。
DEAD_PATTERNS = [
    (r'\bmoss/badge-idle\b', 'badge-idle 资产'),
    (r'\bmoss/badge-work\b', 'badge-work 资产'),
    (r'\bmoss/hero\.webp\b', 'hero.webp 资产'),
    (r'tex/amb-', 'amb 纹理'),
    (r'tex/card-', 'card 纹理'),
    (r'''name=['"]grid['"]''', 'grid 图标'),
    (r'''name=['"]mark['"]''', 'mark 图标'),
    (r'''icon/grid-''', 'grid 图标'),
    (r'''icon/mark-''', 'mark 图标'),
]

scan_ext = ('.vue', '.ts', '.scss', '.css', '.json')
for dirpath, dirnames, filenames in os.walk(SRC):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', 'dist', 'unpackage')]
    for fn in filenames:
        if not fn.endswith(scan_ext):
            continue
        path = os.path.join(dirpath, fn)
        content = read(path)
        for pat, label in DEAD_PATTERNS:
            if re.search(pat, content):
                rel = os.path.relpath(path, ROOT)
                errors.append(f'{rel} 里还有已删除的 {label} 引用（{pat}）')

# ── 4. 孤儿资产 ─────────────────────────────────────────────────────

for key in card_assets:
    if key not in tex_keys:
        errors.append(f'孤儿纹理资产：{key}-*.webp（类型里没有）')
for key in icon_assets:
    if key not in icon_keys:
        errors.append(f'孤儿图标资产：{key}-*.webp（类型里没有）')

# 图标变体的 name 段必须也是合法图标名（否则是拼错的残留）
for key in icon_variants:
    if key not in icon_keys:
        errors.append(f'孤儿图标变体：{key}-*.webp（{key} 不是合法 IconName）')
# ── 5. 工具目录里的死引用 ───────────────────────────────────────────
#
# icons.py 里的 DEAD 名单是**故意**留着这两个名字的
# （标注"主图仍在 raw-icons/，产物不再产出"），不算死引用。

for name in ('tex-build.py', 'card_specs.py', 'icons.py', 'gen-tex.py'):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        continue
    content = read(path)
    for pat, label in DEAD_PATTERNS:
        if re.search(pat, content):
            warnings.append(f'工具 {name} 里还有 {label} 引用（{pat}）')

# ── 汇总 ─────────────────────────────────────────────────────────────

print()
if warnings:
    print(f'⚠ {len(warnings)} 条提示：')
    for w in warnings:
        print(f'  - {w}')
    print()

if errors:
    print(f'✗ {len(errors)} 项错误：')
    for e in errors:
        print(f'  - {e}')
    sys.exit(1)

print('✓ 一致性检查全部通过')
