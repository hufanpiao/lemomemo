"""皮肤对比度检查（架构 8.1“check_contrast.py 的检查对象”、L7；B6-exe 任务单 F12）。

用法：
  python -I build/check_contrast.py [--root 仓库根] [--pairs 清单] [--skins 皮肤目录] [--json]

做什么：
  读 src/styles/skins/*.css 里 `:root[data-skin="…"][data-theme="…"]{…}` 各块的变量，
  按 build/contrast-pairs.json 的“前景变量 / 背景变量 / 类别”清单，在每套皮肤的每种深浅下逐项算对比度。

怎么算（照 8.1 和皮肤视觉稿“对比度实测”一节的说明）：
  • 对比度按 WCAG 2.x 的相对亮度公式：(L1 + 0.05) / (L2 + 0.05)，sRGB 分量 ≤ 0.04045 时除以 12.92，否则 ((c + 0.055) / 1.055) ^ 2.4。
    （WCAG 文本写的阈值是 0.03928；8 位整数里没有哪个值落在两者之间，结果一样。）
  • 门槛按类别读清单的 thresholds：正文、次要文字 ≥ 4.5；大字、图标、选中块边界等非文字 ≥ 3。
  • 判定按精确值比（WCAG 2.x 不取整；代码审查 M4）：4.495 判不过。JSON 的 ratio 取两位小数（和视觉稿对照用），
    exact 是精确值；文字输出里不达标的项打 4 位小数（向下截断），免得出现“4.50 < 4.5”。
  • 半透明的背景按“最坏底色”算：先把半透明色按它的不透明度叠到最坏底色上，再算，模糊带来的柔化不算。
    最坏底色由半透明色本身的深浅决定（相对亮度 ≥ 0.179 算浅色，这是对黑、对白对比度相等的分界）：
    浅色半透明取清单 backdrops.light（墨黑 ＋ 本套最深的项目色），深色半透明取 backdrops.dark
    （白、柠檬黄 ＋ 本套最亮的项目色）；逐个算，取最低值。
  • 渐变背景逐个色标算，取最低值：最底下一层（实色或线性渐变）的每个色标是一种“底”；
    上面每一层渐变的每个色标按自身透明度分别叠到每种底上（视觉稿的做法：每个光斑单独叠在底色上，不算光斑互相重叠）。
  • 背景可以写成多层（数组，第一个在最上面），例如选中块叠在玻璃上：从下往上逐层叠。
  • 前景如果半透明，叠到每种背景上再算。
  • 一项在一套皮肤里有多种可能的前景、背景时，取最低的那个，报告里给出那一组颜色。
  • 已知的近似（代码审查 S9）：渐变和半透明叠色只看两端色标，默认中间的颜色介于两端之间。相对亮度是三个通道
    各自单调函数之和，两端色相差很大时（比如黄叠蓝）中间理论上可能更低；现在的令牌里没有这种组合。
    上层变量自己有多层时，每个色标单独叠到底上，不和同一变量里的其他层叠在一起；清单里没有用到多层的上层变量。

认不出的写法一律报 2，不悄悄跳过（代码审查 M1、M2）：命名色、hsl()、color-mix()、calc()、none、url()、
分量越界（rgb 0～255、透明度 0～1；不照 CSS 截断：令牌是手写的，越界多半是笔误）、空值、空层、
渐变里认不出的方向或色标、括号不配对。var() 照 CSS 的规矩：变量存在时缺省值整段不看，不存在时才解缺省值。
皮肤文件里带 data-skin 的块写法不对、某个文件一块都没有、某套皮肤缺浅色或深色，也报 2（代码审查 S3）。

负责人已接受的例外（清单 accepted，B2 FA-7 第 4 项，负责人 11-05 定）：每条写皮肤 theme、项 id、当时的精确值 floor（4 位小数，向下截断）、
decided（谁哪天定的）、reason（为什么接受）。名单里的项不达标、精确值截断到 4 位正好等于 floor 时不算失败，单独列成“已接受的例外”；
floor 和现在的值对不上（颜色变了，变好变坏都算；代码复审 M5）、名单里的项已经达标了、或者皮肤、项不存在、字段缺了，报 2
（名单要跟着改，重新请负责人定；不留过时的例外，也不能写个宽松的 floor 糊过去）。
名单之外新出现的不达标照样报 1。

退出码：0 全部达标（或只剩已接受的例外）；1 有不达标的项；2 清单或皮肤文件有问题（变量不存在、颜色解析不了、清单格式不对）。
脚本自己出了异常也归 2，并报出是哪一套哪一项——保证退出码 1 一定是真的不达标。
本脚本只读不写，不改任何皮肤文件。
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
import sys
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 相对亮度 ≥ 这个值的半透明色算“浅色”（对黑、对白对比度相等的分界：sqrt(1.05 × 0.05) − 0.05）
LIGHT_SPLIT = (1.05 * 0.05) ** 0.5 - 0.05

Color = tuple[float, float, float, float]  # r、g、b 为 0～255，a 为 0～1


class ConfigError(Exception):
    """清单或皮肤文件本身有问题（退出码 2）"""


# ---------------- 颜色 ----------------

def _channel(c: float) -> float:
    s = c / 255.0
    return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4


def luminance(c: Color) -> float:
    """WCAG 2.x 相对亮度（只看不透明的 rgb）"""
    return 0.2126 * _channel(c[0]) + 0.7152 * _channel(c[1]) + 0.0722 * _channel(c[2])


def ratio(a: Color, b: Color) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def over(top: Color, base: Color) -> Color:
    """top 按自身不透明度叠到不透明的 base 上，得到不透明色"""
    a = top[3]
    return (
        top[0] * a + base[0] * (1 - a),
        top[1] * a + base[1] * (1 - a),
        top[2] * a + base[2] * (1 - a),
        1.0,
    )


def to_hex(c: Color) -> str:
    return '#' + ''.join(f'{max(0, min(255, round(v))):02X}' for v in c[:3])


_HEX = re.compile(r'#([0-9a-fA-F]{3,8})')
_FUNC = re.compile(r'rgba?\(\s*([^()]*)\)', re.I)
_NUM = re.compile(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?', re.I)


def _number(tok: str, text: str) -> tuple[float, bool]:
    """一个分量：返回 (数值, 是不是百分比)；none、calc() 之类认不出的报 2"""
    if not _NUM.fullmatch(tok):
        raise ConfigError(f'颜色分量认不出：{tok}（{text}）')
    if tok.endswith('%'):
        return float(tok[:-1]), True
    return float(tok), False


def parse_color(text: str) -> Color:
    """一个颜色值：#RGB、#RGBA、#RRGGBB、#RRGGBBAA、rgb()/rgba()、transparent。
    rgb() 三种写法：逗号分隔 3 或 4 个；空格分隔正好 3 个；空格分隔 3 个 + “/ 透明度”。
    分量 0～255（或 0%～100%），透明度 0～1（或 0%～100%），越界报 2，不截断"""
    t = text.strip()
    if t.lower() == 'transparent':
        return (0.0, 0.0, 0.0, 0.0)
    m = _HEX.fullmatch(t)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            h = ''.join(ch * 2 for ch in h)
        if len(h) not in (6, 8):
            raise ConfigError(f'颜色写法不认识：{text}')
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (float(int(h[0:2], 16)), float(int(h[2:4], 16)), float(int(h[4:6], 16)), a)
    m = _FUNC.fullmatch(t)
    if not m:
        raise ConfigError(f'颜色写法不认识：{text}')
    body = m.group(1).strip()
    if '/' in body:
        before, _, after = body.partition('/')
        rgb_t, a_t = before.split(), after.split()
        if ',' in body or '/' in after or len(rgb_t) != 3 or len(a_t) != 1:
            raise ConfigError(f'颜色写法不认识（斜杠前要正好 3 个分量、后面 1 个透明度）：{text}')
        toks = rgb_t + a_t
    elif ',' in body:
        toks = [x.strip() for x in body.split(',')]
        if len(toks) not in (3, 4) or any(not x or ' ' in x for x in toks):
            raise ConfigError(f'颜色写法不认识（逗号写法要 3 或 4 个分量）：{text}')
    else:
        toks = body.split()
        if len(toks) != 3:
            raise ConfigError(f'颜色写法不认识（空格写法要正好 3 个分量，透明度写在“/”后面）：{text}')
    rgb = []
    for tok in toks[:3]:
        v, pct = _number(tok, text)
        v = v * 255 / 100 if pct else v
        if not 0 <= v <= 255:
            raise ConfigError(f'颜色分量超出 0～255：{tok}（{text}）')
        rgb.append(v)
    a = 1.0
    if len(toks) == 4:
        v, pct = _number(toks[3], text)
        a = v / 100 if pct else v
        if not 0 <= a <= 1:
            raise ConfigError(f'透明度超出 0～1：{toks[3]}（{text}）')
    return (rgb[0], rgb[1], rgb[2], a)


def split_top(text: str, sep: str = ',', keep_empty: bool = False) -> list[str]:
    """按顶层的分隔符切开（括号里的不切）；括号不配对报 2。keep_empty 时空段也留着（调用方据此报错）"""
    out, depth, cur = [], 0, []
    for ch in text:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth < 0:
                raise ConfigError(f'括号不配对：{text[:80]}')
        if ch == sep and depth == 0:
            out.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if depth:
        raise ConfigError(f'括号不配对：{text[:80]}')
    out.append(''.join(cur).strip())
    return out if keep_empty else [s for s in out if s]


_GRAD = re.compile(r'(?:repeating-)?(linear|radial|conic)-gradient\((.*)\)', re.I | re.S)
# 渐变里的位置、大小：长度、百分比、0
_POS = re.compile(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:%|px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?', re.I)
_ANGLE = re.compile(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)', re.I)
# 渐变第一个参数（方向、形状、圆心、插值色彩空间）里允许的关键字
_PRELUDE_WORDS = {
    'to', 'at', 'from', 'in', 'left', 'right', 'top', 'bottom', 'center', 'circle', 'ellipse',
    'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner',
    'srgb', 'srgb-linear', 'display-p3', 'lab', 'oklab', 'lch', 'oklch', 'hsl', 'hwb', 'xyz', 'xyz-d50', 'xyz-d65',
    'shorter', 'longer', 'increasing', 'decreasing', 'hue',
}


@dataclass(frozen=True)
class Layer:
    """背景的一层：plain=单一颜色；gradient=渐变的各个色标"""
    kind: str  # 'plain' | 'gradient'
    stops: tuple[Color, ...]


def _is_prelude(arg: str) -> bool:
    toks = split_top(arg, ' ')
    return bool(toks) and all(
        t.lower() in _PRELUDE_WORDS or _POS.fullmatch(t) or _ANGLE.fullmatch(t) for t in toks
    )


def _gradient_stops(part: str, args_text: str) -> tuple[Color, ...]:
    """渐变参数逐个解析（代码审查 M1：不许悄悄丢掉色标）：
    第一个参数是方向或形状（角度、to …、circle、… at …、尺寸）就跳过；其余每个参数去掉末尾的位置（最多两个）以后
    必须是认得的颜色；只有一个位置的参数是色标之间的过渡提示，跳过。认不出的一律报 2"""
    args = split_top(args_text, ',', keep_empty=True)
    if any(not a for a in args):
        raise ConfigError(f'渐变里有空参数：{part[:80]}')
    stops: list[Color] = []
    for i, arg in enumerate(args):
        toks = split_top(arg, ' ')
        n = len(toks)
        while n > 1 and len(toks) - n < 2 and _POS.fullmatch(toks[n - 1]):
            n -= 1
        try:
            stops.append(parse_color(' '.join(toks[:n])))
            continue
        except ConfigError:
            if i == 0 and _is_prelude(arg):
                continue
            if i > 0 and len(toks) == 1 and _POS.fullmatch(toks[0]):
                continue
            raise ConfigError(f'渐变里的色标认不出：{arg}（{part[:80]}）') from None
    if not stops:
        raise ConfigError(f'渐变里没有找到颜色：{part[:80]}')
    return tuple(stops)


def parse_background(text: str, where: str = '') -> list[Layer]:
    """一个背景值拆成层（第一个在最上面），每层是一种颜色或一组渐变色标；空值、空层报 2"""
    label = f'{where} ' if where else ''
    if not text.strip():
        raise ConfigError(f'{label}是空值')
    parts = split_top(text, ',', keep_empty=True)
    if any(not p for p in parts):
        raise ConfigError(f'{label}有空的一层：{text[:80]}')
    layers = []
    for part in parts:
        g = _GRAD.fullmatch(part.strip())
        if g:
            layers.append(Layer('gradient', _gradient_stops(part, g.group(2))))
        else:
            layers.append(Layer('plain', (parse_color(part),)))
    return layers


# ---------------- 皮肤文件 ----------------

_BLOCK = re.compile(r':root\[data-skin="([\w-]+)"\]\[data-theme="(light|dark)"\]\s*\{([^{}]*)\}')
_BLOCK_SEL = re.compile(r':root\[data-skin="[\w-]+"\]\[data-theme="(?:light|dark)"\]')
_DECL = re.compile(r'(--[\w-]+)\s*:\s*([^;]*)')


def load_skins(skins_dir: pathlib.Path) -> dict[str, dict[str, str]]:
    """{ 'simple-light': {'--bg': '#E9EAEE', …}, … }；同一套出现两次时后面的覆盖前面的（和 CSS 一样）"""
    files = sorted(skins_dir.glob('*.css'))
    if not files:
        raise ConfigError(f'皮肤目录里没有 .css：{skins_dir}')
    themes: dict[str, dict[str, str]] = {}
    for f in files:
        try:
            raw = f.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError) as e:
            raise ConfigError(f'读不了皮肤文件 {f.name}：{e}') from e
        text = re.sub(r'/\*.*?\*/', '', raw, flags=re.S)
        # 代码审查 S3：带 data-skin 的块写法不对（顺序反了、单引号、后面多跟属性）不许悄悄跳过
        for sel in re.findall(r'([^{}]*)\{', text):
            if 'data-skin' in sel and not _BLOCK_SEL.fullmatch(sel.strip()):
                raise ConfigError(f'{f.name}：皮肤块的选择器认不出：{sel.strip()[:80]}')
        blocks = _BLOCK.findall(text)
        if not blocks:
            raise ConfigError(f'皮肤文件里没有找到 :root[data-skin][data-theme] 块：{f.name}')
        for skin, mode, body in blocks:
            vars_ = themes.setdefault(f'{skin}-{mode}', {})
            for name, value in _DECL.findall(body):
                vars_[name] = value.strip()
    for skin in sorted({k.rsplit('-', 1)[0] for k in themes}):
        for mode in ('light', 'dark'):
            if f'{skin}-{mode}' not in themes:
                raise ConfigError(f'皮肤 {skin} 缺 {mode} 那一块（浅色、深色都要有）')
    return themes


_VAR_OPEN = re.compile(r'\bvar\(', re.I)
_VAR_NAME = re.compile(r'--[\w-]+')


def _expand(value: str, vars_: dict[str, str], seen: tuple[str, ...]) -> str:
    """把值里的 var(--x[, 缺省值]) 逐个换成实际值。手写括号配对，缺省值里可以有括号（rgba()、嵌套 var()）。
    照 CSS：--x 存在时缺省值整段不看；不存在时才解缺省值（缺省值里的 var 也要解）；都没有报 2"""
    out: list[str] = []
    i = 0
    while True:
        m = _VAR_OPEN.search(value, i)
        if not m:
            out.append(value[i:])
            return ''.join(out)
        out.append(value[i:m.start()])
        depth, k = 1, m.end()
        while k < len(value) and depth:
            if value[k] == '(':
                depth += 1
            elif value[k] == ')':
                depth -= 1
            k += 1
        if depth:
            raise ConfigError(f'var() 括号不配对：{value[:80]}')
        inner = value[m.end():k - 1]
        head = split_top(inner, ',', keep_empty=True)
        name = head[0]
        fallback = inner[inner.index(',') + 1:] if len(head) > 1 else None
        if not _VAR_NAME.fullmatch(name):
            raise ConfigError(f'var() 里的变量名认不出：{name}')
        if name in vars_:
            out.append(_resolve(vars_, name, seen))
        elif fallback is not None:
            out.append(_expand(fallback.strip(), vars_, seen))
        else:
            raise ConfigError(f'没有变量 {name}')
        i = k


def _resolve(vars_: dict[str, str], name: str, seen: tuple[str, ...]) -> str:
    if name in seen:
        raise ConfigError(f'变量循环引用 {" → ".join(seen + (name,))}')
    if name not in vars_:
        raise ConfigError(f'没有变量 {name}')
    return _expand(vars_[name], vars_, seen + (name,))


def resolve(vars_: dict[str, str], name: str, theme: str = '') -> str:
    """变量 name 的值，里面的 var() 逐层换成实际值。theme 不再用（报错的“哪一套哪一项”前缀由 check() 统一加），
    留着只为兼容旧的三参数调用"""
    del theme
    return _resolve(vars_, name, ())


# ---------------- 叠色 ----------------

def backdrops_for(tint: Color, vars_: dict[str, str], theme: str, conf: dict) -> list[Color]:
    """半透明色底下的“最坏底色”：按它自身深浅取 backdrops.light 或 backdrops.dark（theme 参数不用，保留旧签名）"""
    side = conf['light'] if luminance(tint) >= LIGHT_SPLIT else conf['dark']
    out = [parse_color(c) for c in side.get('colors', [])]
    tokens = side.get('projectTokens', [])
    if tokens:
        cands = []
        for t in tokens:
            c = parse_color(resolve(vars_, t))
            if c[3] < 1:
                raise ConfigError(f'项目色 {t} 不是实色')
            cands.append(c)
        pick = side.get('pick')
        if pick == 'darkest':
            out.append(min(cands, key=luminance))
        elif pick == 'brightest':
            out.append(max(cands, key=luminance))
        else:
            raise ConfigError('backdrops 的 pick 只能是 darkest 或 brightest')
    if not out:
        raise ConfigError('backdrops 至少要有一种底色')
    return out


def surfaces(layers: list[Layer], vars_: dict[str, str], theme: str, conf: dict) -> list[Color]:
    """一个背景（已拆层，第一个在最上面）所有可能的不透明颜色"""
    base_layer, upper = layers[-1], layers[:-1]
    bases: list[Color] = []
    for c in base_layer.stops:
        if c[3] >= 1:
            bases.append(c)
        elif c[3] > 0:
            bases.extend(over(c, b) for b in backdrops_for(c, vars_, theme, conf))
        # 完全透明的色标：露出更下面的东西；最底层没有更下面，只能看其余色标
    if not bases:
        # 整层透明（例如 transparent）：底下是什么不知道，按最坏底色算
        raise ConfigError('最底下一层是完全透明的，没法定底色')
    out = list(bases)
    for layer in reversed(upper):
        add: list[Color] = []
        for c in layer.stops:
            if c[3] <= 0:
                continue
            if c[3] >= 1:
                add.append(c)
            else:
                add.extend(over(c, b) for b in bases)
        out.extend(add)
    return out


def bg_candidates(bg: str | list[str], vars_: dict[str, str], theme: str, conf: dict) -> list[Color]:
    """背景变量（或多层变量，第一个在最上面）所有可能的不透明颜色"""
    names = [bg] if isinstance(bg, str) else list(bg)
    if not names:
        raise ConfigError('bg 是空数组')
    bottom = parse_background(resolve(vars_, names[-1]), names[-1])
    cands = surfaces(bottom, vars_, theme, conf)
    for name in reversed(names[:-1]):
        layers = parse_background(resolve(vars_, name), name)
        nxt: list[Color] = []
        for base in cands:
            for layer in reversed(layers):
                for c in layer.stops:
                    if c[3] > 0:
                        nxt.append(over(c, base))
                    else:
                        nxt.append(base)
        cands = nxt
    return cands


def fg_colors(fg: str, vars_: dict[str, str], theme: str = "") -> list[Color]:
    layers = parse_background(resolve(vars_, fg), fg)
    out = [c for layer in layers for c in layer.stops]
    if any(c[3] <= 0 for c in out):
        raise ConfigError(f'前景 {fg} 是完全透明的')
    return out


# ---------------- 检查 ----------------

def load_pairs(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ConfigError(f'读不了清单 {path}：{e}') from e
    for key in ('thresholds', 'backdrops', 'pairs'):
        if key not in data:
            raise ConfigError(f'清单缺少 {key}')
    ids = set()
    for p in data['pairs']:
        for key in ('id', 'what', 'fg', 'bg', 'kind', 'source'):
            if key not in p:
                raise ConfigError(f'清单第 {len(ids) + 1} 项缺少 {key}')
        if p['id'] in ids:
            raise ConfigError(f'清单 id 重复：{p["id"]}')
        ids.add(p['id'])
        if p['kind'] not in data['thresholds']:
            raise ConfigError(f'{p["id"]}：类别 {p["kind"]} 没有门槛')
        for m in p.get('modes', ['light', 'dark']):
            if m not in ('light', 'dark'):
                raise ConfigError(f'{p["id"]}：modes 只能是 light、dark')
        # 可选 themes：只在这几套里查（如只有“简洁·浅色”画今天的细圈，别的皮肤是 transparent；设计复审 N7）
        th = p.get('themes')
        if th is not None and (not isinstance(th, list) or not th or not all(isinstance(x, str) for x in th)):
            raise ConfigError(f'{p["id"]}：themes 要是非空的字符串数组，如 ["simple-light"]')
    acc = data.get('accepted', [])
    if not isinstance(acc, list):
        raise ConfigError('accepted 要是数组')
    seen: set[tuple[str, str]] = set()
    for i, a in enumerate(acc, 1):
        if not isinstance(a, dict):
            raise ConfigError(f'accepted 第 {i} 条不是对象')
        for key in ('theme', 'id', 'decided', 'reason'):
            if not isinstance(a.get(key), str) or not a[key].strip():
                raise ConfigError(f'accepted 第 {i} 条缺少 {key}（要写非空的文字）')
        if not isinstance(a.get('floor'), (int, float)) or isinstance(a.get('floor'), bool):
            raise ConfigError(f'accepted 第 {i} 条缺少 floor（接受时的精确值）')
        if a['id'] not in ids:
            raise ConfigError(f'accepted 第 {i} 条：清单里没有 {a["id"]}')
        k = (a['theme'], a['id'])
        if k in seen:
            raise ConfigError(f'accepted 重复：{a["theme"]} {a["id"]}')
        seen.add(k)
    return data


def worst_of(p: dict, vars_: dict[str, str], theme: str, conf: dict) -> tuple[float, Color, Color]:
    """一项在一套皮肤里最低的对比度和那一组颜色（前景、背景都已叠成不透明色）"""
    bgs = bg_candidates(p["bg"], vars_, theme, conf)
    worst = None
    for f in fg_colors(p["fg"], vars_, theme):
        for b in bgs:
            fc = over(f, b) if f[3] < 1 else f
            r = ratio(fc, b)
            if worst is None or r < worst[0]:
                worst = (r, fc, b)
    if worst is None:
        raise ConfigError('没有可比的颜色')
    return worst


def check(themes: dict[str, dict[str, str]], data: dict) -> list[dict]:
    # themes 里的皮肤名要真的存在：写错（如 simple-lite）不能悄悄跳过、等于这一项哪儿都不查（代码复审 R3）
    accepted = {(a['theme'], a['id']): a for a in data.get('accepted', [])}
    for theme, _ in accepted:
        if theme not in themes:
            raise ConfigError(f'accepted 里的皮肤不存在：{theme}（现有：{"、".join(sorted(themes))}）')
    for p in data['pairs']:
        unknown = sorted(set(p.get('themes', [])) - set(themes))
        if unknown:
            raise ConfigError(f'{p["id"]}：themes 里的皮肤不存在：{"、".join(unknown)}（现有：{"、".join(sorted(themes))}）')
    results = []
    for theme in sorted(themes):
        vars_ = themes[theme]
        mode = theme.rsplit('-', 1)[1]
        for p in data['pairs']:
            if mode not in p.get('modes', ['light', 'dark']):
                continue
            if 'themes' in p and theme not in p['themes']:
                continue
            try:
                need = float(data['thresholds'][p['kind']]['min'])
                r, fc, b = worst_of(p, vars_, theme, data["backdrops"])
            except ConfigError as e:
                raise ConfigError(f'{theme} {p["id"]}：{e}') from e
            except Exception as e:  # 脚本自己的毛病也归 2，并报出是哪一套哪一项（代码审查 M2）
                raise ConfigError(f'{theme} {p["id"]}：内部错误 {type(e).__name__}: {e}') from e
            results.append({
                'theme': theme,
                'id': p['id'],
                'what': p['what'],
                'kind': p['kind'],
                'min': need,
                'ratio': round(r, 2),
                'exact': r,
                'fg': to_hex(fc),
                'bg': to_hex(b),
                # 按精确值判定，不先取整（WCAG 2.x；代码审查 M4）：4.495 判不过
                'ok': r >= need,
                'accepted': False,
            })
            a = accepted.get((theme, p['id']))
            if a is None:
                continue
            if r >= need:
                raise ConfigError(f'{theme} {p["id"]}：已经达标（{r:.4f} ≥ {need:g}），从 accepted 里删掉这条例外')
            # floor 必须正好是现在的精确值向下截断到 4 位（代码复审 M5）：变好变坏都要改名单，名单不能写个宽松的数糊过去
            want = math.floor(r * 10000) / 10000
            if abs(float(a['floor']) - want) > 1e-9:
                raise ConfigError(f'{theme} {p["id"]}：accepted 的 floor 是 {a["floor"]}，现在的精确值截断到 4 位是 {want:.4f}；'
                                  '颜色变了要重新请负责人定，名单照新值改')
            results[-1]['accepted'] = True
            results[-1]['decided'] = a['decided']
            results[-1]['floor'] = float(a['floor'])
    done = {(r['theme'], r['id']) for r in results}
    for k in accepted:
        if k not in done:
            raise ConfigError(f'accepted 里的 {k[0]} {k[1]} 没有算到（这套皮肤不查这一项），删掉这条例外')
    return results


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='皮肤对比度检查（架构 8.1）')
    ap.add_argument('--root', default=str(ROOT))
    ap.add_argument('--pairs', default=None, help='默认 <root>/build/contrast-pairs.json')
    ap.add_argument('--skins', default=None, help='默认 <root>/src/styles/skins')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    args = ap.parse_args(argv)
    root = pathlib.Path(args.root)
    pairs_path = pathlib.Path(args.pairs) if args.pairs else root / 'build' / 'contrast-pairs.json'
    skins_dir = pathlib.Path(args.skins) if args.skins else root / 'src' / 'styles' / 'skins'
    out = sys.stdout
    try:
        out.reconfigure(encoding='utf-8')  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    try:
        data = load_pairs(pairs_path)
        themes = load_skins(skins_dir)
        results = check(themes, data)
    except Exception as e:  # ConfigError 照原文报；其余异常算内部错误，也归 2（退出码 1 只留给真的不达标）
        msg = str(e) if isinstance(e, ConfigError) else f'内部错误：{type(e).__name__}: {e}'
        if args.json:
            out.write(json.dumps({'error': msg}, ensure_ascii=False) + '\n')
        else:
            out.write(f'check_contrast：{msg}\n')
        return 2
    bad = [r for r in results if not r['ok'] and not r['accepted']]
    ok_exc = [r for r in results if r['accepted']]
    if args.json:
        out.write(json.dumps({'themes': sorted(themes), 'results': results, 'failed': len(bad), 'accepted': len(ok_exc)},
                             ensure_ascii=False, indent=1) + '\n')
    else:
        for r in bad:
            shown = math.floor(r['exact'] * 10000) / 10000  # 向下截断到 4 位：不会显示成“4.50 < 4.5”
            worse = f'，比接受时的 {r["floor"]:.4f} 还低' if 'floor' in r else ''
            out.write(f'不达标 {r["theme"]} {r["id"]}（{r["what"]}）：{shown:.4f} < {r["min"]:g}'
                      f'（{r["fg"]} / {r["bg"]}{worse}）\n')
        for r in ok_exc:
            shown = math.floor(r['exact'] * 10000) / 10000
            out.write(f'已接受的例外 {r["theme"]} {r["id"]}：{shown:.4f} < {r["min"]:g}（{r["decided"]}）\n')
        out.write(f'check_contrast：{len(themes)} 套 × 清单 {len(data["pairs"])} 项，共算 {len(results)} 次，'
                  f'不达标 {len(bad)} 次，已接受的例外 {len(ok_exc)} 次\n')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
