# 可选字体（架构 5.9c，R-128、R-135；B6 字体 11-13）：按登记把源字体切成 woff2 分片，生成网页用的样式和清单；--check 是 check_fonts。
#
# 登记：assets-src/fonts/<id>/font.json 和许可证原文（文件夹和登记一一对应，加一种字体 = 放源文件 + 写 font.json + 跑本脚本）。
# 源字体文件不进仓库（B6 字体 11-14 主持人定：三种字体源文件一百多 MB，.gitignore 拦着）：本机放在 柠檬记APP-本机资料\字体源\<id>\，
#   构建时 --src 指过去（不写 --src 就在登记文件夹里找，测试用的迷你仓库这样放）；font.json 里登记下载地址、版本、sha256，构建前逐个核对。
#   --check 在没有源文件的机器（CI）上也要能过：源文件不在就跳过源文件那几条（sha256、常用字覆盖），只核对产物和登记——
#   清单里记着切片用的源文件 sha256（sources），和登记对不上说明换了源文件没重新切。
#   {"id": "kai", "label": {"zh": "文楷", "ko": "원카이"}, "num": "manrope" | "zh" | "ko", "order": 3,
#    "faces": {"zh": [{"file": "LXGWWenKai-Regular.ttf", "weight": "100 499"}, ...], "ko": [...]},
#    "licenses": [{"name": "霞鹜文楷", "spdx": "OFL-1.1", "file": "OFL.txt", "sourceUrl": "...", "version": "...",
#                  "sha256": {"<源文件名>": "<sha256>"}, "reservedNames": ["..."]}, ...]}
#   weight 是这个文件管的 CSS 字重范围（@font-face 的 font-weight 区间），每面最多 3 个文件；样式里写 font-synthesis: none，不做假粗体。
#   prefetch（可不写，默认 true）：false 的字重常用字也不预取，只按 unicode-range 用到才下（只有个别地方用的字重，例如细线黑日期大标题的 ExtraLight）。
#   num：数字用哪套——manrope（不换，系统字体同款）、zh / ko（跟这一面走）。
#   order（可不写，默认 99）：设置 › 字体里的先后（视觉稿 sFont：细线黑、悠哉体、文楷），同序按 id。
#   licenses：一种字体的中韩两面常是两个项目、两份许可证（B6 字体 11-14 细线黑 = 未来荧黑 + Pretendard），所以按项目列；
#   每个源文件只在一项的 sha256 里出现。这份登记同时是 build/gen_licenses.mjs 写进 /app/licenses.txt 的字体许可来源。
#   reservedNames：许可证里的保留字体名（OFL 第 3 条：修改版不准用保留名，子集也算修改版）。写了的，切出来的分片名字表只留版权、商标、
#   厂商、设计师、许可证几项（OFL 第 2 条要求随字体带版权和许可证），字体名一律改成 lemo-<id>-<面>；--check 核对分片里不再出现保留名。
# 产物（提交进仓库，--check 核对）：src/public/fonts/<id>/<面>-<字重序号>-<n>.<哈希>.woff2、fonts.<哈希>.css；
#   src/public/fonts-index.json：给 platform/fonts.ts 的清单（显示名、样式地址、确认用的中韩 family 和样例字、预取分片的地址和 sha256、
#   这种字体的全部文件地址 files——换字体一天后清 SW 缓存时按它留）。
#   样式里 :root[data-font="<id>"] 换掉 --f-zh、--f-ko（--f-num 按 num），后面接 src/styles/tokens.css 里原来的系统字体栈。
#   中文面后面接同一套的韩文面、韩文面后面接同一套的中文面（2.4 第 7 点）：中文界面里的谚文（未来荧黑没有谚文）也用这一套的韩文字体，不掉回系统字体。
# 分片：先把常用字（中文 GB 2312 一级 3755 字、韩文 KS X 1001 的 2350 个音节，加上 ASCII 和常用标点）切成预取分片，选中就下载进 SW 缓存，
#   离线也能显示；其余的字按码位切片，用 unicode-range 让浏览器只下页面上真出现的那几片。
#   每片先按 CHUNK 字数切，切出来超过单片上限的（字形复杂的手写体）对半再切，直到不超。
# check_fonts（--check）：许可证在白名单、许可证文件在；源文件在本机的，sha256 和登记一致、中文面覆盖 GB 2312 全部、韩文面覆盖 2350 个音节；
#   清单里的源文件 sha256 和登记一致；
#   产物和登记一致（每种登记的字体都在清单里、清单里的文件都在且哈希对、files 和文件夹里的文件一一对上、没有多余的文件夹）；单个分片 ≤ 300 KB、每种预取合计 ≤ 6 MB、
#   样式 brotli 压缩后 ≤ 64 KB；
#   写了 reservedNames 的源文件切出的分片，字体名里没有保留名。
# 用法：python -I build/fonts.py [--root <目录>] [--src <源文件目录，下面按 id 分文件夹>] [--check]
#   例：python -I build/fonts.py --src "D:/claude code/柠檬记APP-本机资料/字体源"
import hashlib
import io
import json
import re
import sys
from pathlib import Path

SPDX_OK = {'OFL-1.1', 'Apache-2.0'}
MAX_SHARD = 300 * 1024
MAX_PREFETCH = 6 * 1024 * 1024
# 样式不是分片：unicode-range 要逐个列出散落在码位表里的常用字，原文一两百 KB 很正常，但重复多、压缩率高（细线黑 376 KB 原文 → brotli 约 25 KB）；
# 按 brotli 压缩后的大小限（Cloudflare 对 text/css 按 br 发），冷启动每次都要先读它
MAX_CSS_BR = 64 * 1024
CHUNK = {'zh': 500, 'ko': 800}
SAMPLE = {'zh': '永和九年 今天日程', 'ko': '한글 오늘 일정'}
ID_RE = re.compile(r'^[a-z][a-z0-9]{0,15}$')
WEIGHT_RE = re.compile(r'^[1-9][0-9]{2}( [1-9][0-9]{2})?$')


def gb2312(level1_only):
    out = set()
    for b1 in range(0xB0, 0xD8 if level1_only else 0xF8):
        for b2 in range(0xA1, 0xFF):
            try:
                out.add(ord(bytes([b1, b2]).decode('gb2312')))
            except UnicodeDecodeError:
                pass
    return out


def ksx1001_hangul():
    out = set()
    for b1 in range(0xB0, 0xC9):
        for b2 in range(0xA1, 0xFF):
            try:
                out.add(ord(bytes([b1, b2]).decode('euc_kr')))
            except UnicodeDecodeError:
                pass
    return out


BASIC = set(range(0x20, 0x7F)) | set(range(0x3000, 0x3020)) | set(range(0xFF01, 0xFF5F)) | {0x2014, 0x2026, 0x2018, 0x2019, 0x201C, 0x201D, 0x00B7}
COMMON = {'zh': lambda: BASIC | gb2312(True), 'ko': lambda: BASIC | ksx1001_hangul()}
COVER = {'zh': lambda: gb2312(False), 'ko': ksx1001_hangul}


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def load_registry(root, src_base, need_src, errors):
    regs = []
    base = root / 'assets-src' / 'fonts'
    for d in sorted(p for p in base.iterdir() if p.is_dir()) if base.is_dir() else []:
        f = d / 'font.json'
        if not f.is_file():
            errors.append(f'{d.name}：文件夹里没有 font.json（每个文件夹都要有登记）')
            continue
        r = json.loads(f.read_text(encoding='utf-8'))
        rid = r.get('id')
        if rid != d.name or not ID_RE.match(str(rid)) or rid == 'system':
            errors.append(f'{d.name}：id 要和文件夹同名、小写字母数字、不能叫 system')
            continue
        lab = r.get('label', {})
        if not (isinstance(lab.get('zh'), str) and isinstance(lab.get('ko'), str)):
            errors.append(f'{rid}：label 要有 zh、ko')
        if r.get('num') not in ('manrope', 'zh', 'ko'):
            errors.append(f'{rid}：num 只能是 manrope、zh、ko')
        lics = r.get('licenses')
        if not isinstance(lics, list) or not lics:
            errors.append(f'{rid}：licenses 要写成列表，每个字体项目一项')
            lics = []
        sums = {}
        for lic in lics:
            if lic.get('spdx') not in SPDX_OK:
                errors.append(f'{rid}：许可证 {lic.get("spdx")} 不在白名单 {sorted(SPDX_OK)}')
            if not (d / str(lic.get('file', ''))).is_file():
                errors.append(f'{rid}：许可证文件 {lic.get("file")} 不在')
            for k in ('name', 'sourceUrl', 'version'):
                if not isinstance(lic.get(k), str) or not lic.get(k):
                    errors.append(f'{rid}：licenses[].{k} 没写')
            rn = lic.get('reservedNames', [])
            if not (isinstance(rn, list) and all(isinstance(x, str) and x for x in rn)):
                errors.append(f'{rid}：licenses[].reservedNames 要是字符串列表')
            for name, h in lic.get('sha256', {}).items():
                if name in sums:
                    errors.append(f'{rid}：{name} 在两项许可证里都登记了')
                sums[name] = h
        if not isinstance(r.get('order', 99), int):
            errors.append(f'{rid}：order 要是整数')
        faces = r.get('faces', {})
        if set(faces) != {'zh', 'ko'}:
            errors.append(f'{rid}：faces 要有 zh、ko 两面')
            continue
        for face, items in faces.items():
            if not 1 <= len(items) <= 3:
                errors.append(f'{rid}.{face}：每面 1～3 个字重文件')
            for it in items:
                src = (src_base or base) / rid / it.get('file', '')
                if it.get('file') not in sums:
                    errors.append(f'{rid}.{face}：{it.get("file")} 没在任何一项许可证的 sha256 里登记')
                if not WEIGHT_RE.match(str(it.get('weight', ''))):
                    errors.append(f'{rid}.{face}：weight 写成 "400" 或 "100 499"')
                if not isinstance(it.get('prefetch', True), bool):
                    errors.append(f'{rid}.{face}：prefetch 只能是 true / false')
                if not src.is_file():
                    # 构建要源文件；只核对（CI 没有源文件）跳过这一条，产物和登记的对应靠清单里的 sources
                    if need_src:
                        errors.append(f'{rid}.{face}：源文件 {src} 不在（源文件不进仓库，本机放 柠檬记APP-本机资料/字体源/{rid}/，--src 指过去）')
                elif sums.get(src.name) != sha256(src.read_bytes()):
                    errors.append(f'{rid}.{face}：{src.name} 的 sha256 和登记不一致（换了文件要改登记）')
        regs.append((d, r))
    regs.sort(key=lambda x: (x[1].get('order', 99), x[1]['id']))
    return regs


def ranges(cps):
    cps = sorted(cps)
    out, start, prev = [], None, None
    for c in cps:
        if start is None:
            start = prev = c
        elif c == prev + 1:
            prev = c
        else:
            out.append((start, prev))
            start = prev = c
    if start is not None:
        out.append((start, prev))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def chunks(cps, n):
    s = sorted(cps)
    return [s[i:i + n] for i in range(0, len(s), n)]


def font_stacks(root):
    css = (root / 'src' / 'styles' / 'tokens.css').read_text(encoding='utf-8')
    return {k: re.search(r'--f-' + k + r':([^;}]+)', css).group(1).strip() for k in ('zh', 'ko', 'num')}


def sums_of(r):
    """源文件名 → 登记的 sha256"""
    return {name: h for lic in r.get('licenses', []) for name, h in lic.get('sha256', {}).items()}


def reserved_of(r):
    """源文件名 → 它那份许可证的保留字体名"""
    return {name: lic.get('reservedNames', []) for lic in r.get('licenses', []) for name in lic.get('sha256', {})}


# 改名时留下的名字表项：版权 0、商标 7、厂商 8、设计师 9、厂商网址 11、设计师网址 12、许可证 13、许可证网址 14（OFL 第 2 条）
KEEP_NAME_IDS = {0, 7, 8, 9, 11, 12, 13, 14}
# 核对时看的“字体名”项：家族 1、唯一标识 3、全名 4、PostScript 名 6、排版家族 16 / 17、兼容全名 18、WWS 21 / 22、可变前缀 25
FONT_NAME_IDS = {1, 3, 4, 6, 16, 17, 18, 21, 22, 25}


def rename(f, fam, wi):
    ps = f'{fam}-{wi}'
    nm = f['name']
    nm.names = [n for n in nm.names if n.nameID in KEEP_NAME_IDS]
    for nid, val in ((1, fam), (2, 'Regular'), (3, ps), (4, ps), (6, ps)):
        nm.setName(val, nid, 3, 1, 0x409)


def font_names(f):
    return [n.toUnicode() for n in f['name'].names if n.nameID in FONT_NAME_IDS]


def cff_to_glyf(f):
    """CFF（PostScript）轮廓转成 TrueType 轮廓（cu2qu，误差 1 个字体单位，fontmake 的同一做法）。
    woff2 对 glyf 有专门的压缩变换、对 CFF 没有：11-14 细线黑实测未来荧黑 ExtraLight 同样 300 个常用字，CFF 339 KB、转完 53 KB
    （原样切每 500 字 320～457 KB，超过分片上限，全套 91 MB）。转了以后分片里就没有 CFF，改名只管 name 表"""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import newTable

    order = f.getGlyphOrder()
    gs = f.getGlyphSet()
    glyf = newTable('glyf')
    glyf.glyphOrder = order
    glyf.glyphs = {}
    for g in order:
        pen = TTGlyphPen(None)
        gs[g].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyf.glyphs[g] = pen.glyph()
    for tag in ('CFF ', 'VORG'):
        if tag in f:
            del f[tag]
    f['glyf'] = glyf
    f['loca'] = newTable('loca')
    # maxp 1.0（TrueType 用）：各项保存时按轮廓重算
    f['maxp'].tableVersion = 0x00010000
    for k in ('maxZones', 'maxTwilightPoints', 'maxStorage', 'maxFunctionDefs', 'maxInstructionDefs', 'maxStackElements', 'maxSizeOfInstructions',
              'maxComponentElements', 'maxPoints', 'maxContours', 'maxCompositePoints', 'maxCompositeContours', 'maxComponentDepth'):
        setattr(f['maxp'], k, 0)
    f['maxp'].maxZones = 1
    f['head'].indexToLocFormat = 0
    f['head'].glyphDataFormat = 0
    f['post'].formatType = 3.0
    f.sfntVersion = '\x00\x01\x00\x00'


def cut(raw, cps, rename_to):
    """从内存里的整套 TTF 切出这些码位的 woff2；rename_to=(family, 字重序号) 时改名（保留字体名）"""
    from fontTools.subset import Options, Subsetter
    from fontTools.ttLib import TTFont

    opt = Options()
    opt.flavor = 'woff2'
    opt.layout_features = ['*']
    opt.name_IDs = ['*']
    f = TTFont(io.BytesIO(raw), recalcTimestamp=False)
    sub = Subsetter(opt)
    sub.populate(unicodes=cps)
    sub.subset(f)
    if rename_to:
        rename(f, *rename_to)
    buf = io.BytesIO()
    f.save(buf)
    return buf.getvalue()


def build_one(root, srcdir, r, stacks):
    from fontTools.ttLib import TTFont

    reserved = reserved_of(r)
    rid = r['id']
    out = root / 'src' / 'public' / 'fonts' / rid
    if out.is_dir():
        for p in out.iterdir():
            p.unlink()
    out.mkdir(parents=True, exist_ok=True)
    rules, prefetch, files, total = [], [], [], 0
    for face, items in r['faces'].items():
        fam = f'lemo-{rid}-{face}'
        for wi, it in enumerate(items):
            src = srcdir / it['file']
            # 源文件只解一次（woff2 解压最慢），每片从内存里的 TTF 重新读
            # recalcTimestamp=False：保存时不把 head.modified 改成现在，同样的源文件每次切出一模一样的分片（11-14 实测不关的话每跑一次几百个文件全换名）
            whole = TTFont(src, recalcTimestamp=False)
            have = set(whole.getBestCmap())
            if 'CFF ' in whole:
                cff_to_glyf(whole)
            whole.flavor = None
            raw = io.BytesIO()
            whole.save(raw)
            common = have & COMMON[face]()
            # prefetch: false 的字重（细线黑的 ExtraLight 只有日期大标题用）常用字也不预取，全部按 unicode-range 用到才下
            pre = it.get('prefetch', True)
            groups = [(c, pre) for c in chunks(common, CHUNK[face])] + [(c, False) for c in chunks(have - common, CHUNK[face])]

            # 字形复杂的字体（11-14 悠哉字体每 500 字 300 KB 上下）一片超过上限就对半再切，直到不超；每片字数不按字体单独调
            n = 0
            while groups:
                cps, pre = groups.pop(0)
                b = cut(raw.getvalue(), cps, (fam, wi) if reserved.get(src.name) else None)
                if len(b) > MAX_SHARD and len(cps) > 1:
                    groups[:0] = [(cps[: len(cps) // 2], pre), (cps[len(cps) // 2 :], pre)]
                    continue
                name = f'{face}-{wi}-{n}.{sha256(b)[:10]}.woff2'
                n += 1
                (out / name).write_bytes(b)
                files.append(f'/app/fonts/{rid}/{name}')
                total += len(b)
                if pre:
                    prefetch.append({'url': f'/app/fonts/{rid}/{name}', 'sha256': sha256(b), 'bytes': len(b)})
                rules.append(
                    f'@font-face{{font-family:"{fam}";src:url("./{name}") format("woff2");font-weight:{it["weight"]};'
                    f'font-style:normal;font-display:swap;unicode-range:{ranges(cps)}}}'
                )
    num = {'manrope': '', 'zh': f'--f-num:"lemo-{rid}-zh",{stacks["num"]};', 'ko': f'--f-num:"lemo-{rid}-ko",{stacks["num"]};'}[r['num']]
    rules.append(
        f':root[data-font="{rid}"]{{font-synthesis:none;--f-zh:"lemo-{rid}-zh","lemo-{rid}-ko",{stacks["zh"]};'
        f'--f-ko:"lemo-{rid}-ko","lemo-{rid}-zh",{stacks["ko"]};{num}}}'
    )
    css = ('/* 由 build/fonts.py 生成，别手改（架构 5.9c） */\n' + '\n'.join(rules) + '\n').encode('utf-8')
    css_name = f'fonts.{sha256(css)[:10]}.css'
    (out / css_name).write_bytes(css)
    return {
        'id': rid,
        'label': r['label'],
        'css': f'/app/fonts/{rid}/{css_name}',
        'family': f'lemo-{rid}-zh',
        'sample': SAMPLE['zh'],
        'familyKo': f'lemo-{rid}-ko',
        'sampleKo': SAMPLE['ko'],
        'prefetch': prefetch,
        'files': [f'/app/fonts/{rid}/{css_name}'] + files,
        'bytes': {'prefetch': sum(p['bytes'] for p in prefetch), 'all': total},
        # 切片用的源文件 sha256：源文件不进仓库，--check 靠它核对产物是不是按现在的登记切的
        'sources': {it['file']: sha256((srcdir / it['file']).read_bytes()) for items in r['faces'].values() for it in items},
    }


def index_text(fonts):
    return json.dumps({'_说明': '由 build/fonts.py 生成，别手改（架构 5.9c）', 'v': 1, 'fonts': fonts}, ensure_ascii=False, indent=1) + '\n'


def check_cover(src_base, regs, errors):
    """源文件在本机的，核常用字覆盖（--check 跑；CI 没有源文件就不跑，切完在本机跑一次 --check --src 核）"""
    for d, r in regs:
        for face, items in r['faces'].items():
            need = COVER[face]()
            for it in items:
                src = (src_base or d.parent) / r['id'] / it['file']
                if src.is_file():
                    from fontTools.ttLib import TTFont

                    miss = need - set(TTFont(src, lazy=True).getBestCmap())
                    if miss:
                        errors.append(f'{r["id"]}.{face}：{src.name} 缺 {len(miss)} 个常用字（中文要 GB 2312 全部、韩文要 2350 个音节），例如 {"".join(chr(c) for c in sorted(miss)[:5])}')


def check(root, src_base, regs, errors):
    check_cover(src_base, regs, errors)
    idx_path = root / 'src' / 'public' / 'fonts-index.json'
    if not idx_path.is_file():
        errors.append('src/public/fonts-index.json 不在：跑 python -I build/fonts.py')
        return
    idx = json.loads(idx_path.read_text(encoding='utf-8'))
    listed = {f['id']: f for f in idx.get('fonts', [])}
    if set(listed) != {r['id'] for _, r in regs}:
        errors.append(f'fonts-index.json 里的字体 {sorted(listed)} 和登记 {sorted(r["id"] for _, r in regs)} 不一致：跑 python -I build/fonts.py')
    pub = root / 'src' / 'public' / 'fonts'
    for d in sorted(p for p in pub.iterdir() if p.is_dir()) if pub.is_dir() else []:
        if d.name not in listed:
            errors.append(f'src/public/fonts/{d.name} 没有登记，删掉或补登记')
    regs_by_id = {r['id']: r for _, r in regs}
    for rid, f in listed.items():
        r = regs_by_id.get(rid)
        if r is not None:
            sums = sums_of(r)
            want = {it['file']: sums.get(it['file']) for items in r['faces'].values() for it in items}
            if f.get('sources') != want:
                errors.append(f'{rid}：清单里切片用的源文件 {f.get("sources")} 和登记的源文件、sha256 对不上：换了源文件要重新切（python -I build/fonts.py --src ...）')
        files = {p.name: p for p in (pub / rid).iterdir()} if (pub / rid).is_dir() else {}
        if f['css'].rsplit('/', 1)[-1] not in files:
            errors.append(f'{rid}：样式 {f["css"]} 不在')
        for p in files.values():
            if p.suffix == '.css':
                import brotli

                br = len(brotli.compress(p.read_bytes(), quality=11))
                if br > MAX_CSS_BR:
                    errors.append(f'{rid}：样式 {p.name} 压缩后 {br} B 超过上限 {MAX_CSS_BR} B')
            elif p.stat().st_size > MAX_SHARD:
                errors.append(f'{rid}：{p.name} {p.stat().st_size} B 超过单个分片上限 {MAX_SHARD} B')
        for p in f['prefetch']:
            q = files.get(p['url'].rsplit('/', 1)[-1])
            if q is None or sha256(q.read_bytes()) != p['sha256']:
                errors.append(f'{rid}：预取分片 {p["url"]} 不在或哈希不对')
        # files 是缓存清理时“当前字体留哪些”的依据：和文件夹一一对上，少了会被误删、多了说明清单旧了
        listed_files = {u.rsplit('/', 1)[-1] for u in f.get('files', [])}
        if listed_files != set(files):
            errors.append(f'{rid}：清单 files 和文件夹对不上（少 {sorted(set(files) - listed_files)[:3]}，多 {sorted(listed_files - set(files))[:3]}）：跑 python -I build/fonts.py')
        if f['bytes']['prefetch'] > MAX_PREFETCH:
            errors.append(f'{rid}：预取合计 {f["bytes"]["prefetch"]} B 超过 {MAX_PREFETCH} B')
    # 保留字体名（OFL 第 3 条）：写了 reservedNames 的源文件，切出的每个分片字体名里都不能再有保留名
    for d, r in regs:
        reserved = reserved_of(r)
        for face, items in r['faces'].items():
            for wi, it in enumerate(items):
                bad = [x.lower() for x in reserved.get(it.get('file', ''), [])]
                if not bad or not (pub / r['id']).is_dir():
                    continue
                from fontTools.ttLib import TTFont

                for p in sorted((pub / r['id']).glob(f'{face}-{wi}-*.woff2')):
                    hit = [n for n in font_names(TTFont(p, lazy=True)) if any(b in n.lower() for b in bad)]
                    if hit:
                        errors.append(f'{r["id"]}：{p.name} 的字体名还带着保留名 {hit[:2]}（OFL 第 3 条，子集要改名）：跑 python -I build/fonts.py')


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    root = Path(argv[argv.index('--root') + 1]) if '--root' in argv else Path(__file__).resolve().parent.parent
    src_base = Path(argv[argv.index('--src') + 1]) if '--src' in argv else None
    errors = []
    regs = load_registry(root, src_base, '--check' not in argv, errors)
    if '--check' in argv:
        if not errors:
            check(root, src_base, regs, errors)
        for e in errors:
            print('字体检查：' + e)
        print(f'字体检查：登记 {len(regs)} 种，问题 {len(errors)} 个')
        return 1 if errors else 0
    if errors:
        for e in errors:
            print('字体登记有问题：' + e)
        return 1
    stacks = font_stacks(root)
    fonts = [build_one(root, (src_base or d.parent) / r['id'], r, stacks) for d, r in regs]
    pub = root / 'src' / 'public'
    pub.mkdir(parents=True, exist_ok=True)
    (pub / 'fonts-index.json').write_bytes(index_text(fonts).encode('utf-8'))
    for f in fonts:
        print(f'{f["id"]}：预取 {f["bytes"]["prefetch"]} B，全部 {f["bytes"]["all"]} B，{len(f["prefetch"])} 个预取分片')
    print(f'字体：{len(fonts)} 种，写了 src/public/fonts-index.json')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
