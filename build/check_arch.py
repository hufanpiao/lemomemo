"""架构检查里 ESLint、Stylelint、tsc 管不到的几条（架构 2.3）。

用法：python -I build/check_arch.py [--root 目录] [--json]
  A14  src、shared、dist/web 里不能有密钥特征（sb_secret_、sb_publishable_、sbp_ 要前缀后紧跟至少 20 个密钥字符才算）；import.meta.env 只能读 VITE_PUBLIC_* 和 Vite 自带的 MODE/DEV/PROD/BASE_URL/SSR
  A20  TS/TSX 的字符串和 JSX 文本里不能有汉字、谚文（注释不算）；例外见 A20_EXEMPT
  A19  SW 只走网络的路径（15.3 第 1 条）：src/sw/routes.ts 的 NETWORK_ONLY_PREFIXES 必须有 '/sb'、'/files'；
       sw 的其他文件里不准再写 /sb、/files 的路径（不能给它们另挂 Workbox 路由或缓存）
  R2   src 里不准 import 对象存储的任何东西：shared/objstore.ts、aws4fetch、functions/ 下的文件（含生成的 files-rules）。
       App 只经 platform/files.ts 调同源的 /files/v1/*（架构 0.32 第 2、4 条，任务单 FA-2）
  W2   src/public/holidays/cn|kr/ 缺明年的文件（警告）
  P142 supabase/migrations 里 private 的触发器函数不准出现 current_user，用 current_setting('role', true)（0.29 续第 142 条）
  A24  src 的 CSS 里 stylelint-disable 注释不准不写规则名（等于全关），也不准关 lemo/* 和 A24 的三条规则
       （declaration-property-value-disallowed-list、function-disallowed-list、property-disallowed-list；UI-4 M4 第三轮）
  BIDI git ls-files 里除二进制外的所有文件不准原样出现看不见的双向、零宽、填充类控制字符
       （U+200B–U+200F、U+202A–U+202E、U+2060–U+2069、U+061C、U+2028、U+2029、U+180E、U+3164、U+115F、U+1160、U+FFA0、
       U+E0000–U+E007F、文件中间的 U+FEFF；U+00AD、U+FE00–U+FE0F 只在代码类扩展名里拦），要写成转义
       （B1 接手清单 LINT-bidi，防 Trojan Source；UTF-16 文件先解码再扫；--root 不在 git 里或 git 出错时整棵树扫）
  BINIMPORT JS/TS 源码里 require（含 require.call/apply、require?.()、(0, require)()、createRequire 绑定的名字和
       createRequire(…)() 连写）、import、import()、export … from、importScripts、new Worker 的目标路径不准以二进制扩展名结尾
       （BIDI_BINARY_EXT 加 .node、.so、.dylib；Node 的 CJS 把不认识的扩展名当 JS 执行，二进制里藏的代码评审在 diff 里看不到）。
       例外只有一种：src/ 下（Vite 打包）的 import / export … from / import() 引图片（png、jpg、jpeg、gif、webp、avif、ico、bmp）
       并且带 ?url 或 ?inline 后缀（B1 接手清单 LINT-binimport；扫的文件同 BIDI）；目标字符串超过 4096 个字符不核对、按可疑报。
       另报（LINT-binimport-gaps ①～④）：eval / Function / vm.runIn*、vm.compileFunction、vm.Script / process.dlopen 括号里的二进制扩展名；createRequire 经
       别名、对象属性、数组解构、.then 回调、加括号传出去的调用；`)` 只在 if/while/for/with 的条件后面才把 / 当正则（其余当除号）；
       非 JS 入口（package.json、yml、shell、Makefile、.py 等）里 node、python、bash、source 等命令执行的文件，
       以及 .html/.vue/.svelte 的 script 标签 src
有错误时退出码 1，只有警告时 0。--root 给自测用（tests/arch-fixtures/check_arch/ 下的样例目录）。
"""
import argparse
import bisect
import datetime
import json
import pathlib
import re
import subprocess
import sys

# Supabase 各种密钥的前缀：只在前缀后面紧跟至少 20 个密钥字符时才算（B1 K4）。
# supabase-js 自己带着 'sb_secret_' 这类前缀字面量做判断，打进产物后后面不跟任何密钥，只认前缀会误报
SUPABASE_KEY_PREFIXES = ("sb_secret_", "sb_publishable_", "sbp_")
SECRET_PATTERNS = [
    ("service_role", re.compile(r"service_role")),
    *[(f"{p} 密钥", re.compile(rf"(?<![A-Za-z0-9_]){re.escape(p)}[A-Za-z0-9_\-]{{20,}}")) for p in SUPABASE_KEY_PREFIXES],
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_\-]{30,}")),
    ("Resend key", re.compile(r"\bre_[0-9A-Za-z_]{32,}")),
    ("私钥", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY")),
    ("VAPID_PRIVATE", re.compile(r"VAPID_PRIVATE")),
]
ENV_OK = {"MODE", "DEV", "PROD", "BASE_URL", "SSR"}
ENV_RE = re.compile(r"import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)")
ENV_INDEX_RE = re.compile(r"import\.meta\.env\s*\[")
CJK = re.compile(r"[ᄀ-ᇿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]")
EXEMPT_HEADER = "// i18n-exempt: 解析词表"
# 只允许这两个目录的文件用文件头豁免（架构 2.3 A20）
EXEMPT_HEADER_DIRS = ("shared/logic/parse/", "shared/logic/notes/classify-rules.ts")
SOURCE_EXT = (".ts", ".tsx", ".mts", ".js", ".mjs")


def a20_exempt(rel, text):
    if rel in ("shared/i18n/zh.ts", "shared/i18n/ko.ts"):
        return True
    if re.match(r"src/features/[^/]+/i18n/[^/]+\.ts$", rel):
        return True
    if rel.endswith("-data.ts"):
        return True
    if rel.startswith("tests/") or "/__tests__/" in rel:
        return True
    if text.startswith(EXEMPT_HEADER) and rel.startswith(EXEMPT_HEADER_DIRS):
        return True
    return False


def strip_comments(src):
    """去掉 // 和 /* */ 注释，保留字符串、模板字符串、JSX 文本；换行保留，行号不变。
    简化：不识别正则字面量（项目里正则不写中文）。"""
    out = []
    i, n = 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"`":
            quote = c
            out.append(c)
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("\n" * src.count("\n", i, j))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def iter_files(root, top, exts):
    base = root / top
    if not base.exists():
        return
    for p in sorted(base.rglob("*")):
        if p.is_file() and p.suffix in exts and "node_modules" not in p.parts:
            yield p


def check_a14(root, errors):
    for top in ("src", "shared", "dist/web"):
        exts = SOURCE_EXT + (".html", ".json", ".css", ".txt", ".webmanifest", ".map") if top == "dist/web" else SOURCE_EXT
        for p in iter_files(root, top, exts):
            rel = p.relative_to(root).as_posix()
            text = p.read_text(encoding="utf-8", errors="replace")
            for name, rx in SECRET_PATTERNS:
                m = rx.search(text)
                if m:
                    line = text.count("\n", 0, m.start()) + 1
                    errors.append(("A14", rel, line, f"疑似密钥特征：{name}"))
            if top == "dist/web":
                continue
            for m in ENV_RE.finditer(text):
                var = m.group(1)
                if not (var.startswith("VITE_PUBLIC_") or var in ENV_OK):
                    line = text.count("\n", 0, m.start()) + 1
                    errors.append(("A14", rel, line, f"import.meta.env 只能读 VITE_PUBLIC_*：{var}"))
            for m in ENV_INDEX_RE.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                errors.append(("A14", rel, line, "import.meta.env 不准用 [] 动态取值"))


def check_a20(root, errors):
    for top in ("src", "shared"):
        for p in iter_files(root, top, (".ts", ".tsx")):
            rel = p.relative_to(root).as_posix()
            if rel.endswith(".d.ts"):
                continue
            text = p.read_text(encoding="utf-8")
            if a20_exempt(rel, text):
                continue
            code = strip_comments(text)
            for ln, line in enumerate(code.splitlines(), 1):
                m = CJK.search(line)
                if m:
                    errors.append(("A20", rel, ln, f"字符串或 JSX 文本里有汉字或谚文：{line.strip()[:40]}"))


SW_PREFIXES_RE = re.compile(r"NETWORK_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]")
SW_REQUIRED = ("/sb", "/files")
# 字符串、模板字符串或正则字面量里以 /sb、/files 这一段开头（/sbx、/filesystem 不算）
SW_PATH_LITERAL = re.compile(r"""['"`]/(sb|files)(?![A-Za-z0-9_-])|/\^?\\/(sb|files)(?![A-Za-z0-9_-])""")


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def check_a19(root, errors):
    sw = root / "src" / "sw"
    if not sw.exists():
        return
    routes = sw / "routes.ts"
    if not routes.exists():
        errors.append(("A19", "src/sw/routes.ts", 0, "缺 SW 的路由表 routes.ts（NETWORK_ONLY_PREFIXES）"))
    else:
        code = strip_comments(routes.read_text(encoding="utf-8"))
        m = SW_PREFIXES_RE.search(code)
        listed = set(re.findall(r"""['"]([^'"]+)['"]""", m.group(1))) if m else set()
        for need in SW_REQUIRED:
            if need not in listed:
                errors.append(("A19", "src/sw/routes.ts", line_of(code, m.start()) if m else 0,
                               f"NETWORK_ONLY_PREFIXES 里没有 '{need}'：{need}/* 必须只走网络、不进 Cache Storage"))
    for p in iter_files(root, "src/sw", (".ts",)):
        rel = p.relative_to(root).as_posix()
        if rel == "src/sw/routes.ts" or "/__tests__/" in rel:
            continue
        code = strip_comments(p.read_text(encoding="utf-8"))
        for m in SW_PATH_LITERAL.finditer(code):
            seg = m.group(1) or m.group(2)
            errors.append(("A19", rel, line_of(code, m.start()),
                           f"sw 里另写了 /{seg} 的路径：只走网络的路径只在 routes.ts 的 NETWORK_ONLY_PREFIXES 里登记"))


IMPORT_SPEC_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]""")


def r2_forbidden(spec):
    norm = spec.replace("\\", "/")
    if re.match(r"^(npm:)?aws4fetch(@[^/]*)?(/|$)", norm):
        return "aws4fetch"
    if re.search(r"(^|/)shared/objstore(\.ts)?$", norm):
        return "shared/objstore.ts"
    if re.match(r"^(\.\./)+functions/", norm) or "_generated/files-rules" in norm:
        return "functions/ 下的文件（Pages Functions、生成的规则表）"
    return None


def check_r2(root, errors):
    for p in iter_files(root, "src", SOURCE_EXT):
        rel = p.relative_to(root).as_posix()
        code = strip_comments(p.read_text(encoding="utf-8"))
        for m in IMPORT_SPEC_RE.finditer(code):
            what = r2_forbidden(m.group(1))
            if what:
                errors.append(("R2", rel, line_of(code, m.start()),
                               f"App 不准 import 对象存储的东西（{what}）：照片和附件一律经 platform/files.ts 调 /files/v1/*"))


def check_w2(root, warnings, today):
    next_year = today.year + 1
    for country in ("cn", "kr"):
        d = root / "src" / "public" / "holidays" / country
        if not (d / f"{next_year}.json").exists():
            rel = d.relative_to(root).as_posix()
            warnings.append(("W2", rel, 0, f"缺明年的节假日文件 {next_year}.json"))


FUNC_RE = re.compile(
    r"create\s+(?:or\s+replace\s+)?function\s+(\"?private\"?\.\"?[A-Za-z0-9_]+\"?)\s*\((.*?)\)\s*returns\s+(\w+)(.*?)as\s+(\$[A-Za-z0-9_]*\$)(.*?)\5",
    re.IGNORECASE | re.DOTALL,
)


def strip_sql_comments(sql):
    sql = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", "", sql)


def check_p142(root, errors):
    mig = root / "supabase" / "migrations"
    if not mig.exists():
        return
    for p in sorted(mig.glob("*.sql")):
        rel = p.relative_to(root).as_posix()
        raw = p.read_text(encoding="utf-8")
        sql = strip_sql_comments(raw)
        for m in FUNC_RE.finditer(sql):
            name, returns, body = m.group(1), m.group(3).lower(), m.group(6)
            if returns != "trigger":
                continue
            hit = re.search(r"\bcurrent_user\b", body, re.IGNORECASE)
            if hit:
                line = sql.count("\n", 0, m.start(6) + hit.start()) + 1
                errors.append(("P142", rel, line, f"{name} 是 private 的触发器函数，不准用 current_user，改用 current_setting('role', true)"))


# A24 和 17.2 第 5 点靠这几条 Stylelint 规则；不准用 stylelint-disable 关掉（UI-4 M4 第三轮 n09）
A24_STYLELINT_RULES = {"declaration-property-value-disallowed-list", "function-disallowed-list", "property-disallowed-list"}
STYLELINT_DISABLE_RE = re.compile(r"/\*\s*stylelint-disable(?:-next-line|-line)?(?![-\w])(.*?)\*/", re.S)


def check_a24_disable(root, errors):
    for p in iter_files(root, "src", (".css",)):
        rel = p.relative_to(root).as_posix()
        text = p.read_text(encoding="utf-8")
        for m in STYLELINT_DISABLE_RE.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            names = m.group(1).split("--", 1)[0]
            rules = [r.strip() for r in names.split(",") if r.strip()]
            if not rules:
                errors.append(("A24", rel, line, "stylelint-disable 不写规则名等于全部关掉（含 lemo/* 和 A24），要写明关哪一条"))
                continue
            bad = [r for r in rules if r.startswith("lemo/") or r in A24_STYLELINT_RULES]
            if bad:
                errors.append(("A24", rel, line, f"不准用 stylelint-disable 关掉 {', '.join(bad)}（A24、17.2 第 5 点）"))


# BIDI（B1 接手清单 LINT-bidi，防 Trojan Source）：源码里不准原样出现看不见的双向、零宽、填充类控制字符，
# 要用就写转义（BS + "u202e" 这类，BS 即反斜杠）。本文件只用 chr() 拼这些字符，自己不含原样字符
def _cps(*ranges):
    out = []
    for r in ranges:
        lo, hi = r if isinstance(r, tuple) else (r, r)
        out += [chr(c) for c in range(lo, hi + 1)]
    return frozenset(out)


BIDI_CHARS = _cps(
    (0x200B, 0x200F),  # 零宽空格、ZWNJ、ZWJ、LRM、RLM
    (0x202A, 0x202E),  # LRE、RLE、PDF、LRO、RLO
    (0x2066, 0x2069),  # LRI、RLI、FSI、PDI
    (0x2060, 0x2064),  # 词连接符、不可见的函数应用/乘号/分隔符/加号
    0x061C, 0x2028, 0x2029, 0xFEFF,  # ALM、行分隔符、段分隔符、BOM（文件开头的 BOM 不算）
    0x180E, 0x3164, 0x115F, 0x1160, 0xFFA0,  # 蒙古文元音分隔符、各种谚文填充符
    (0xE0000, 0xE007F),  # 标签字符
)
# 只在代码类扩展名里拦：软连字符、变体选择符（.md 等文档里可能正常出现）
BIDI_CODE_ONLY = _cps(0x00AD, (0xFE00, 0xFE0F))
BIDI_CODE_EXT = (
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css", ".sql", ".psql", ".py", ".ps1", ".psm1",
    ".sh", ".rs", ".json", ".jsonc", ".toml", ".yml", ".yaml", ".html", ".svg", ".xml", ".webmanifest",
)
BIDI_RE = re.compile("[" + "".join(sorted(BIDI_CHARS | BIDI_CODE_ONLY)) + "]")
# 例外名单：文件路径 → {行号: 这一行允许的码位}；只放行这一行实际出现的码位，别的行、别的码位照样报
BIDI_EXEMPT = {
    # 已上线迁移，不可改；这是拦 bidi 文件名的正则本身（第 16 行 name !~ '[...]' 里原样写了区间端点）
    "supabase/migrations/0004_attachments.sql": {16: _cps(0x202A, 0x202E, 0x2066, 0x2069)},
}
# 二进制：扩展名命中并且内容含 NUL 才跳过；其余文件坏字节按 replace 解码照扫（只有没扩展名或扩展名不认识的文件含 NUL 才当二进制）
BIDI_BINARY_EXT = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns", ".bmp", ".woff", ".woff2", ".ttf", ".otf",
    ".eot", ".pdf", ".zip", ".gz", ".tgz", ".7z", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".wasm", ".exe", ".dll",
    ".bin", ".db", ".sqlite", ".lockb", ".pyc", ".blend", ".psd",
)


def bidi_files(root):
    """要扫的文件：git ls-files（已跟踪 + 未忽略的新文件）的全部文件，强制提交进 git 的 node_modules 也扫；
    --root 指的目录不在 git 里、或 git 出错（自测的临时目录）就整棵树走一遍，这时才排除 node_modules 和 .git。
    二进制不在这里排除，由 check_bidi 按“扩展名 + 含 NUL”判定"""
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root, capture_output=True, check=True,
        ).stdout.decode("utf-8")
        rels = sorted(set(r for r in out.split("\0") if r))
    except (OSError, subprocess.CalledProcessError):
        rels = sorted(
            rel for rel in (p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
            if not {"node_modules", ".git"} & set(rel.split("/"))
        )
    for rel in rels:
        p = root / rel
        if p.is_file():
            yield rel, p


# 认得的文本扩展名（不在 BIDI_CODE_EXT 里但肯定是文本）：和代码文件一样无条件扫
BIDI_TEXT_EXT = (".md", ".markdown", ".txt", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".env", ".example", ".lock", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".bat", ".cmd")


BIDI_UTF16_BOMS = (b"\xff\xfe", b"\xfe\xff")


def bidi_decode(data):
    """返回要扫的文本列表；坏字节一律 errors='replace'，不让坏字节把整份文件带过。
    FF FE / FE FF 开头的文件按 UTF-16（BOM 去掉）和 UTF-8 各解码一遍，两种都扫
    （开头放个假 BOM、后面其实是 UTF-8 的 .sh 照样能被 bash 执行），其余按 UTF-8"""
    if data[:2] in BIDI_UTF16_BOMS:
        return [data.decode("utf-16", errors="replace"), data.decode("utf-8", errors="replace")]
    return [data.decode("utf-8", errors="replace")]


def bidi_head_has_nul(data):
    """前 8000 字节有没有 NUL（和 git 判断二进制的方式一致）。
    FF FE / FE FF 开头的：UTF-16 解码后含 NUL、并且原始字节里也含 NUL，两个都满足才算"""
    head = data[:8000]
    if data[:2] in BIDI_UTF16_BOMS:
        return "\0" in head.decode("utf-16", errors="replace") and b"\0" in head
    return b"\0" in head


def bidi_hits(text, code_file, exempt):
    """一种解码下的命中：[(行号, 码位)]，按出现顺序"""
    hits = []
    for m in BIDI_RE.finditer(text):
        c = m.group(0)
        if m.start() == 0 and c == chr(0xFEFF):
            continue
        if c in BIDI_CODE_ONLY and not code_file:
            continue
        # 行号只数 \n：U+2028、U+2029 本身不算换行，和编辑器、git diff 对得上
        line = text.count("\n", 0, m.start()) + 1
        if c in exempt.get(line, ()):
            continue
        hits.append((line, ord(c)))
    return hits


def check_bidi(root, errors):
    bs = chr(92)
    for rel, p in bidi_files(root):
        # 文件名（相对路径）本身也扫：git diff、编辑器里显示的路径同样会被双向字符翻转
        for m in BIDI_RE.finditer(rel):
            if m.group(0) in BIDI_CHARS:
                cp = ord(m.group(0))
                errors.append(("BIDI", rel, 0, f"文件名里原样出现看不见的控制字符 U+{cp:04X}（Trojan Source 一类），要改名"))
        data = p.read_bytes()
        low = rel.lower()
        head_has_nul = bidi_head_has_nul(data)
        # 二进制：扩展名在 BIDI_BINARY_EXT 里、并且前 8000 字节含 NUL 才跳过（.png 能被 require 当 JS、.bin 能被 python 当脚本跑）
        if low.endswith(BIDI_BINARY_EXT) and head_has_nul:
            continue
        code_file = low.endswith(BIDI_CODE_EXT)
        # 代码和认得的文本扩展名无条件扫，
        # 只有没扩展名或扩展名不认识的文件才保留 NUL 判定（防在注释里塞 0xFF、NUL 绕过检查），同样只看前 8000 字节
        if not code_file and not low.endswith(BIDI_TEXT_EXT) and head_has_nul:
            continue
        exempt = BIDI_EXEMPT.get(rel, {})
        # 多种解码的命中合并：同一（行号, 码位）取各解码里出现次数的最大值，同一处不重复报
        merged = {}
        for text in bidi_decode(data):
            counts = {}
            for key in bidi_hits(text, code_file, exempt):
                counts[key] = counts.get(key, 0) + 1
            for key, n in counts.items():
                merged[key] = max(merged.get(key, 0), n)
        for (line, cp), n in sorted(merged.items()):
            esc = f"{bs}u{cp:04x}" if cp <= 0xFFFF else f"{bs}u{{{cp:x}}}"
            for _ in range(n):
                errors.append(("BIDI", rel, line, f"原样出现看不见的控制字符 U+{cp:04X}（Trojan Source 一类），要写成转义 {esc}"))


# BINIMPORT（B1 接手清单 LINT-binimport）：require / import 的目标不准是二进制扩展名。
# NUL 在前 8000 字节的 .png 里写 JS，git 和 GitHub 当二进制、评审看不到内容，但 require('./x.png') 照样执行（BIDI 管不到）
BINIMPORT_EXT = BIDI_BINARY_EXT + (".node", ".so", ".dylib")
# 目标字符串超过这个长度就不核对扩展名、直接按可疑报（Linux 的 PATH_MAX 是 4096，真实的模块路径不会更长）
BINIMPORT_SPEC_MAX = 4096
BINIMPORT_SRC_EXT = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
# 例外：src/ 下由 Vite 打包的代码用 import 引图片，并且明写 ?url 或 ?inline（Vite 只给 URL 或 data URL，不执行）。
# 带了查询串，Node 的 CJS 按文件名“x.png?url”找不到文件、ESM 遇到 .png 报未知扩展名，两边都不会把它当 JS 跑。
# 不带后缀的 import logo from './x.png'、.bin、.wasm、require 一律不放行
BINIMPORT_EXEMPT_RE = re.compile(r"^[^?#]*\.(?:png|jpe?g|gif|webp|avif|ico|bmp)\?(?:url|inline)$", re.IGNORECASE)
# 只认代码里的写法：在“骨架”（注释、字符串内容、正则字面量换成空格，引号留着）上找，注释和字符串里的假 import 不报
BINIMPORT_CALL_NAMES = ("require", "import", "importScripts", "Worker", "SharedWorker")
# 名字后面接 ( 的几种调用：f(、f?.(、f.call(、f.apply(、(0, f)(（名字后紧跟 ) 再接 (）
BINIMPORT_CALL_TAIL = r"\s*(?:\?\.\s*|\.\s*(?:call|apply)\s*(?:\?\.\s*)?|\)\s*)?\("
# createRequire（ESM 里把 .png 当代码执行几乎只有这一条路）：import { createRequire as cr }、{ createRequire: cr } 的别名也算
BINIMPORT_FACTORY_ALIAS_RE = re.compile(r"(?<![\w$])createRequire\s*(?:as\s+|:\s*)([\w$]+)")
BINIMPORT_FROM_RE = re.compile(r"(?<![\w$.])(from|import)\s*(?=['\"`])")
# 读文件再执行（eval(readFileSync('x.png'))）、加载原生模块（process.dlopen）：这些调用的括号里出现二进制扩展名的字符串也报。
# 只认会把参数当代码执行的几个名字；readFileSync、fetch、new URL 只读不执行，不报
# Script 太常见（自定义的 new Script({icon: 'logo.png'})），不放这里，只认 vm.Script / new vm.Script（见 _binimport_js_hits）；
# Function 不论裸写还是 new 都是全局的 Function 构造器，留着
BINIMPORT_EXEC_NAMES = ("eval", "Function", "runInThisContext", "runInNewContext", "runInContext", "compileFunction", "dlopen")
# 非 JS 入口（package.json scripts、CI yml、shell、Makefile、.py 等）里“命令 + 二进制扩展名路径”：node、python 之类的解释器
# 把文件当源码执行，不看扩展名。shell 类文件另认 source 和点号（. ./x）；.py、.ps1、.bat 里不认这两个（不是那里的执行写法）
BINIMPORT_SHELL_EXT = (".sh", ".bash", ".zsh", ".yml", ".yaml", ".mk")
BINIMPORT_SHELL_NAMES = ("makefile", "gnumakefile", "dockerfile", "justfile", "procfile")
BINIMPORT_CMD_EXT = (".py", ".ps1", ".psm1", ".cmd", ".bat")
BINIMPORT_HTML_EXT = (".html", ".htm", ".xhtml", ".vue", ".svelte", ".astro")
# python 带版本号（python3.11）、Windows 的 .exe（python.exe、node.exe）也认
_BINIMPORT_CMDS = r"(?:node|nodejs|bun|deno|tsx|ts-node|python(?:[23](?:\.\d+)?)?|py|bash|sh|zsh|pwsh|powershell)(?:\.exe)?"
# 命令词前面不能是字母数字、点、横杠、@（setup-node@v4、node-version、foo.py 都不算），后面要跟空格或制表符
BINIMPORT_CMD_RE = re.compile(rf"(?<![\w$.\-@])({_BINIMPORT_CMDS})(?=[ \t])")
BINIMPORT_SHELL_CMD_RE = re.compile(rf"(?<![\w$.\-@])({_BINIMPORT_CMDS}|source)(?=[ \t])|(?:^|(?<=[;&|])|(?<=: )|(?<=: \")|(?<=: ')|(?<=\":\"))[ \t]*(\.)(?=[ \t])", re.M)
# 不带引号的词也收反斜杠（Windows 路径 E:\a\b.ps1）；取出来以后去掉首尾的反斜杠（JSON 里的 \" 转义）
BINIMPORT_CMD_TOKEN_RE = re.compile(r"[ \t]+(?:\"([^\"\n]*)\"|'([^'\n]*)'|([^\s;&|<>()`\"']+))")
# 这些选项的值也是要执行的文件（node -r / --require / --import / --loader，bun --preload）：核对完值，接着往后找要执行的脚本
BINIMPORT_VALUE_OPTS = {"-r", "--require", "--import", "--loader", "--experimental-loader", "--preload"}
# 这些选项带一个值，但值不是文件（python -W ignore、-X utf8，node --max-old-space-size 4096、--title x）：跳过这个值
BINIMPORT_SKIP_VALUE_OPTS = {"-W", "-X", "--max-old-space-size", "--stack-size", "--title", "--input-type", "--env-file"}
# 只对 node 系命令跳值的选项：node 的 -C / --conditions 带值；sh、bash 的 -C 是 noclobber 开关，不带值
BINIMPORT_NODE_CMDS = {"node", "nodejs", "bun", "deno", "tsx", "ts-node"}
BINIMPORT_NODE_SKIP_VALUE_OPTS = {"-C", "--conditions"}
# PowerShell（pwsh、powershell）的参数不分大小写，单独一套：-File 的值就是要执行的脚本，核对完就停（后面是脚本自己的参数，
# 如 -Icon a.png）；-Command / -EncodedCommand 后面是代码；-ExecutionPolicy 这类带一个不是文件的值；-NoProfile 这类开关不带值
BINIMPORT_PS_CMDS = {"pwsh", "powershell"}
BINIMPORT_PS_FILE_OPTS = {"-file", "-f"}
BINIMPORT_PS_CODE_OPTS = {"-command", "-c", "-encodedcommand", "-e", "-ec"}
BINIMPORT_PS_SKIP_VALUE_OPTS = {"-executionpolicy", "-ep", "-ex", "-windowstyle", "-w", "-workingdirectory", "-wd",
                                "-configurationname", "-config", "-outputformat", "-of", "-o", "-inputformat", "-if", "-in",
                                "-version", "-v", "-psconsolefile", "-settingsfile", "-custompipename"}
# 这些选项后面是代码或模块名，不是文件：不再往后看
BINIMPORT_CODE_OPTS = {"-e", "--eval", "-p", "--print", "-c", "-m"}
BINIMPORT_SCRIPT_SRC_RE = re.compile(r"<script\b[^>]{0,1000}?\bsrc\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", re.I)
# 这些词后面的 / 是正则开头（其余词、) ] } 和后置 ++ -- 后面是除号），同 tests/build/ts-scan.ts
_REGEX_AFTER_WORD = {"return", "typeof", "instanceof", "case", "of", "in", "else", "await", "yield", "void", "throw", "new", "delete", "do"}
# 这些语句头的 (…) 后面是语句，) 后的 / 是正则开头
_PAREN_REGEX_WORDS = {"if", "while", "for", "with"}
_JS_TOKEN = re.compile(
    r"(?P<ws>\s+)|(?P<lc>//[^\n]*)|(?P<bc>/\*.*?(?:\*/|\Z))|(?P<str>'(?:\\.|[^'\\\n])*'?|\"(?:\\.|[^\"\\\n])*\"?)"
    r"|(?P<word>[\w$]+)|(?P<inc>\+\+|--)|(?P<other>.)",
    re.S,
)


def js_skeleton(code):
    """返回 (skel, literals)：skel 和原文等长，注释、字符串内容、模板的字面部分、正则字面量换成空格（换行和引号留着，
    模板 ${…} 里照代码扫）；literals 是 {开引号下标: (起, 止)}，code[起:止] 是字面量原文（不含引号，模板含 ${…}）。
    只存下标不存切片：模板层层嵌套时每层都含里面所有层，存切片的总长按层数平方增长（1 万层、50 KB 就有 2.5 亿字符）。
    字符串遇换行就断（未闭合的不吞后面的行）；正则字面量按前一个记号判断，同 tests/build/ts-scan.ts。
    `)` 后面的 / 只在这对括号是 if / while / for / with 的条件时当正则开头（if (x) /`/.test(s)），其余都是除号
    （f(a) / 2、((n * 3) / 4)）：JS 里 ) 后能接正则的只有这几个语句头。不分的话，if (x) /`/ 的反引号会被当成模板开头、
    吞掉后面的所有代码；反过来一律当正则又会把 (a) / 2 后面的引号奇偶翻过来，让字符串里的文字冒成代码"""
    n = len(code)
    skel = list(code)
    literals = {}
    # prev 记前一个记号：真的 ) 记 ")"；正则字面量、后置 ++/-- 记 "x"（后面的 / 都是除号）。
    # parens 是开着的 ( 的栈，每项记这个 ( 前面是不是 if/while/for/with；kw_paren 记刚闭合的那对括号是不是
    # word2：紧挨在 word 前面的那个词（for await 用）；after_dot：word 前面是不是 .（Symbol.for(…) 不是语句头）
    state = {"prev": "", "word": "", "word2": "", "after_dot": False, "kw_paren": False}
    parens = []

    def blank(a, b):
        for k in range(a, min(b, n)):
            if skel[k] != "\n":
                skel[k] = " "

    def regex_ok():
        p = state["prev"]
        return p == "" or p in "(,=:[!&|?{};+-*%<>~^" or state["word"] in _REGEX_AFTER_WORD or (p == ")" and state["kw_paren"])

    # 显式栈代替递归（模板 ${…} 里再套模板，嵌套几百层时递归会 RecursionError，整个 check_arch 崩掉）：
    # 代码帧 ["c", 本层 { 的深度]、模板帧 ["t", 开反引号下标, 字面部分起点]；栈底是顶层代码，栈里多于一帧就是在 ${…} 里
    stack = [["c", 0]]
    i = 0
    while stack:
        top = stack[-1]
        if top[0] == "t":
            start, lit = top[1], top[2]
            j = i
            while j < n and code[j] != "`":
                if code[j] == "\\":
                    j += 2
                    continue
                if code.startswith("${", j):
                    break
                j += 1
            if j < n and code.startswith("${", j):
                blank(lit, j)
                state["prev"], state["word"] = "{", ""
                stack.append(["c", 0])
                i = j + 2
                continue
            blank(lit, j)
            literals[start] = (start + 1, min(j, n))
            stack.pop()
            i = j + 1
            state["prev"], state["word"] = "`", ""
            continue
        in_expr = len(stack) > 1
        if i >= n:
            if not in_expr:
                break
            stack.pop()  # 文件在 ${…} 里结束：外层模板从文件尾接着收尾
            stack[-1][2] = i = n
            continue
        c = code[i]
        if c == "`":
            stack.append(["t", i, i + 1])
            i += 1
            continue
        if c == "/" and not code.startswith("//", i) and not code.startswith("/*", i) and regex_ok():
            j, cls = i + 1, False
            while j < n and code[j] != "\n" and (cls or code[j] != "/"):
                if code[j] == "\\":
                    j += 2
                    continue
                if code[j] == "[":
                    cls = True
                elif code[j] == "]":
                    cls = False
                j += 1
            blank(i + 1, j)
            i = j + 1
            state["prev"], state["word"] = "x", ""
            continue
        m = _JS_TOKEN.match(code, i)
        kind, end = m.lastgroup, m.end()
        if kind in ("lc", "bc"):
            blank(i, end)
        elif kind == "str":
            closed = end - i >= 2 and code[end - 1] == c
            literals[i] = (i + 1, end - 1 if closed else end)
            blank(i + 1, end - 1 if closed else end)
            state["prev"], state["word"] = c, ""
        elif kind == "word":
            state["word2"] = state["word"] if state["prev"] == "a" else ""
            state["after_dot"] = state["prev"] == "."
            state["prev"], state["word"] = "a", m.group(0)
        elif kind == "inc":
            state["prev"], state["word"] = "x", ""
        elif kind == "other":
            if in_expr and c == "{":
                top[1] += 1
            if in_expr and c == "}":
                if top[1] == 0:
                    stack.pop()  # ${…} 结束：回到外层模板，字面部分从 } 后面接着算
                    stack[-1][2] = i = i + 1
                    continue
                top[1] -= 1
            if c == "(":
                w = state["word"]
                parens.append(state["prev"] == "a" and not state["after_dot"]
                              and (w in _PAREN_REGEX_WORDS or (w == "await" and state["word2"] == "for")))
            elif c == ")":
                state["kw_paren"] = parens.pop() if parens else False
            state["prev"], state["word"] = c, ""
        i = end
    return "".join(skel), literals


_BRACKET_RE = re.compile(r"[()\[\]{}]")
_BRACKET_CLOSE = {"(": ")", "[": "]", "{": "}"}


def _bracket_pairs(skel):
    """骨架上用栈一遍扫完（O(n)），返回 {开括号下标: 配对的闭括号下标}；不配对的开括号不在表里。
    和“从每个开括号往后单独扫”的结果一致：遇到类型不对的闭括号时，栈里所有还开着的括号单独扫也都会在这里碰上它，
    全部记为不配对并清栈；栈空时多出来的闭括号谁也碰不上，忽略；扫到文件尾还开着的也不配对"""
    pairs, stack = {}, []
    for m in _BRACKET_RE.finditer(skel):
        k, ch = m.start(), m.group(0)
        if ch in _BRACKET_CLOSE:
            stack.append(k)
        elif stack:
            if _BRACKET_CLOSE[skel[stack[-1]]] == ch:
                pairs[stack.pop()] = k
            else:
                stack.clear()
    return pairs


def _match_close(skel, open_at, pairs):
    """skel 里 open_at 处的 ( 对应的 )（查 _bracket_pairs 的表）；括号不配对时退回这一行的行尾"""
    close = pairs.get(open_at)
    if close is not None:
        return close
    eol = skel.find("\n", open_at)
    return len(skel) if eol < 0 else eol


def _replace_tpl_exprs(s):
    """等价于 re.sub(r"\\$\\{[^`]*?\\}", "x", s)，但一次线性扫描：
    正则版遇到满是 ${、却没有 } 的字符串，每个 ${ 都要往后试到串尾，按长度平方增长（400 个 4 千字的串要 10 秒）。
    正则的语义：从左往右，在每个 ${ 处找它后面第一个 }（非贪婪），中间不能有反引号（[^`]，换行可以）；
    配上了换成 x、从 } 后面接着找；配不上就只跳过这个 $。
    这里用两个只往前走的指针记“下一个 }”“下一个反引号”的位置，总共只扫一遍"""
    n = len(s)
    out = []
    i = 0
    nc = nt = -1  # 下一个 }、下一个反引号的下标（n 表示后面没有了）；小于当前起点时才往后重找，所以总共线性
    while True:
        p = s.find("${", i)
        if p < 0:
            out.append(s[i:])
            return "".join(out)
        out.append(s[i:p])
        if nc < p + 2:
            nc = s.find("}", p + 2)
            nc = n if nc < 0 else nc
        if nt < p + 2:
            nt = s.find("`", p + 2)
            nt = n if nt < 0 else nt
        if nc < n and nc < nt:
            out.append("x")
            i = nc + 1
        else:
            out.append("$")
            i = p + 1


def binimport_ext(spec):
    """目标路径以二进制扩展名结尾就返回扩展名。宁可多报：原文、去掉 ? 之后、去掉 # 之后、模板的 ${…} 换掉之后，任一种命中都算"""
    variants = set()
    for s in (spec, _replace_tpl_exprs(spec)):
        for cut in (s, s.split("?")[0], s.split("#")[0], s.split("?")[0].split("#")[0]):
            variants.add(cut.strip().lower())
    for v in variants:
        for ext in BINIMPORT_EXT:
            if v.endswith(ext):
                return ext
    return None


def _binimport_js_hits(skel, literals):
    """骨架上的所有命中：[(开引号下标, 写法)]（未去重，同一个字符串可能按几种写法各命中一次）"""
    hits = []
    lit_pos = sorted(literals)
    brackets = _bracket_pairs(skel)
    spans = {}  # 写法 -> [(开括号, 闭括号)]

    def in_parens(open_at, how):
        # 括号里的所有字符串都看（拼接、三元、importScripts 多个参数都算）。先只记区间，最后按写法合并区间再二分取字符串：
        # 逐个调用取字符串在层层嵌套时是“层数 × 字符串数”（5 千层平衡嵌套的 require 跑过 7 秒）
        spans.setdefault(how, []).append((open_at, _match_close(skel, open_at, brackets)))

    factories = {"createRequire"}
    bound = set()
    fact_alt = "createRequire"
    # 骨架里不出现 createRequire 就没有绑定可收，整段跳过（别名、绑定都要先写出 createRequire 这个词）
    if "createRequire" in skel:
        factories |= set(BINIMPORT_FACTORY_ALIAS_RE.findall(skel))
        # xxx. / xxx?. 前缀（module.createRequire、m.createRequire）；(createRequire)、(0, createRequire) 加括号的写法
        prefix = r"(?:[\w$]+\s*\??\.\s*)*"
        wrap = r"(?:\(\s*(?:0\s*,\s*)?)?"
        # 不带调用的别名：const cr = createRequire、const cr2: typeof createRequire = cr；别名的别名最多跟 5 层
        for _ in range(5):
            alt = "|".join(re.escape(f) for f in sorted(factories))
            new = set()
            for annot in (r"\s*:[^;]{0,200}?", ""):
                new |= set(re.findall(
                    rf"(?<![\w$.])([\w$]+){annot}\s*=\s*{wrap}{prefix}(?<![\w$])(?:{alt})(?![\w$])(?!\s*\)?\s*(?:\?\.\s*)?\()", skel))
            if new <= factories:
                break
            factories |= new
        fact_alt = "|".join(re.escape(f) for f in sorted(factories))
        fact_call = rf"(?<![\w$])(?:{fact_alt})\s*\)?\s*\("  # createRequire(、(createRequire)( 的右半
        # 绑定出来的名字都当 require（只会多报：多收的名字只有拿二进制扩展名的字符串去调时才报）。
        # 右边的部分都写在前瞻里、只消耗名字本身：findall 不重叠，消耗整段时 “const x: T = 1, r = createRequire(” 的 r 会被前一段吞掉
        # a) 带 TS 类型注解的 const r: NodeRequire = createRequire(…)（注解里可有 =>、泛型，非贪婪、可跨行、不跨 ;）。
        #    注解限 200 个字符：不限长时又长、又没分号、又有很多“名字:”的压缩行要按行长的平方回溯（0.3 MB 单行跑过 2 分钟）
        bound |= set(re.findall(rf"(?<![\w$.])([\w$]+)(?=\s*:[^;]{{0,200}}?\s*=\s*{wrap}{prefix}{fact_call})", skel))
        # b) 等号右边 200 个字符内（同一行、不跨 ;）出现 createRequire 调用：r = createRequire(…)、this.r = …、
        #    r = (createRequire)(…)、r = await import('node:module').then((m) => m.createRequire(…))。
        #    不跨行：不写分号的代码里，上一行的普通函数会被下一行的 createRequire 连带收进来
        bound |= set(re.findall(rf"(?<![\w$])([\w$]+)\s*=(?![=>])(?=[^;\n]{{0,200}}?{fact_call})", skel))
        # c) 对象属性 { r: createRequire(…) } 再 o.r(…)（三元 a ? b : createRequire(…) 会多收 b，只会多报）
        bound |= set(re.findall(rf"(?<![\w$])([\w$]+)\s*:\s*{wrap}{prefix}{fact_call}", skel))
        # d) 数组解构 [a, r] = [x, createRequire(…)]：方括号里的名字全收；[ 前面是名字、] 或 ) 时是下标赋值
        #    （icons[sizeOf] = createRequire(u)），不算解构
        for group in re.findall(rf"(?<![\w$\])])\[([^\[\]=;]{{0,200}})\](?=\s*=\s*[^;\n]{{0,200}}?{fact_call})", skel):
            bound |= set(re.findall(r"[A-Za-z_$][\w$]*", group))
        # e) createRequire(…) 之后 200 个字符内（不跨 ;）的 .then((r) => …) 回调参数
        bound |= set(re.findall(rf"{fact_call}(?=[^;]{{0,200}}?\.\s*then\s*\(\s*(?:async\s*)?\(?\s*([\w$]+))", skel))
        bound -= set(BINIMPORT_CALL_NAMES) | set(BINIMPORT_EXEC_NAMES)
    names = {n: f"{n}()" for n in BINIMPORT_CALL_NAMES + BINIMPORT_EXEC_NAMES}
    names.update({n: f"createRequire 得到的 {n}()" for n in bound})
    # vm.Script 单独认（要带 vm. 前缀）：裸写的 Script 多是自定义的类或函数
    call_re = re.compile(
        rf"(?<![\w$])(?:({'|'.join(re.escape(n) for n in sorted(names))})|vm\s*\??\.\s*Script){BINIMPORT_CALL_TAIL}")
    for m in call_re.finditer(skel):
        in_parens(m.end() - 1, names[m.group(1)] if m.group(1) else "vm.Script()")
    # createRequire(…)(…) 连写（含 (createRequire)(…)(…)、(0, cr)(…)(…)）：看第二对括号
    for m in re.finditer(rf"(?<![\w$])(?:{fact_alt})\s*(?:\)\s*)?\(", skel):
        close = _match_close(skel, m.end() - 1, brackets)
        nxt = re.compile(r"\s*(?:\?\.\s*)?\(").match(skel, close + 1)
        if close < len(skel) and skel[close] == ")" and nxt:
            in_parens(nxt.end() - 1, "createRequire(…)()")
    # 同一写法的区间合并成互不重叠的几段（开区间：字符串下标要严格落在两括号之间），每段二分取字符串
    for how, ivs in spans.items():
        merged = []
        for a, b in sorted(ivs):
            if merged and a < merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        for a, b in merged:
            lo, hi = bisect.bisect_right(lit_pos, a), bisect.bisect_left(lit_pos, b)
            hits += [(at, how) for at in lit_pos[lo:hi]]
    for m in BINIMPORT_FROM_RE.finditer(skel):
        if m.end() in literals:
            hits.append((m.end(), "import/export … from" if m.group(1) == "from" else "import"))
    return hits


def _binimport_entry_kind(rel, p):
    """非 JS 入口的种类：shell（认 source 和点号）、cmd（只认 node、python 这类命令）、html（看 script 标签的 src），不扫返回 None"""
    low = rel.rsplit("/", 1)[-1].lower()
    ext = "." + low.rsplit(".", 1)[-1] if "." in low.lstrip(".") else ""
    if low == "package.json" or low in BINIMPORT_SHELL_NAMES or low.startswith("dockerfile.") or ext in BINIMPORT_SHELL_EXT:
        return "shell"
    if ext in BINIMPORT_CMD_EXT:
        return "cmd"
    if ext in BINIMPORT_HTML_EXT:
        return "html"
    if rel.startswith(".husky/"):
        return "shell"
    if not ext:
        try:
            with open(p, "rb") as f:
                return "shell" if f.read(2) == b"#!" else None
        except OSError:
            return None
    return None


def _binimport_entry_hits(kind, text):
    """非 JS 入口里的命中：[(下标, 写法, 目标)]。
    shell / cmd：找命令词（node、python、bash、source 等），取它后面第一个不是选项的参数（-r、--require、--import 这类选项的值也算），
    只看这一个是不是二进制扩展名：执行的是 gen.mjs、只是把 logo.png 当输出参数的不报。
    -e、-c、-m 后面是代码或模块名，不再往后看（-c 里的字符串若另有命令词，照样会被单独找到）"""
    out = []
    if kind == "html":
        for m in BINIMPORT_SCRIPT_SRC_RE.finditer(text):
            g = next(k for k in (1, 2, 3) if m.group(k) is not None)
            if binimport_ext(m.group(g)):
                out.append((m.start(g), "<script src>", m.group(g)))
        return out
    cmd_re = BINIMPORT_SHELL_CMD_RE if kind == "shell" else BINIMPORT_CMD_RE
    for m in cmd_re.finditer(text):
        cmd = m.group(1) or "."
        base = cmd.lower().removesuffix(".exe")
        ps = base in BINIMPORT_PS_CMDS
        if ps:
            code_opts, value_opts, skip_opts, target_opts = BINIMPORT_PS_CODE_OPTS, set(), BINIMPORT_PS_SKIP_VALUE_OPTS, BINIMPORT_PS_FILE_OPTS
        else:
            code_opts, value_opts, target_opts = BINIMPORT_CODE_OPTS, BINIMPORT_VALUE_OPTS, set()
            skip_opts = BINIMPORT_SKIP_VALUE_OPTS | (BINIMPORT_NODE_SKIP_VALUE_OPTS if base in BINIMPORT_NODE_CMDS else set())
        # expect：上一个记号是选项、这个记号是它的值。"file"：值是先加载的文件（要核对，核对完接着找脚本）；
        # "target"：值就是要执行的脚本（pwsh -File，核对完就停）；"skip"：值不是文件（跳过）
        pos, expect = m.end(), None
        # 最多看 16 个记号：真实命令行在要执行的文件前很少超过十来个选项；设上限是为了满是命令词、选项的刻意构造行不按行长退化
        for _ in range(16):
            t = BINIMPORT_CMD_TOKEN_RE.match(text, pos)
            if not t:
                break
            pos = t.end()
            g = next(k for k in (1, 2, 3) if t.group(k) is not None)
            tok, at = t.group(g), t.start(g)
            if g == 3:
                lead = len(tok) - len(tok.lstrip("\\"))
                tok, at = tok.strip("\\"), at + lead
                if not tok:
                    continue
            if expect:
                was, expect = expect, None
                if was in ("file", "target") and binimport_ext(tok):
                    out.append((at, f"命令 {cmd}", tok))
                    break
                if was == "target":
                    break  # -File 的值就是脚本，后面是脚本自己的参数
                continue  # 选项的值看完接着往后找要执行的文件（node -r ./hook.js payload.png）
            if tok.startswith("-"):
                # PowerShell 也接受 -File:x.ps1；node 系是 --import=x
                opt, eq, val = tok.partition(":" if ps and ":" in tok else "=")
                key = opt.lower() if ps else opt
                if key in code_opts:
                    break
                if key in target_opts or key in value_opts:
                    if not eq:
                        expect = "target" if key in target_opts else "file"
                        continue
                    if binimport_ext(val):
                        out.append((at + len(opt) + 1, f"命令 {cmd}", val))
                        break
                    if key in target_opts:
                        break
                elif key in skip_opts and not eq:
                    expect = "skip"
                continue
            if (base in ("deno", "bun") and tok == "run") or tok.isdigit():
                continue  # deno run / bun run 的子命令；落单的数字是前面不认识的选项的值（--max-old-space-size 4096）
            if binimport_ext(tok):
                out.append((at, f"命令 {cmd}", tok))
            break  # 第一个不是选项的参数就是要执行的文件，看完就停
    return out


def check_binimport(root, errors):
    for rel, p in bidi_files(root):
        if rel.lower().endswith(BINIMPORT_SRC_EXT):
            _check_binimport_js(rel, p, errors)
            continue
        kind = _binimport_entry_kind(rel, p)
        if not kind:
            continue
        text = p.read_bytes().decode("utf-8", errors="replace")
        found = _binimport_entry_hits(kind, text)
        if not found:
            continue
        newlines = [m.start() for m in re.finditer("\n", text)]
        for at, how, target in found:
            line = bisect.bisect_right(newlines, at) + 1
            errors.append(("BINIMPORT", rel, line,
                           f"{how} 执行的文件是二进制扩展名 {binimport_ext(target)}：{target[:80]}（解释器把文件当源码执行，"
                           f"二进制里藏的代码评审在 diff 里看不到）"))


def _check_binimport_js(rel, p, errors):
    code = p.read_bytes().decode("utf-8", errors="replace")
    skel, literals = js_skeleton(code)
    hits = _binimport_js_hits(skel, literals)
    # 行号：每个文件只记一次换行位置，再二分（逐条 line_of 从文件头数换行，报错多时是“报错数 × 文件长度”）。
    # 和 line_of 一样只数换行符：下标 at 之前有几个换行，行号就是几加一
    newlines = [m.start() for m in re.finditer("\n", code)] if hits else []
    seen = set()
    for at, how in sorted(hits):
        if at in seen:
            continue
        a, b = literals[at]
        line = bisect.bisect_right(newlines, at) + 1
        if b - a > BINIMPORT_SPEC_MAX:
            # 不切片、不核对，按可疑报：真实的模块路径不会这么长；逐个核对时层层嵌套的模板放进 require(…) 里，
            # 每层都要切出含里面所有层的整段，耗时按层数平方增长（2 万层约 8 秒）
            seen.add(at)
            errors.append(("BINIMPORT", rel, line,
                           f"{how} 的目标字符串长 {b - a} 个字符，超过 {BINIMPORT_SPEC_MAX}，不核对扩展名、按可疑报："
                           f"{code[a:a + 80]}（真实的模块路径不会这么长，拆短或改成普通字符串）"))
            continue
        spec = code[a:b]  # 只给命中的字符串切原文，用完即丢
        ext = binimport_ext(spec)
        if not ext:
            continue
        vite_import = how in ("import()", "import/export … from", "import") and code[at] != "`"
        if vite_import and rel.startswith("src/") and BINIMPORT_EXEMPT_RE.match(spec):
            continue
        seen.add(at)
        errors.append(("BINIMPORT", rel, line,
                       f"{how} 的目标是二进制扩展名 {ext}：{spec[:80]}（Node 的 CJS 把不认识的扩展名当 JS 执行，"
                       f"二进制里藏的代码评审在 diff 里看不到；src/ 下 Vite 引图片要写 ?url 或 ?inline）"))


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent.parent))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--today", help="自测用：YYYY-MM-DD，决定 W2 的“明年”")
    args = ap.parse_args(argv)
    root = pathlib.Path(args.root).resolve()
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()

    errors, warnings = [], []
    check_a14(root, errors)
    check_a20(root, errors)
    check_a19(root, errors)
    check_r2(root, errors)
    check_w2(root, warnings, today)
    check_p142(root, errors)
    check_a24_disable(root, errors)
    check_bidi(root, errors)
    check_binimport(root, errors)

    if args.json:
        as_dict = lambda r: {"rule": r[0], "file": r[1], "line": r[2], "message": r[3]}  # noqa: E731
        print(json.dumps({"errors": [as_dict(e) for e in errors], "warnings": [as_dict(w) for w in warnings]}, ensure_ascii=False))
    else:
        for rule, f, line, msg in errors:
            print(f"错误 {rule} {f}:{line} {msg}")
        for rule, f, line, msg in warnings:
            print(f"警告 {rule} {f}:{line} {msg}")
        print(f"check_arch：{len(errors)} 个错误，{len(warnings)} 个警告")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
