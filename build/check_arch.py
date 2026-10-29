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
       并且带 ?url 或 ?inline 后缀（B1 接手清单 LINT-binimport；扫的文件同 BIDI）
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
# 这些词后面的 / 是正则开头（其余词、) ] } 和后置 ++ -- 后面是除号），同 tests/build/ts-scan.ts
_REGEX_AFTER_WORD = {"return", "typeof", "instanceof", "case", "of", "in", "else", "await", "yield", "void", "throw", "new", "delete", "do"}
_JS_TOKEN = re.compile(
    r"(?P<ws>\s+)|(?P<lc>//[^\n]*)|(?P<bc>/\*.*?(?:\*/|\Z))|(?P<str>'(?:\\.|[^'\\\n])*'?|\"(?:\\.|[^\"\\\n])*\"?)"
    r"|(?P<word>[\w$]+)|(?P<inc>\+\+|--)|(?P<other>.)",
    re.S,
)


def js_skeleton(code):
    """返回 (skel, literals)：skel 和原文等长，注释、字符串内容、模板的字面部分、正则字面量换成空格（换行和引号留着，
    模板 ${…} 里照代码扫）；literals 是 {开引号下标: 字面量原文（不含引号，模板含 ${…}）}。
    字符串遇换行就断（未闭合的不吞后面的行）；正则字面量按前一个记号判断，同 tests/build/ts-scan.ts"""
    n = len(code)
    skel = list(code)
    literals = {}
    state = {"prev": "", "word": ""}

    def blank(a, b):
        for k in range(a, min(b, n)):
            if skel[k] != "\n":
                skel[k] = " "

    def regex_ok():
        p = state["prev"]
        return p == "" or p in "(,=:[!&|?{};+-*%<>~^" or state["word"] in _REGEX_AFTER_WORD

    def template(start):
        j, lit = start + 1, start + 1
        while j < n and code[j] != "`":
            if code[j] == "\\":
                j += 2
                continue
            if code.startswith("${", j):
                blank(lit, j)
                state["prev"], state["word"] = "{", ""
                j = run(j + 2, True)
                lit = j
                continue
            j += 1
        blank(lit, j)
        literals[start] = code[start + 1:min(j, n)]
        return j + 1

    def run(i, in_expr):
        depth = 0
        while i < n:
            c = code[i]
            if c == "`":
                i = template(i)
                state["prev"], state["word"] = "`", ""
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
                state["prev"], state["word"] = ")", ""
                continue
            m = _JS_TOKEN.match(code, i)
            kind, end = m.lastgroup, m.end()
            if kind in ("lc", "bc"):
                blank(i, end)
            elif kind == "str":
                closed = end - i >= 2 and code[end - 1] == c
                literals[i] = code[i + 1:end - 1 if closed else end]
                blank(i + 1, end - 1 if closed else end)
                state["prev"], state["word"] = c, ""
            elif kind == "word":
                state["prev"], state["word"] = "a", m.group(0)
            elif kind == "inc":
                state["prev"], state["word"] = ")", ""
            elif kind == "other":
                if in_expr and c == "{":
                    depth += 1
                if in_expr and c == "}":
                    if depth == 0:
                        return i + 1
                    depth -= 1
                state["prev"], state["word"] = c, ""
            i = end
        return n

    run(0, False)
    return "".join(skel), literals


def _match_close(skel, open_at):
    """skel 里 open_at 处的 ( 对应的 )；括号不配对时退回这一行的行尾"""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = []
    for k in range(open_at, len(skel)):
        ch = skel[k]
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in ")]}":
            if not stack or stack.pop() != ch:
                break
            if not stack:
                return k
    eol = skel.find("\n", open_at)
    return len(skel) if eol < 0 else eol


def binimport_ext(spec):
    """目标路径以二进制扩展名结尾就返回扩展名。宁可多报：原文、去掉 ? 之后、去掉 # 之后、模板的 ${…} 换掉之后，任一种命中都算"""
    variants = set()
    for s in (spec, re.sub(r"\$\{[^`]*?\}", "x", spec)):
        for cut in (s, s.split("?")[0], s.split("#")[0], s.split("?")[0].split("#")[0]):
            variants.add(cut.strip().lower())
    for v in variants:
        for ext in BINIMPORT_EXT:
            if v.endswith(ext):
                return ext
    return None


def check_binimport(root, errors):
    for rel, p in bidi_files(root):
        if not rel.lower().endswith(BINIMPORT_SRC_EXT):
            continue
        code = p.read_bytes().decode("utf-8", errors="replace")
        skel, literals = js_skeleton(code)
        hits = []  # (开引号下标, 写法)
        lit_pos = sorted(literals)

        def in_parens(open_at, how):
            # 括号里的所有字符串都看（拼接、三元、importScripts 多个参数都算）；按下标二分取区间，不逐个比（压缩文件里调用多、字符串多）
            close = _match_close(skel, open_at)
            lo, hi = bisect.bisect_right(lit_pos, open_at), bisect.bisect_left(lit_pos, close)
            return [(at, how) for at in lit_pos[lo:hi]]

        factories = {"createRequire"}
        bound = set()
        # 骨架里不出现 createRequire 就没有绑定可收，整段跳过（别名、绑定都要先写出 createRequire 这个词）
        if "createRequire" in skel:
            factories |= set(BINIMPORT_FACTORY_ALIAS_RE.findall(skel))
            fact_alt = "|".join(re.escape(f) for f in sorted(factories))
            # const/let/var r = createRequire(…) 以及 r = createRequire(…)：绑定出来的名字都当 require
            # 允许 TS 类型注解（const r: NodeRequire = …；注解里可有 =>、泛型，所以用非贪婪、允许 =，可以跨行，不跨 ;）。
            # 注解限 200 个字符：不限长时又长、又没分号、又有很多“名字:”的压缩行要按行长的平方回溯（0.3 MB 单行跑过 2 分钟）
            # 和 xxx. / xxx?. 前缀（module.createRequire、m.createRequire，和下面连写的认法一致）。
            # 带注解的一遍可能把 “const x: T = a, r = createRequire(” 记成 x，再跑一遍不带注解的取并集，r 也收进来（只会多报）
            prefix = r"(?:[\w$]+\s*\??\.\s*)*"
            for annot in (r"\s*:[^;]{0,200}?", ""):
                bound |= set(re.findall(rf"(?<![\w$.])([\w$]+){annot}\s*=\s*{prefix}(?:{fact_alt})\s*\(", skel))
            bound -= set(BINIMPORT_CALL_NAMES)
        fact_alt = "|".join(re.escape(f) for f in sorted(factories))
        names = {n: f"{n}()" for n in BINIMPORT_CALL_NAMES}
        names.update({n: f"createRequire 得到的 {n}()" for n in bound})
        call_re = re.compile(rf"(?<![\w$])({'|'.join(re.escape(n) for n in sorted(names))}){BINIMPORT_CALL_TAIL}")
        for m in call_re.finditer(skel):
            hits += in_parens(m.end() - 1, names[m.group(1)])
        # createRequire(…)(…) 连写：看第二对括号
        for m in re.finditer(rf"(?<![\w$])(?:{fact_alt})\s*\(", skel):
            close = _match_close(skel, m.end() - 1)
            nxt = re.compile(r"\s*(?:\?\.\s*)?\(").match(skel, close + 1)
            if close < len(skel) and skel[close] == ")" and nxt:
                hits += in_parens(nxt.end() - 1, "createRequire(…)()")
        for m in BINIMPORT_FROM_RE.finditer(skel):
            if m.end() in literals:
                hits.append((m.end(), "import/export … from" if m.group(1) == "from" else "import"))
        seen = set()
        for at, how in sorted(hits):
            if at in seen:
                continue
            seen.add(at)
            spec = literals[at]
            ext = binimport_ext(spec)
            if not ext:
                continue
            vite_import = how in ("import()", "import/export … from", "import") and code[at] != "`"
            if vite_import and rel.startswith("src/") and BINIMPORT_EXEMPT_RE.match(spec):
                continue
            errors.append(("BINIMPORT", rel, line_of(code, at),
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
