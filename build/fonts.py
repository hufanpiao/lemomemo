# 可选字体（架构 5.9c，R-128、R-135；B6 字体 11-13）：按登记把源字体切成 woff2 分片，生成网页用的样式和清单；--check 是 check_fonts。
#
# 登记：assets-src/fonts/<id>/font.json，和源字体文件、许可证放同一个文件夹（文件夹和登记一一对应，加一种字体 = 放文件 + 写 font.json + 跑本脚本）。
#   {"id": "kai", "label": {"zh": "文楷", "ko": "손글씨"}, "num": "manrope" | "zh" | "ko",
#    "faces": {"zh": [{"file": "LXGWWenKai-Regular.ttf", "weight": "100 499"}, ...], "ko": [...]},
#    "license": {"spdx": "OFL-1.1", "file": "OFL.txt", "sourceUrl": "...", "version": "...", "sha256": {"<源文件名>": "<sha256>"}}}
#   weight 是这个文件管的 CSS 字重范围（@font-face 的 font-weight 区间），每面最多 3 个文件；样式里写 font-synthesis: none，不做假粗体。
#   num：数字用哪套——manrope（不换，系统字体同款）、zh / ko（跟这一面走）。
# 产物（提交进仓库，--check 核对）：src/public/fonts/<id>/<面>-<字重序号>-<n>.<哈希>.woff2、fonts.<哈希>.css；
#   src/public/fonts-index.json：给 platform/fonts.ts 的清单（显示名、样式地址、确认用的中韩 family 和样例字、预取分片的地址和 sha256、
#   这种字体的全部文件地址 files——换字体一天后清 SW 缓存时按它留）。
#   样式里 :root[data-font="<id>"] 换掉 --f-zh、--f-ko（--f-num 按 num），后面接 src/styles/tokens.css 里原来的系统字体栈。
# 分片：先把常用字（中文 GB 2312 一级 3755 字、韩文 KS X 1001 的 2350 个音节，加上 ASCII 和常用标点）切成预取分片，选中就下载进 SW 缓存，
#   离线也能显示；其余的字按码位切片，用 unicode-range 让浏览器只下页面上真出现的那几片。
# check_fonts（--check）：许可证在白名单、许可证文件在；源文件 sha256 和登记一致；中文面覆盖 GB 2312 全部、韩文面覆盖 2350 个音节；
#   产物和登记一致（每种登记的字体都在清单里、清单里的文件都在且哈希对、files 和文件夹里的文件一一对上、没有多余的文件夹）；单个分片 ≤ 300 KB、每种预取合计 ≤ 6 MB。
# 用法：python -I build/fonts.py [--root <目录>] [--check]
import hashlib
import io
import json
import re
import sys
from pathlib import Path

SPDX_OK = {'OFL-1.1', 'Apache-2.0'}
MAX_SHARD = 300 * 1024
MAX_PREFETCH = 6 * 1024 * 1024
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


def load_registry(root, errors):
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
        lic = r.get('license', {})
        if lic.get('spdx') not in SPDX_OK:
            errors.append(f'{rid}：许可证 {lic.get("spdx")} 不在白名单 {sorted(SPDX_OK)}')
        if not (d / str(lic.get('file', ''))).is_file():
            errors.append(f'{rid}：许可证文件 {lic.get("file")} 不在')
        for k in ('sourceUrl', 'version'):
            if not isinstance(lic.get(k), str) or not lic.get(k):
                errors.append(f'{rid}：license.{k} 没写')
        sums = lic.get('sha256', {})
        faces = r.get('faces', {})
        if set(faces) != {'zh', 'ko'}:
            errors.append(f'{rid}：faces 要有 zh、ko 两面')
            continue
        for face, items in faces.items():
            if not 1 <= len(items) <= 3:
                errors.append(f'{rid}.{face}：每面 1～3 个字重文件')
            for it in items:
                src = d / it.get('file', '')
                if not WEIGHT_RE.match(str(it.get('weight', ''))):
                    errors.append(f'{rid}.{face}：weight 写成 "400" 或 "100 499"')
                if not src.is_file():
                    errors.append(f'{rid}.{face}：源文件 {it.get("file")} 不在')
                elif sums.get(src.name) != sha256(src.read_bytes()):
                    errors.append(f'{rid}.{face}：{src.name} 的 sha256 和登记不一致（换了文件要改登记）')
        regs.append((d, r))
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


def build_one(root, d, r, stacks):
    from fontTools.subset import Options, Subsetter
    from fontTools.ttLib import TTFont

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
            src = d / it['file']
            # 源文件只解一次（woff2 解压最慢），每片从内存里的 TTF 重新读
            whole = TTFont(src)
            have = set(whole.getBestCmap())
            whole.flavor = None
            raw = io.BytesIO()
            whole.save(raw)
            common = have & COMMON[face]()
            groups = [(c, True) for c in chunks(common, CHUNK[face])] + [(c, False) for c in chunks(have - common, CHUNK[face])]
            for n, (cps, pre) in enumerate(groups):
                opt = Options()
                opt.flavor = 'woff2'
                opt.layout_features = ['*']
                opt.name_IDs = ['*']
                f = TTFont(io.BytesIO(raw.getvalue()))
                sub = Subsetter(opt)
                sub.populate(unicodes=cps)
                sub.subset(f)
                buf = io.BytesIO()
                f.save(buf)
                b = buf.getvalue()
                name = f'{face}-{wi}-{n}.{sha256(b)[:10]}.woff2'
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
        f':root[data-font="{rid}"]{{font-synthesis:none;--f-zh:"lemo-{rid}-zh",{stacks["zh"]};'
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
    }


def index_text(fonts):
    return json.dumps({'_说明': '由 build/fonts.py 生成，别手改（架构 5.9c）', 'v': 1, 'fonts': fonts}, ensure_ascii=False, indent=1) + '\n'


def check(root, regs, errors):
    for d, r in regs:
        for face, items in r['faces'].items():
            need = COVER[face]()
            for it in items:
                src = d / it['file']
                if src.is_file():
                    from fontTools.ttLib import TTFont

                    miss = need - set(TTFont(src, lazy=True).getBestCmap())
                    if miss:
                        errors.append(f'{r["id"]}.{face}：{src.name} 缺 {len(miss)} 个常用字（中文要 GB 2312 全部、韩文要 2350 个音节），例如 {"".join(chr(c) for c in sorted(miss)[:5])}')
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
    for rid, f in listed.items():
        files = {p.name: p for p in (pub / rid).iterdir()} if (pub / rid).is_dir() else {}
        if f['css'].rsplit('/', 1)[-1] not in files:
            errors.append(f'{rid}：样式 {f["css"]} 不在')
        for p in files.values():
            if p.stat().st_size > MAX_SHARD:
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


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    root = Path(argv[argv.index('--root') + 1]) if '--root' in argv else Path(__file__).resolve().parent.parent
    errors = []
    regs = load_registry(root, errors)
    if '--check' in argv:
        if not errors:
            check(root, regs, errors)
        for e in errors:
            print('字体检查：' + e)
        print(f'字体检查：登记 {len(regs)} 种，问题 {len(errors)} 个')
        return 1 if errors else 0
    if errors:
        for e in errors:
            print('字体登记有问题：' + e)
        return 1
    stacks = font_stacks(root)
    fonts = [build_one(root, d, r, stacks) for d, r in regs]
    pub = root / 'src' / 'public'
    pub.mkdir(parents=True, exist_ok=True)
    (pub / 'fonts-index.json').write_bytes(index_text(fonts).encode('utf-8'))
    for f in fonts:
        print(f'{f["id"]}：预取 {f["bytes"]["prefetch"]} B，全部 {f["bytes"]["all"]} B，{len(f["prefetch"])} 个预取分片')
    print(f'字体：{len(fonts)} 种，写了 src/public/fonts-index.json')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
