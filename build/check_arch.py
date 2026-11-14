"""架构检查里 ESLint、Stylelint、tsc 管不到的几条（架构 2.3）。

用法：python -I build/check_arch.py [--root 目录] [--json] [--only 规则,规则…]
  --only：只跑列出的规则（构建后那次只要 A14：--only A14，别的规则构建前已经跑过；规则名写错退出 2）
  A14  src、shared、dist/web 里不能有密钥特征（sb_secret_、sb_publishable_、sbp_ 要前缀后紧跟至少 20 个密钥字符才算；sb_publishable_ 是公开值，dist/web 里不报）；import.meta.env 只能读 VITE_PUBLIC_* 和 Vite 自带的 MODE/DEV/PROD/BASE_URL/SSR
  A20  TS/TSX 的字符串和 JSX 文本里不能有汉字、谚文（注释不算，注释区间由 build/check_backend_ast.mjs 的 TypeScript AST 给出）；例外见 a20_exempt
  A19  SW 只走网络的路径（15.3 第 1 条）：src/sw/routes.ts 的 NETWORK_ONLY_PREFIXES 必须有 '/sb'、'/files'；
       sw 的其他文件里不准再写 /sb、/files 的路径（不能给它们另挂 Workbox 路由或缓存）
  （R2、LUNAR、MOTION-IMPL 三条引入限制 11-14 起挪进 ESLint：build/eslint-rules/import-bounds.js，CI-11）
  W2   src/public/holidays/cn|kr/ 缺明年的文件，或明年的文件还是 pending（警告）
  P142 supabase/migrations 里 private 的触发器函数不准出现 current_user，用 current_setting('role', true)（0.29 续第 142 条）
  A24  src 的 CSS 里 stylelint-disable 注释不准不写规则名（等于全关），也不准关 lemo/* 和 A24 的三条规则
       （declaration-property-value-disallowed-list、function-disallowed-list、property-disallowed-list；UI-4 M4 第三轮）
  BIDI git ls-files 里除二进制外的所有文件不准原样出现看不见的双向、零宽、填充类控制字符
       （U+200B–U+200F、U+202A–U+202E、U+2060–U+2069、U+061C、U+2028、U+2029、U+180E、U+3164、U+115F、U+1160、U+FFA0、
       U+E0000–U+E007F、文件中间的 U+FEFF；U+00AD、U+FE00–U+FE0F 只在代码类扩展名里拦），要写成转义
       （B1 接手清单 LINT-bidi，防 Trojan Source；UTF-16 文件先解码再扫；--root 不在 git 里或 git 出错时整棵树扫）
  EMAIL 扫的文件同 BIDI（除二进制外的所有文件）：不准出现真实邮箱服务商域名（EMAIL_PROVIDER_DOMAINS：gmail、naver、qq、163、outlook、
       hotmail、icloud、kakao、daum 等，含子域名、大小写、URL 里的 %40 写法）的地址——仓库是公开的，真人能收信的地址不进仓库；
       要“像一个邮箱”的地方用 example.com、lemomemo.test 这类保留域名。只放行 EMAIL_FAKE_OK 白名单里明显是假的夹具地址
       （整个地址完全相同才算）；报错里 @ 前面只露第一个字符。EMAIL_PENDING 是别人正在清的文件，清完删掉那一行（真仓库会报警告提醒）
  BINIMPORT 会被当代码执行的目标不准是二进制扩展名（BIDI_BINARY_EXT 加 .node、.so、.dylib；B1 接手清单 LINT-binimport，扫的文件同 BIDI）：
       JS/TS 的 import、require、import()、createRequire、importScripts、Worker、eval / vm.* / dlopen（含别名、字符串拼接），非 JS 入口
       （package.json scripts、根目录 deno.json(c) 的 tasks、yml 的 run:、.sh、.ps1、JS/TS 里的 command 字符串、.html 的 script src）里解释器
       执行的文件。实现、细节和剩余风险在 build/check_binimport.mjs（TypeScript 编译器 API，CI-10）
有错误时退出码 1，只有警告时 0。--root 给自测用（tests/arch-fixtures/check_arch/ 下的样例目录）。
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "build"))
from check_backend import parse_sources  # noqa: E402  A20、A19 的去注释源码（TypeScript AST，和 check_backend 同一份 check_backend_ast.mjs）

RULES = ("A14", "A20", "A19", "W2", "P142", "A24", "BIDI", "EMAIL", "BINIMPORT")

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
# dist/web 里放行的特征：publishable key 本来就是公开值，预览、正式构建经 VITE_PUBLIC_ANON_KEY 有意编进网页
# （环境清单“anon / publishable key（公开）”；线上预览站页面脚本里就有）。src、shared 里照旧报：密钥不许写死在源码里，只许走环境变量。
# 12ba238 起 deploy-preview 在构建后跑 check_arch，仓库变量填的是 sb_publishable_…，这条误报让预览构建失败（11-03 运维排查）。
DIST_PUBLIC_OK = {"sb_publishable_ 密钥"}
# A14 的 JWK 私钥特征（架构 0.51 第 2 条、2.3 A14）：VAPID 私钥 0.50 起是一行 JWK，值本身漏进源码或产物时只认变量名认不出。
# 同一个对象里（kty 键前后 300 个字符以内）有 d 键、且值是 43 个 base64url 字符（32 字节，P-256 私钥）就报。
# 键名带不带引号、单双引号、冒号前后有没有空格都认（源码对象字面量、压缩过的 JSON）。只有公钥（kty、x、y，没有 d）不报。
# 键名前面不能紧跟标识符字符：id、kid 之类不会被当成 d；值后面紧跟引号，正好 43 个字符
# 转义写法也认：JWK 整串放在一个 JSON 字符串里时引号变成 \"（"{\"kty\":\"EC\",…\"d\":\"…\"}"），键名和值前后都允许 \"（B2 代码审查 S1）
JWK_KTY_RE = re.compile(r"""(?:(?<![A-Za-z0-9_$])kty|\\?"kty\\?"|'kty')\s*:""")
JWK_D_RE = re.compile(r"""(?:(?<![A-Za-z0-9_$"'])d|\\?"d\\?"|'d')\s*:\s*\\?["'][A-Za-z0-9_-]{43}\\?["']""")
JWK_WINDOW = 300


def find_jwk_private(text):
    """返回第一处 JWK 私钥 d 的位置（没有返回 None）"""
    for m in JWK_KTY_RE.finditer(text):
        lo = max(0, m.start() - JWK_WINDOW)
        hi = min(len(text), m.end() + JWK_WINDOW)
        d = JWK_D_RE.search(text, lo, hi)
        if d:
            return d.start()
    return None


ENV_OK = {"MODE", "DEV", "PROD", "BASE_URL", "SSR"}
ENV_RE = re.compile(r"import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)")
ENV_INDEX_RE = re.compile(r"import\.meta\.env\s*\[")
CJK = re.compile(r"[ᄀ-ᇿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]")
EXEMPT_HEADER = "// i18n-exempt: 解析词表"
# 只允许这两个目录的文件用文件头豁免（架构 2.3 A20）
EXEMPT_HEADER_DIRS = ("shared/logic/parse/", "shared/logic/notes/classify-rules.ts")
SOURCE_EXT = (".ts", ".tsx", ".mts", ".js", ".mjs")


def a20_exempt(rel, head):
    """head()：读文件开头（只有可能用文件头豁免的目录才读）"""
    # 公共词典；tz-zh、tz-ko 是 11-05 从公共词典拆出的时区词典（只给登录页恢复页、邮件用，不进主 App 首屏），逐个登记
    # ro-zh、ro-ko 是 11-06 拆出的只读行词典（FA-2，只给按需下载的只读行部件用，不进首屏）；edit-zh、edit-ko 是三个编辑页共用的词典（11-11）；desk-zh、desk-ko 是电脑版布局词典（B6，只给按需下载的 DeskLayout 用）
    if rel in ("shared/i18n/zh.ts", "shared/i18n/ko.ts", "shared/i18n/tz-zh.ts", "shared/i18n/tz-ko.ts", "shared/i18n/ro-zh.ts", "shared/i18n/ro-ko.ts",
               "shared/i18n/edit-zh.ts", "shared/i18n/edit-ko.ts", "shared/i18n/desk-zh.ts", "shared/i18n/desk-ko.ts"):
        return True
    if re.match(r"src/features/[^/]+/i18n/[^/]+\.ts$", rel):
        return True
    if rel.endswith("-data.ts"):
        return True
    if rel.startswith("tests/") or "/__tests__/" in rel:
        return True
    if rel.startswith(EXEMPT_HEADER_DIRS) and head().startswith(EXEMPT_HEADER):
        return True
    return False


def stripped_code(root, rels):
    """rel → 去掉注释的源码（check_backend_ast.mjs 按 TypeScript AST 把注释区间换成空格，和原文等长、换行不变；
    正则、模板字符串、JSX 文本不会被误当成注释）。解析器出错的文件是 None"""
    res = parse_sources([(rel, root / rel, False, None) for rel in rels])
    return {rel: (None if v["parseError"] and not v["code"] else v["code"]) for rel, v in res.items()}


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
                if top == "dist/web" and name in DIST_PUBLIC_OK:
                    continue
                m = rx.search(text)
                if m:
                    line = text.count("\n", 0, m.start()) + 1
                    errors.append(("A14", rel, line, f"疑似密钥特征：{name}"))
            pos = find_jwk_private(text)
            if pos is not None:
                line = text.count("\n", 0, pos) + 1
                errors.append(("A14", rel, line, "疑似密钥特征：JWK 私钥（kty 附近有 43 个字符的 d）"))
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


def a20_files(root):
    """A20 要查的文件（相对路径）：src、shared 下的 .ts / .tsx，去掉 .d.ts 和豁免的"""
    out = []
    for top in ("src", "shared"):
        for p in iter_files(root, top, (".ts", ".tsx")):
            rel = p.relative_to(root).as_posix()
            if not rel.endswith(".d.ts") and not a20_exempt(rel, lambda p=p: p.read_text(encoding="utf-8")[:len(EXEMPT_HEADER)]):
                out.append(rel)
    return out


def a19_files(root):
    """A19 要扫路径字面量的文件：src/sw 下除 routes.ts、__tests__ 以外的 .ts"""
    return [rel for rel in (p.relative_to(root).as_posix() for p in iter_files(root, "src/sw", (".ts",)))
            if rel != SW_ROUTES and "/__tests__/" not in rel]


def unparsable(rule, rel, errors):
    errors.append((rule, rel, 1, "TypeScript 解析器处理不了这个文件，去不了注释、没法核对：按可疑报"))


def check_a20(root, errors, codes):
    for rel in a20_files(root):
        code = codes[rel]
        if code is None:
            unparsable("A20", rel, errors)
            continue
        for ln, line in enumerate(code.splitlines(), 1):
            m = CJK.search(line)
            if m:
                errors.append(("A20", rel, ln, f"字符串或 JSX 文本里有汉字或谚文：{line.strip()[:40]}"))


SW_PREFIXES_RE = re.compile(r"NETWORK_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]")
SW_REQUIRED = ("/sb", "/files")
SW_ROUTES = "src/sw/routes.ts"
# 字符串、模板字符串或正则字面量里以 /sb、/files 这一段开头（/sbx、/filesystem 不算）
SW_PATH_LITERAL = re.compile(r"""['"`]/(sb|files)(?![A-Za-z0-9_-])|/\^?\\/(sb|files)(?![A-Za-z0-9_-])""")


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def check_a19(root, errors, codes):
    if not (root / "src" / "sw").exists():
        return
    if not (root / SW_ROUTES).exists():
        errors.append(("A19", SW_ROUTES, 0, "缺 SW 的路由表 routes.ts（NETWORK_ONLY_PREFIXES）"))
    elif codes[SW_ROUTES] is None:
        unparsable("A19", SW_ROUTES, errors)
    else:
        code = codes[SW_ROUTES]
        m = SW_PREFIXES_RE.search(code)
        listed = set(re.findall(r"""['"]([^'"]+)['"]""", m.group(1))) if m else set()
        for need in SW_REQUIRED:
            if need not in listed:
                errors.append(("A19", SW_ROUTES, line_of(code, m.start()) if m else 0,
                               f"NETWORK_ONLY_PREFIXES 里没有 '{need}'：{need}/* 必须只走网络、不进 Cache Storage"))
    for rel in a19_files(root):
        code = codes[rel]
        if code is None:
            unparsable("A19", rel, errors)
            continue
        for m in SW_PATH_LITERAL.finditer(code):
            seg = m.group(1) or m.group(2)
            errors.append(("A19", rel, line_of(code, m.start()),
                           f"sw 里另写了 /{seg} 的路径：只走网络的路径只在 routes.ts 的 NETWORK_ONLY_PREFIXES 里登记"))


def check_w2(root, warnings, today):
    next_year = today.year + 1
    for country in ("cn", "kr"):
        d = root / "src" / "public" / "holidays" / country
        f = d / f"{next_year}.json"
        rel = d.relative_to(root).as_posix()
        if not f.exists():
            warnings.append(("W2", rel, 0, f"缺明年的节假日文件 {next_year}.json"))
            continue
        # 架构 5.12：中国明年未公布时放 pending 空文件，W2 照常报警告，提醒公布后换成真实数据
        try:
            pending = json.loads(f.read_text(encoding="utf-8")).get("pending") is True
        except (ValueError, AttributeError):
            pending = False  # 格式错归 tools/holidays/check.mjs 管
        if pending:
            warnings.append(("W2", rel, 0, f"明年的节假日文件 {next_year}.json 还是 pending（未公布），公布后换成真实数据"))


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
    """要扫的文件 [(rel, 路径)]（BIDI、EMAIL、BINIMPORT 共用，main 只取一次）：git ls-files（已跟踪 + 未忽略的新文件）的全部文件，
    强制提交进 git 的 node_modules 也扫；--root 指的目录不在 git 里、或 git 出错（自测的临时目录）就整棵树走一遍，
    这时才排除 node_modules 和 .git。二进制不在这里排除，由 scan_texts 按“扩展名 + 含 NUL”判定"""
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
    return [(rel, root / rel) for rel in rels if (root / rel).is_file()]


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


def scan_texts(rel, p):
    """BIDI、EMAIL 共用：读文件并判二进制。是二进制返回 None，否则返回（各种解码的文本列表, 是不是代码类扩展名）"""
    data = p.read_bytes()
    low = rel.lower()
    head_has_nul = bidi_head_has_nul(data)
    # 二进制：扩展名在 BIDI_BINARY_EXT 里、并且前 8000 字节含 NUL 才跳过（.png 能被 require 当 JS、.bin 能被 python 当脚本跑）
    if low.endswith(BIDI_BINARY_EXT) and head_has_nul:
        return None
    code_file = low.endswith(BIDI_CODE_EXT)
    # 代码和认得的文本扩展名无条件扫，
    # 只有没扩展名或扩展名不认识的文件才保留 NUL 判定（防在注释里塞 0xFF、NUL 绕过检查），同样只看前 8000 字节
    if not code_file and not low.endswith(BIDI_TEXT_EXT) and head_has_nul:
        return None
    return bidi_decode(data), code_file


def scan_all(files):
    """每个文件读一次、判一次二进制：[(rel, scan_texts 的结果)]，BIDI、EMAIL 共用"""
    return [(rel, scan_texts(rel, p)) for rel, p in files]


def check_bidi(scanned, errors):
    bs = chr(92)
    for rel, texts_or_none in scanned:
        # 文件名（相对路径）本身也扫：git diff、编辑器里显示的路径同样会被双向字符翻转
        for m in BIDI_RE.finditer(rel):
            if m.group(0) in BIDI_CHARS:
                cp = ord(m.group(0))
                errors.append(("BIDI", rel, 0, f"文件名里原样出现看不见的控制字符 U+{cp:04X}（Trojan Source 一类），要改名"))
        if texts_or_none is None:
            continue
        texts, code_file = texts_or_none
        exempt = BIDI_EXEMPT.get(rel, {})
        # 多种解码的命中合并：同一（行号, 码位）取各解码里出现次数的最大值，同一处不重复报
        merged = {}
        for text in texts:
            counts = {}
            for key in bidi_hits(text, code_file, exempt):
                counts[key] = counts.get(key, 0) + 1
            for key, n in counts.items():
                merged[key] = max(merged.get(key, 0), n)
        for (line, cp), n in sorted(merged.items()):
            esc = f"{bs}u{cp:04x}" if cp <= 0xFFFF else f"{bs}u{{{cp:x}}}"
            for _ in range(n):
                errors.append(("BIDI", rel, line, f"原样出现看不见的控制字符 U+{cp:04X}（Trojan Source 一类），要写成转义 {esc}"))


# EMAIL（11-11，仓库是公开的）：跟踪的文字文件里不准出现真实邮箱服务商域名的地址——真人能收信的地址（负责人的验收账号别名、
# 示例里随手写的本人邮箱）进了公开仓库就收不回来。要“像一个邮箱”的地方用保留域名（example.com、lemomemo.test）的占位地址。
# 只按域名认，不带域名的别名写法（名字+别名）认不出，靠评审。本文件不许出现任何真实地址（白名单里的都是假的）
EMAIL_PROVIDER_DOMAINS = (
    "gmail.com", "googlemail.com", "outlook.com", "outlook.kr", "hotmail.com", "live.com", "live.cn", "msn.com",
    "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.co.jp", "yahoo.co.kr", "ymail.com", "aol.com",
    "proton.me", "protonmail.com", "pm.me", "gmx.com", "zoho.com", "fastmail.com", "yandex.com", "yandex.ru", "mail.ru",
    "naver.com", "kakao.com", "daum.net", "hanmail.net", "nate.com",
    "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn", "sohu.com", "aliyun.com", "139.com", "189.cn",
)
# 从 @（或 URL 里的 %40）往后认域名，子域名（vip.qq.com）也算；域名后面不能再跟字母数字（gmail.community 不算）。
# 先找 @ 再回头取 @ 前面的那一段：整段从前往后配的话，遇到没有 @ 的超长 base64 会退成平方级
EMAIL_AT_RE = re.compile(
    r"(?:@|%40)((?:[a-z0-9-]+\.)*(?:" + "|".join(re.escape(d) for d in EMAIL_PROVIDER_DOMAINS) + r"))(?![a-z0-9-])",
    re.IGNORECASE,
)
EMAIL_LOCAL_RE = re.compile(r"[A-Za-z0-9._%+-]{1,64}\Z")
# 白名单：明显是假的夹具地址（全小写、整个地址完全相同才放行）→ 为什么是假的。加新地址前先想能不能改用 example.com
EMAIL_FAKE_OK = {
    "someone@gmail.com": "测试里泛指“随便一个真实服务商的邮箱”的反例（应被 not_test_email 拦下），someone 是占位词",
    "boss@gmail.com": "preview-login-as-admin 测试里“E2E_ADMIN_EMAIL 填成真实服务商邮箱”的反例，boss 是占位词",
    "owner@gmail.com": "preview-login 测试里 PREVIEW_OWNER_EMAILS 名单的反例，owner 是角色名",
    "owner.sample@gmail.com": "登录页改邮箱的界面测试里往输入框填的样例，sample 写明是样例",
    "owner.real@gmail.com": "preview-login 系列测试里“负责人的真实邮箱”这个角色的替身，不是谁的地址",
    "jimin.kim@naver.com": "设计线框里“被邀请的朋友”的示意地址，用韩国常见人名拼的样例",
    "lemomemo.test@gmail.com": "account-purge 测试里 isTestRecipient 的反例：把测试域名 lemomemo.test 写在 @ 前面",
}
# 待清理：11-11 清真实邮箱时由别人在处理的两处，本规则先不拦。清完（或文件删了）以后把那一行删掉——真仓库里会报警告提醒
EMAIL_PENDING: dict[str, str] = {}


def email_hits(text):
    """一种解码下的命中：{(行号, 遮住 @ 前面的地址)}。白名单里的、@ 前面没有字母数字的（SQL 的 like '%@…'、只写域名后缀）不算"""
    hits = set()
    for m in EMAIL_AT_RE.finditer(text):
        lm = EMAIL_LOCAL_RE.search(text, max(0, m.start() - 64), m.start())
        local = lm.group(0) if lm else ""
        domain = m.group(1).lower()
        if not any(c.isalnum() for c in local) or f"{local.lower()}@{domain}" in EMAIL_FAKE_OK:
            continue
        # 报错只露第一个字符：CI 日志也是公开的，不把地址再抄一遍
        hits.add((text.count("\n", 0, m.start()) + 1, f"{local[0]}***@{domain}"))
    return hits


def check_email(root, errors, warnings, scanned=None):
    """scanned：scan_all 的结果（main 和 BIDI 共用一份）；单独调（测试）时自己扫"""
    still_pending = set()
    for rel, texts_or_none in scan_all(bidi_files(root)) if scanned is None else scanned:
        if texts_or_none is None:
            continue
        hits = set().union(*(email_hits(text) for text in texts_or_none[0]))
        if rel in EMAIL_PENDING:
            if hits:
                still_pending.add(rel)
            continue
        for line, masked in sorted(hits):
            errors.append(("EMAIL", rel, line,
                           f"出现真实邮箱服务商的地址 {masked}：公开仓库里不写真人能收信的地址，换成 example.com、lemomemo.test "
                           f"这类保留域名的占位地址；确实是假的夹具地址，才加进 EMAIL_FAKE_OK 并写明为什么是假的"))
    if root == REPO_ROOT:
        for rel in sorted(set(EMAIL_PENDING) - still_pending):
            warnings.append(("EMAIL", rel, 0, "已经没有真实邮箱服务商的地址（或文件已删）：把它从 build/check_arch.py 的 EMAIL_PENDING 里删掉"))


# BINIMPORT（B1 接手清单 LINT-binimport）：会被当代码执行的目标不准是二进制扩展名。
# NUL 在前 8000 字节的 .png 里写 JS，git 和 GitHub 当二进制、评审看不到内容，但 require('./x.png') 照样执行（BIDI 管不到）。
# 规则细节和实现在 build/check_binimport.mjs（TypeScript 编译器 API 解析 JS/TS；非 JS 入口只查本仓库调解释器的几处，CI-10），这里只送文件清单
BINIMPORT_EXT = BIDI_BINARY_EXT + (".node", ".so", ".dylib")
BINIMPORT_SCRIPT = pathlib.Path(__file__).resolve().parent / "check_binimport.mjs"


def check_binimport(root, errors, files=None):
    """files：bidi_files 的结果（main 只取一次）；单独调（测试计时）时自己取。check_binimport.mjs 先按扩展名挑再读内容"""
    files = [rel for rel, _ in (bidi_files(root) if files is None else files)]
    payload = json.dumps({"root": str(root), "binExt": list(BINIMPORT_EXT), "files": files}, ensure_ascii=False)
    r = subprocess.run(["node", str(BINIMPORT_SCRIPT)], input=payload.encode("utf-8"), capture_output=True, cwd=str(REPO_ROOT))
    if r.returncode != 0:
        raise SystemExit(f"build/check_binimport.mjs 跑不起来（要先 npm ci 装好 typescript）：{r.stderr.decode('utf-8', 'replace')}")
    for e in json.loads(r.stdout.decode("utf-8")):
        errors.append(("BINIMPORT", e["file"], e["line"], e["message"]))


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(REPO_ROOT))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--today", help="自测用：YYYY-MM-DD，决定 W2 的“明年”")
    ap.add_argument("--only", help=f"逗号分隔的规则名，只跑这几条：{','.join(RULES)}")
    args = ap.parse_args(argv)
    only = set(RULES) if args.only is None else {r.strip() for r in args.only.split(",") if r.strip()}
    if not only or only - set(RULES):
        ap.error(f"--only 里有不认识的规则名：{','.join(sorted(only - set(RULES))) or '（空）'}；可选 {','.join(RULES)}")
    root = pathlib.Path(args.root).resolve()
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()

    errors, warnings = [], []
    # 文件清单（git ls-files）和文件内容各只取一次：A20、A19 的去注释源码一次送进 node；BIDI、EMAIL 共用一份读好的文本
    codes = stripped_code(root, sorted(set(
        (a20_files(root) if "A20" in only else [])
        + ([SW_ROUTES, *a19_files(root)] if "A19" in only and (root / SW_ROUTES).exists() else []))))
    files = bidi_files(root) if only & {"BIDI", "EMAIL", "BINIMPORT"} else []
    scanned = scan_all(files) if only & {"BIDI", "EMAIL"} else []
    steps = [
        ("A14", lambda: check_a14(root, errors)),
        ("A20", lambda: check_a20(root, errors, codes)),
        ("A19", lambda: check_a19(root, errors, codes)),
        ("W2", lambda: check_w2(root, warnings, today)),
        ("P142", lambda: check_p142(root, errors)),
        ("A24", lambda: check_a24_disable(root, errors)),
        ("BIDI", lambda: check_bidi(scanned, errors)),
        ("EMAIL", lambda: check_email(root, errors, warnings, scanned)),
        ("BINIMPORT", lambda: check_binimport(root, errors, files)),
    ]
    for rule, run in steps:
        if rule in only:
            run()

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
