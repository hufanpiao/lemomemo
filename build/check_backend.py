"""后端的静态检查：服务器函数的钥匙范围、迁移的写法（B0 返工：QA D-01，安全审查中 1，代码审查中 1）。

用法：python -I build/check_backend.py [--root 目录] [--json]
有错误时退出码 1。--root 给自测用（tests/arch-fixtures/check_backend/ 下的样例目录，tests/build/check-backend.test.ts）。

服务器函数（supabase/functions/<函数名>/，下划线开头的目录是共用模块）：
  F1  任何地方不准出现 SUPABASE_DB_URL（注释不算）。架构 6.2、8.4、TC-B0-35
  F2  引到 _shared/db.ts（直接 import，或经别的 _shared 模块间接 import）的函数必须在 DB_FUNCS 里；
      函数自己的代码用 fn_vault / FN_VAULT_DB_URL 的只能是 VAULT_FUNCS，用 fn_ai / FN_AI_DB_URL 的只能是 AI_FUNCS；
      _shared 里只有 db.ts 能读这两个连接串。架构 6.2 表格、8.4、TC-B0-35
  F3  引到 objstore（_shared/objstore*.ts、_shared/gen/objstore*.ts）或直接 import aws4fetch、读 R2_* 的函数必须在 R2_FUNCS 里；
      服务器函数一律不准读 R2_FILES_* / R2_PULL_*（那是 Pages 和负责人本机的令牌）；_shared 里只有 objstore*.ts 能读 R2_*。
      架构第 6 节开头（0.32）、8.4、TC-B0-75、S-B0 ⑦
  F5  disabled_at 只准出现在 _shared/auth.ts、account、account-purge（生成目录 _shared/gen/ 不算）。架构 0.29 续第 138 条④、TC-B0-97 ④
Pages Functions（functions/）和 App、shared：
  F4  functions/ 里只有 /files（functions/files/**、functions/_lib/files-*.ts）能 import shared/objstore*.ts、aws4fetch，读 R2_*；
      functions/、src/、shared/ 一律不准出现 R2_FN_*、R2_PULL_*、SUPABASE_DB_URL、FN_VAULT_DB_URL、FN_AI_DB_URL。架构 0.32 第 4 条、8.4
迁移（supabase/migrations/*.sql）：
  M1  security definer 函数必须写 set search_path = ''（create function 和 alter function 都查，属性写在函数体前后都认）。
      架构 0.29 续第 117 条、TC-B0-92
  M2  0001 第一句是 alter default privileges for role postgres revoke execute on functions from public；
      每个函数的 grant / revoke execute 写在建它的同一个文件里、紧跟建函数的语句（中间不能隔别的语句；不写 grant 不算错，默认权限兜底，TC-B0-73 ④）；
      整段 revoke（on all functions in schema）、alter default privileges … on functions 只准在 0001。架构 0.29 续第 32、39 条、3.3 C（0.33）、TC-B0-73 ①②
  M4  授权汇总和架构 3.3 C 逐行比对（TC-B0-73 ①）：迁移里归 3.3 C 管的每一句（函数默认权限、整段收回 private、private 的 schema usage、
      private 函数的 grant / revoke execute、private 表给客户端和 service_role 的 grant、public 表给 service_role 的 grant）都要在 3.3 C 里、
      写在行尾标的文件；3.3 C 标 0001～0007 的每一行在那个文件里恰好一次；标 B1 等的只准进带时间戳的新迁移；附录 A 末尾的语句行和 3.3 C 一字不差。
      给 fn_vault、fn_ai 的表授权归 D1 和 6.2 比（附录 A 末尾注明），对具体 private 表的 revoke 只收不放，不在汇总里
  M5  0001 的先后：全局默认权限 → table_meta、table_meta_of()、touch() → 各表；9 张同步表建表后的下一句是它的 table_meta 行。TC-B0-73 ③、0.29 续第 39 条
  M6  9 张同步表的 (user_id, synced_at) 索引写在建表的文件里。TC-B0-73 ⑤
  M3  0001～0007 七个建表文件里不准打开功能开关：app_config.features 的列默认值里只有 event、todo 能是 on: true，
      不准 update app_config、不准 insert 时写 features、不准 alter column features set default 打开（只准写 JSON 字面量，QA 第二轮 D-15）；
      打开 note、anniv 用带时间戳的数据迁移。架构 0.29 第 1 条（P-02）、TC-B0-68
白名单在脚本里只写一份，出处见每个常量旁的注释；名单的唯一出处是架构 6.2 末尾“越界检查白名单”，改名单要先改架构。
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_arch import strip_comments  # noqa: E402  去掉 // 和 /* */，行号不变

# 架构 6.2 末尾越界检查白名单（唯一出处）；6.2 表格、8.4 FN_VAULT_DB_URL 一行：fn_vault 的连接串只给这三个函数
VAULT_FUNCS = frozenset({"vault", "vault-file", "account"})
# 架构 6.2 末尾越界检查白名单（唯一出处）；6.2 表格、8.4：fn_ai 的五个函数，加上只为验 pin_epoch 直连的 ai-parse、ai-voice、vault-image（0.23 安全复核 A2）
AI_FUNCS = frozenset({"ai-embed", "ai-media", "note-search", "ai-summarize", "file-check", "ai-parse", "ai-voice", "vault-image"})
# 能 import _shared/db.ts 的 = 两组的并集
DB_FUNCS = VAULT_FUNCS | AI_FUNCS
# 架构 6.2 末尾越界检查白名单（唯一出处）；第 6 节开头（0.32，R-213）、8.4 R2_FN_* 一行：只有这九个函数能 import _shared/objstore.ts 或读 R2_FN_*、R2_ENDPOINT、R2_BUCKET_PREFIX
R2_FUNCS = frozenset({"file-check", "ai-media", "vault", "vault-file", "vault-image", "storage-sweep", "account", "account-purge", "usage-report"})
# 架构 0.29 续第 138 条④：除这三处以外不准出现 disabled_at（一律经 _shared/auth.ts 的 isUsable / usableUserIds）
DISABLED_AT_OK = ("_shared/auth.ts", "account/", "account-purge/")

SOURCE_EXT = (".ts", ".tsx", ".mts", ".js", ".mjs")
FN_ROOT = "supabase/functions"

# import 的三种写法：import … from '…' / export … from '…'、import '…'、import('…')
FROM_RE = re.compile(r"""\b(import|export)\b([^;'"`]*?)\bfrom\s*(['"])([^'"]+)\3""")
BARE_RE = re.compile(r"""\bimport\s*(['"])([^'"]+)\1""")
DYN_RE = re.compile(r"""\bimport\s*\(\s*(['"])([^'"]+)\1""")
OBJSTORE_SPEC = re.compile(r"(^|/)objstore[\w-]*(\.ts)?$")
AWS4FETCH_SPEC = re.compile(r"^(npm:)?aws4fetch(@[^/]*)?(/|$)")
R2_NAME = re.compile(r"\bR2_[A-Z0-9_]+")
VAULT_USE = re.compile(r"""\bFN_VAULT_DB_URL\b|['"`]fn_vault['"`]""")
AI_USE = re.compile(r"""\bFN_AI_DB_URL\b|['"`]fn_ai['"`]""")
PAGES_FORBIDDEN = re.compile(r"\b(R2_FN_[A-Z0-9_]*|R2_PULL_[A-Z0-9_]*|SUPABASE_DB_URL|FN_VAULT_DB_URL|FN_AI_DB_URL)\b")


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def imports(code):
    """[(行号, spec, 只是类型)]"""
    out = []
    for m in FROM_RE.finditer(code):
        out.append((line_of(code, m.start()), m.group(4), bool(re.match(r"\s*type\b", m.group(2)))))
    for rx in (BARE_RE, DYN_RE):
        for m in rx.finditer(code):
            out.append((line_of(code, m.start()), m.group(2), False))
    return out


class Fns:
    """supabase/functions 下的源码：去掉注释的代码、相对 import 的边"""

    def __init__(self, root):
        self.root = root
        self.base = root / FN_ROOT
        self.code = {}
        if self.base.exists():
            for p in sorted(self.base.rglob("*")):
                if p.is_file() and p.suffix in SOURCE_EXT and "node_modules" not in p.parts:
                    self.code[p.relative_to(self.base).as_posix()] = strip_comments(p.read_text(encoding="utf-8"))
        self._closure = {}

    def edges(self, rel):
        """rel 的 import：[(行号, 目标 rel 或 None, spec)]；类型 import 跳过（编译后不存在）"""
        out = []
        for line, spec, type_only in imports(self.code[rel]):
            if type_only:
                continue
            target = None
            if spec.startswith("."):
                p = (self.base / rel).parent / spec
                try:
                    t = p.resolve().relative_to(self.base.resolve()).as_posix()
                    target = t if t in self.code else None
                except ValueError:
                    target = None   # 指到 supabase/functions 外面（部署时不存在），按 spec 判断
            out.append((line, target, spec))
        return out

    def closure(self, rel):
        """从 rel 出发能引到的文件和外部 spec（含自己）"""
        if rel in self._closure:
            return self._closure[rel]
        files, specs, todo = {rel}, set(), [rel]
        while todo:
            cur = todo.pop()
            for _, target, spec in self.edges(cur):
                specs.add(spec)
                if target and target not in files:
                    files.add(target)
                    todo.append(target)
        self._closure[rel] = (files, specs)
        return files, specs


def owner(rel):
    """函数名；共用模块（_shared 等下划线开头的目录、根目录的文件）返回 None"""
    top = rel.split("/", 1)[0]
    return None if "/" not in rel or top.startswith("_") else top


def is_db(rel):
    return rel == "_shared/db.ts"


def is_objstore_file(rel):
    return re.match(r"^_shared/(gen/)?objstore[\w-]*\.ts$", rel) is not None


def touches_objstore(files, specs):
    return any(is_objstore_file(f) for f in files) or any(OBJSTORE_SPEC.search(s) or AWS4FETCH_SPEC.match(s) for s in specs)


def check_functions(root, errors):
    fns = Fns(root)
    for rel, code in fns.code.items():
        path = f"{FN_ROOT}/{rel}"
        fn = owner(rel)
        gen = rel.startswith("_shared/gen/")

        # F1
        for m in re.finditer(r"\bSUPABASE_DB_URL\b", code):
            errors.append(("F1", path, line_of(code, m.start()), "服务器函数禁止用默认的 SUPABASE_DB_URL（postgres 角色，绕开 RLS），直连一律经 _shared/db.ts 用 fn_vault / fn_ai"))

        # F5
        if not gen and not rel.startswith(DISABLED_AT_OK):
            for m in re.finditer(r"\bdisabled_at\b", code):
                errors.append(("F5", path, line_of(code, m.start()), "disabled_at 只准出现在 _shared/auth.ts、account、account-purge；判断账号能不能用一律经 _shared/auth.ts 的 isUsable / usableUserIds（private.account_usable）"))

        if gen:
            continue   # 生成目录是 shared/ 的副本，F4 在 shared/ 上查

        if fn is None:
            # 共用模块：连接串只在 db.ts 读；R2_* 只在 objstore*.ts 读，而且不准是 R2_FILES_* / R2_PULL_*
            if not is_db(rel):
                for m in re.finditer(r"\bFN_(VAULT|AI)_DB_URL\b", code):
                    errors.append(("F2", path, line_of(code, m.start()), f"{m.group(0)} 只准在 _shared/db.ts 里读"))
            for m in R2_NAME.finditer(code):
                name = m.group(0)
                if name.startswith(("R2_FILES_", "R2_PULL_")):
                    errors.append(("F3", path, line_of(code, m.start()), f"服务器函数不准读 {name}（Pages / 本机的令牌），用 R2_FN_*"))
                elif not is_objstore_file(rel):
                    errors.append(("F3", path, line_of(code, m.start()), f"{name} 只准在 _shared/objstore.ts 里读"))
            continue

        # 函数自己的文件：经 import 引到的东西（同一个函数目录里的文件各自检查，这里只看引到目录外的）
        for line, target, spec in fns.edges(rel):
            if target is not None and owner(target) == fn:
                continue
            files, specs = fns.closure(target) if target else (set(), set())
            specs = specs | {spec}
            via = f"（经 {target}）" if target and not is_db(target) and not is_objstore_file(target) else ""
            if fn not in DB_FUNCS and (any(is_db(f) for f in files)):
                errors.append(("F2", path, line, f"{fn} 不在能直连数据库的名单里，却引到 _shared/db.ts{via}（名单见架构 6.2）"))
            if fn not in R2_FUNCS and touches_objstore(files, specs):
                errors.append(("F3", path, line, f"{fn} 不在能用 R2 的九个函数里，却引到对象存储（objstore / aws4fetch）{via}（名单见架构第 6 节开头）"))

        # 函数自己的代码：角色和变量
        for m in VAULT_USE.finditer(code):
            if fn not in VAULT_FUNCS:
                errors.append(("F2", path, line_of(code, m.start()), f"{fn} 用了 fn_vault（{m.group(0)}），只有 vault、vault-file、account 能用"))
        for m in AI_USE.finditer(code):
            if fn not in AI_FUNCS:
                errors.append(("F2", path, line_of(code, m.start()), f"{fn} 用了 fn_ai（{m.group(0)}），不在 fn_ai 的名单里"))
        for m in R2_NAME.finditer(code):
            name = m.group(0)
            if name.startswith(("R2_FILES_", "R2_PULL_")):
                errors.append(("F3", path, line_of(code, m.start()), f"服务器函数不准读 {name}（Pages / 本机的令牌），用 R2_FN_*"))
            elif fn not in R2_FUNCS:
                errors.append(("F3", path, line_of(code, m.start()), f"{fn} 不在能用 R2 的九个函数里，却读 {name}"))


def iter_code(root, top):
    base = root / top
    if not base.exists():
        return
    for p in sorted(base.rglob("*")):
        if p.is_file() and p.suffix in SOURCE_EXT and "node_modules" not in p.parts:
            yield p.relative_to(root).as_posix(), strip_comments(p.read_text(encoding="utf-8"))


def files_scope(rel):
    return rel.startswith("functions/files/") or re.match(r"^functions/_lib/files-[^/]+$", rel) is not None


def check_pages(root, errors):
    for top in ("functions", "src", "shared"):
        for rel, code in iter_code(root, top):
            for m in PAGES_FORBIDDEN.finditer(code):
                errors.append(("F4", rel, line_of(code, m.start()), f"{m.group(0)} 只给 Supabase 的服务器函数（或负责人本机）用，Pages、App、shared 里不准出现"))
            if top != "functions" or files_scope(rel):
                continue
            for line, spec, _ in imports(code):
                if OBJSTORE_SPEC.search(spec) or AWS4FETCH_SPEC.match(spec):
                    errors.append(("F4", rel, line, f"Pages Functions 里只有 /files 能用对象存储（{spec}）"))
            for m in R2_NAME.finditer(code):
                if not PAGES_FORBIDDEN.match(m.group(0)):
                    errors.append(("F4", rel, line_of(code, m.start()), f"Pages Functions 里只有 /files 能读 {m.group(0)}"))


# ---------------- 迁移 ----------------

def sql_statements(raw):
    """切成语句：[(起始偏移, 原文, 遮住字符串内容的文本)]。注释换成空格（行号不变）；
    单引号字符串和 $tag$ 字符串的内容换成 x（引号和 tag 留着，'' 仍是 ''），这样属性只会在字符串外面匹配到"""
    masked, i, n = [], 0, len(raw)
    while i < n:
        c = raw[i]
        if raw.startswith("--", i):
            j = raw.find("\n", i)
            j = n if j < 0 else j
            masked.append(" " * (j - i))
            i = j
        elif raw.startswith("/*", i):
            j = raw.find("*/", i + 2)
            j = n if j < 0 else j + 2
            masked.append(re.sub(r"[^\n]", " ", raw[i:j]))
            i = j
        elif c == "'":
            j = i + 1
            while j < n:
                if raw[j] == "'" and raw.startswith("''", j):
                    j += 2
                    continue
                if raw[j] == "'":
                    break
                j += 1
            masked.append("'" + re.sub(r"[^\n]", "x", raw[i + 1:j]) + "'")
            i = j + 1
        elif c == "$" and (m := re.match(r"\$[A-Za-z_]*\$", raw[i:])):
            tag = m.group(0)
            j = raw.find(tag, i + len(tag))
            j = n if j < 0 else j
            masked.append(tag + re.sub(r"[^\n]", "x", raw[i + len(tag):j]) + (tag if j < n else ""))
            i = j + len(tag)
        else:
            masked.append(c)
            i += 1
    text = "".join(masked)[:n]
    out, start = [], 0
    for k, ch in enumerate(text):
        if ch == ";":
            out.append((start, raw[start:k], text[start:k]))
            start = k + 1
    if text[start:].strip():
        out.append((start, raw[start:], text[start:]))
    # 起始偏移挪到第一个非空白字符
    res = []
    for s, r, t in out:
        lead = len(t) - len(t.lstrip())
        if t.strip():
            res.append((s + lead, r[lead:], t[lead:]))
    return res


NAME = r"""((?:"?[A-Za-z_][\w]*"?\.)?"?[A-Za-z_][\w]*"?)"""
CREATE_FN = re.compile(r"^create\s+(?:or\s+replace\s+)?function\s+" + NAME, re.IGNORECASE)
ALTER_FN = re.compile(r"^alter\s+function\s+" + NAME, re.IGNORECASE)
EXEC_PRIV = re.compile(r"^(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(?:execute|all(?:\s+privileges)?)\s+on\s+functions?\s+(.*?)\s+\b(?:to|from)\b", re.IGNORECASE | re.DOTALL)
FIRST_0001 = "alter default privileges for role postgres revoke execute on functions from public"


def fn_key(name):
    name = name.replace('"', "").lower()
    return name if "." in name else f"public.{name}"


def check_migrations(root, errors):
    mig = root / "supabase" / "migrations"
    if not mig.exists():
        return
    parsed = []
    for p in sorted(mig.glob("*.sql")):
        rel = p.relative_to(root).as_posix()
        raw = p.read_text(encoding="utf-8")
        parsed.append((p.name, rel, raw, sql_statements(raw)))

    created = {}   # 函数 → [(文件, 偏移)]
    for name, rel, raw, stmts in parsed:
        for off, _, t in stmts:
            m = CREATE_FN.match(t)
            if m:
                created.setdefault(fn_key(m.group(1)), []).append((rel, off))

    for name, rel, raw, stmts in parsed:
        is_0001 = name.startswith("0001_")
        is_build = re.match(r"^000[1-7]_", name) is not None
        granted = {}   # 函数 → 本文件里 grant / revoke 的偏移
        for off, r, t in stmts:
            line = line_of(raw, off)
            flat = re.sub(r"\s+", " ", t).strip().lower()

            # M1
            m = CREATE_FN.match(t) or ALTER_FN.match(t)
            if m and re.search(r"\bsecurity\s+definer\b", t, re.IGNORECASE) and not re.search(r"\bset\s+search_path\s*(=|to)\s*''", t, re.IGNORECASE):
                errors.append(("M1", rel, line, f"{fn_key(m.group(1))} 是 security definer，没写 set search_path = ''"))

            # M2
            if flat.startswith("revoke") and re.search(r"\bon all functions in schema\b", flat) and not is_0001:
                errors.append(("M2", rel, line, "整段 revoke（on all functions in schema）只准在 0001；别的文件按函数逐个写"))
            if flat.startswith("alter default privileges") and re.search(r"\bon functions\b", flat) and not is_0001:
                errors.append(("M2", rel, line, "函数的默认权限只准在 0001 改"))
            g = EXEC_PRIV.match(t)
            if g and not re.match(r"all\s+functions\s+in\s+schema", g.group(2), re.IGNORECASE):
                for fm in re.finditer(NAME + r"\s*\(", g.group(2)):
                    k = fn_key(fm.group(1))
                    if k not in created:
                        continue   # 不是迁移里建的函数（扩展、auth.* 等），不管
                    if not any(f == rel and o < off for f, o in created[k]):
                        errors.append(("M2", rel, line, f"{k} 的 {g.group(1).lower()} 要写在建它的文件里、紧跟建函数的语句（建在 {created[k][0][0]}）"))
                    granted.setdefault(k, []).append(off)

            # M3
            if is_build:
                if re.match(r"^update\s+(only\s+)?(\"?public\"?\.)?\"?app_config\"?\b", flat):
                    errors.append(("M3", rel, line, "0001～0007 建表文件里不准 update app_config 打开功能开关，用带时间戳的数据迁移"))
                if re.match(r"^insert\s+into\s+(\"?public\"?\.)?\"?app_config\"?\b", flat) and re.search(r"\bfeatures\b", flat):
                    errors.append(("M3", rel, line, "0001～0007 建表文件里插 app_config 不准写 features（用列默认值），开关用带时间戳的数据迁移打开"))
                # 建表时的列默认值；或 alter table app_config … alter column features set default（QA 第二轮 D-15）
                fd = None
                if re.search(r"\bapp_config\b", flat):
                    fd = re.search(r"\bfeatures\s+jsonb\b[^,]*?\bdefault\s+'((?:[^']|'')*)'", r, re.IGNORECASE)
                if re.match(r"^alter\s+table\s+(if\s+exists\s+)?(only\s+)?(\"?public\"?\.)?\"?app_config\"?(\s|$)", flat):
                    sd = re.search(r"\balter\s+(?:column\s+)?\"?features\"?\s+set\s+default\s+(?:'((?:[^']|'')*)'(?:\s*::\s*jsonb)?\s*(?=,|;|$)|.)", r, re.IGNORECASE)
                    if sd and sd.group(1) is None:
                        errors.append(("M3", rel, line_of(raw, off + sd.start()), "0001～0007 建表文件里改 app_config.features 的列默认值只准写 JSON 字面量（才查得了开关开没开）"))
                    elif sd:
                        fd = sd
                if fd:
                    fline = line_of(raw, off + fd.start())
                    try:
                        feats = json.loads(fd.group(1).replace("''", "'"))
                    except ValueError:
                        errors.append(("M3", rel, fline, "app_config.features 的列默认值不是合法的 JSON"))
                        feats = {}
                    for k, v in feats.items():
                        if k not in ("event", "todo") and isinstance(v, dict) and v.get("on") is not False:
                            errors.append(("M3", rel, fline, f"app_config.features 的列默认值里 {k} 不是 on: false：0001～0007 建表文件不准打开开关，用带时间戳的数据迁移"))

        # M2：0001 第一句；本文件建的每个函数，后面都要有本文件的 grant / revoke
        if is_0001:
            first = stmts[0] if stmts else None
            if not first or re.sub(r"\s+", " ", first[2]).strip().lower() != FIRST_0001:
                errors.append(("M2", rel, line_of(raw, first[0]) if first else 1, f"0001 的第一句必须是“{FIRST_0001}”"))
        # 新建函数不写 grant 不算错：0001 的全局默认权限保证 PUBLIC 执行不了（TC-B0-73 ④，D1 核对实际权限）

        # M2“紧跟”（架构 3.3 C 0.33 写法、TC-B0-73 ①）：同一文件里，F 的 grant / revoke execute 只能出现在建 F 那一句后面
        #   连着的一串里（这一串只许是对 F 的 grant / revoke execute）；中间隔了别的语句就失败
        adjacent = set()
        for i, (off, _, t) in enumerate(stmts):
            m = CREATE_FN.match(t)
            if not m:
                continue
            k = fn_key(m.group(1))
            j = i + 1
            while j < len(stmts) and k in exec_targets(stmts[j][2]):
                adjacent.add((k, stmts[j][0]))
                j += 1
        for k, offs in granted.items():
            for off in offs:
                if (k, off) not in adjacent and any(f == rel and o < off for f, o in created.get(k, [])):
                    errors.append(("M2", rel, line_of(raw, off), f"{k} 的 grant / revoke 要紧跟建函数的语句（中间不能隔别的语句）"))

    check_order(parsed, errors)
    check_grant_summary(root, parsed, errors)


def exec_targets(t):
    """grant / revoke execute on function … 里点到的函数（不含 on all functions in schema）"""
    g = EXEC_PRIV.match(t)
    if not g or re.match(r"all\s+functions\s+in\s+schema", g.group(2), re.IGNORECASE):
        return set()
    return {fn_key(fm.group(1)) for fm in re.finditer(NAME + r"\s*\(", g.group(2))}


# 9 张同步表（架构 0.29 第 29 条、4.1；数据字典 4.3b）：建表后下一句是 table_meta 行（0.29 续第 39 条），(user_id, synced_at) 索引写在建表的文件里
SYNC_TABLES = ("settings", "devices", "events", "todos", "categories", "notes", "note_images", "note_files", "anniversaries")
CREATE_TABLE = re.compile(r"^create\s+table\s+(?:if\s+not\s+exists\s+)?" + NAME, re.IGNORECASE)
META_INSERT = re.compile(r"^insert\s+into\s+private\.table_meta\b[^;]*?\bvalues\s*\(\s*'([^']+)'", re.IGNORECASE)
SYNC_INDEX = re.compile(r"^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:\w+\s+)?on\s+(?:only\s+)?" + NAME + r"\s*(?:using\s+\w+\s*)?\(\s*user_id\s*,\s*synced_at\s*\)", re.IGNORECASE)


def check_order(parsed, errors):
    """M5（TC-B0-73 ③）：0001 的先后——全局默认权限 → table_meta、table_meta_of()、touch() → 各表；同步表建表后下一句是它的 table_meta 行。
    M6（TC-B0-73 ⑤）：9 张同步表的 (user_id, synced_at) 索引写在建表的文件里"""
    table_file = {}
    index_files = {}
    for name, rel, raw, stmts in parsed:
        for i, (off, r, t) in enumerate(stmts):
            line = line_of(raw, off)
            ct = CREATE_TABLE.match(t)
            if ct:
                tbl = fn_key(ct.group(1))
                table_file.setdefault(tbl, (rel, line))
                short = tbl.split(".", 1)[1]
                if tbl.startswith("public.") and short in SYNC_TABLES:
                    nxt = META_INSERT.match(stmts[i + 1][1].strip()) if i + 1 < len(stmts) else None
                    if not nxt or nxt.group(1) != short:
                        errors.append(("M5", rel, line, f"{tbl} 建表后的下一句必须是它的 table_meta 行（0.29 续第 39 条）"))
            mi = META_INSERT.match(r.strip())
            if mi:
                prev = CREATE_TABLE.match(stmts[i - 1][2]) if i > 0 else None
                if not prev or fn_key(prev.group(1)) != f"public.{mi.group(1)}":
                    errors.append(("M5", rel, line, f"table_meta 的 {mi.group(1)} 行要紧跟建 public.{mi.group(1)} 的语句"))
            si = SYNC_INDEX.match(t)
            if si:
                index_files.setdefault(fn_key(si.group(1)), []).append((rel, line))

        if not name.startswith("0001_"):
            continue
        tables = [(i, fn_key(m.group(1))) for i, (_, _, t) in enumerate(stmts) if (m := CREATE_TABLE.match(t))]
        if not any(k == "private.table_meta" or k.split(".", 1)[1] in SYNC_TABLES for _, k in tables):
            continue   # 没有 table_meta 和同步表的迷你 0001（样例）不查先后
        want = [("private.table_meta", CREATE_TABLE), ("private.table_meta_of", CREATE_FN), ("private.touch", CREATE_FN)]
        pos = []
        for k, rx in want:
            hit = [i for i, (_, _, t) in enumerate(stmts) if (m := rx.match(t)) and fn_key(m.group(1)) == k]
            pos.append(hit[0] if hit else None)
        if None in pos:
            missing = "、".join(k for (k, _), p in zip(want, pos) if p is None)
            errors.append(("M5", rel, 1, f"0001 里没有 {missing}（先后：全局默认权限 → table_meta、table_meta_of()、touch() → 各表）"))
            continue
        if pos != sorted(pos):
            errors.append(("M5", rel, line_of(raw, stmts[max(pos)][0]), "0001 里 table_meta、table_meta_of()、touch() 要按这个先后写"))
        for i, k in tables:
            if k != "private.table_meta" and i < pos[2]:
                errors.append(("M5", rel, line_of(raw, stmts[i][0]), f"{k} 建在 touch() 之前：0001 的先后是全局默认权限 → table_meta、table_meta_of()、touch() → 各表"))

    for short in SYNC_TABLES:
        tbl = f"public.{short}"
        if tbl not in table_file:
            continue
        rel, line = table_file[tbl]
        if not any(f == rel for f, _ in index_files.get(tbl, [])):
            where = "、".join(f"{f}:{ln}" for f, ln in index_files.get(tbl, [])) or "没有"
            errors.append(("M6", rel, line, f"{tbl} 的 (user_id, synced_at) 索引要写在建表的文件里（现在：{where}）"))


# ---------------- M4：授权汇总和架构 3.3 C 逐行比对（TC-B0-73 ①；0.29 续第 32 条，0.33 的 3.3 C 写法） ----------------
ARCH_DOC = "docs/10-架构/架构设计-v4.md"
C_HEAD = "**C. private schema 的授权白名单**"
A_HEAD = "-- private 的授权白名单（和 3.3 C 一字不差"
A_END = "-- ===== 0.29（P-14）"
TAG_RE = re.compile(r"^\s*(000[1-7]|B\d+)")
CLIENT_ROLES = {"public", "anon", "authenticated", "service_role"}
PRIV_RE = re.compile(r"^(grant|revoke) (.*?) on (.*?) (to|from) (.*)$")


def norm_sql(s):
    s = re.sub(r"\s+", " ", s).strip().rstrip(";").strip().lower()
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    s = re.sub(r"\s*,\s*", ", ", s)
    return s


def in_summary(s):
    """这一句归不归 3.3 C 的汇总管（s 已 norm_sql）。3.3 C 管：函数的默认权限；整段收回 private；private 的 schema usage；
    private 函数的 grant / revoke execute（任何角色）；private 表、视图给 public、anon、authenticated、service_role 的 grant；
    public 表给 service_role 的 grant（storage-sweep 的列级授权）。给 fn_vault、fn_ai 的表授权由 D1 和 6.2 比对（附录 A 末尾），
    对具体 private 表的 revoke 只收不放，也不在汇总里"""
    if s.startswith("alter default privileges") and " on functions " in f" {s} ":
        return True
    m = PRIV_RE.match(s)
    if not m:
        return False
    verb, _, obj, _, who = m.groups()
    grantees = {g.strip() for g in re.sub(r"\bgranted by .*$", "", who).split(",")}
    if re.match(r"all (tables|functions|sequences) in schema private\b", obj):
        return True
    if obj.startswith("schema "):
        return "private" in [x.strip() for x in obj[len("schema "):].split(",")] and bool(grantees & CLIENT_ROLES)
    if re.match(r"functions? private\.", obj):
        return True
    if verb != "grant":
        return False
    obj = re.sub(r"^table ", "", obj)
    if obj.startswith("private."):
        return bool(grantees & CLIENT_ROLES)
    if obj.startswith("public."):
        return "service_role" in grantees
    return False


def doc_lines(root):
    p = root / ARCH_DOC
    return p.read_text(encoding="utf-8").split("\n") if p.exists() else None


def summary_block(lines):
    """3.3 C 的 ```sql 段：[(文档行号, 原行, 语句, 标的文件或 None)]"""
    try:
        h = next(i for i, ln in enumerate(lines) if ln.startswith(C_HEAD))
        s = next(i for i in range(h, len(lines)) if lines[i].strip().startswith("```sql"))
        e = next(i for i in range(s + 1, len(lines)) if lines[i].strip().startswith("```"))
    except StopIteration:
        return None
    return parse_stmt_lines(lines, s + 1, e)


def appendix_block(lines):
    try:
        s = next(i for i, ln in enumerate(lines) if ln.startswith(A_HEAD))
        e = next(i for i in range(s, len(lines)) if lines[i].startswith(A_END))
    except StopIteration:
        return None
    return parse_stmt_lines(lines, s, e)


def parse_stmt_lines(lines, s, e):
    out = []
    for i in range(s, e):
        ln = lines[i].strip()
        if not ln or ln.startswith("--"):
            continue
        stmt, _, comment = ln.partition("--")
        tag = TAG_RE.match(comment)
        out.append((i + 1, ln, norm_sql(stmt), tag.group(1) if tag else None))
    return out


def check_grant_summary(root, parsed, errors):
    lines = doc_lines(root)
    if lines is None:
        return   # 样例目录里没有架构文档就不比（tests/arch-fixtures/check_backend/m4-grant-summary 带一份迷你的）
    summary = summary_block(lines)
    if summary is None:
        errors.append(("M4", ARCH_DOC, 1, "找不到 3.3 C 的授权白名单（“**C. private schema 的授权白名单**”后面的 ```sql 段）"))
        return
    for dl, _, stmt, tag in summary:
        if tag is None:
            errors.append(("M4", ARCH_DOC, dl, "3.3 C 这一行没在行尾标文件（-- 0001～0007，或 -- B1 新迁移 这类）"))
        elif not in_summary(stmt):
            errors.append(("M4", ARCH_DOC, dl, "3.3 C 这一行检查认不出归属（不是汇总管的授权语句），请核对写法"))

    # 附录 A 末尾照抄 3.3 C（复审 N2）：语句行逐行一字不差
    appendix = appendix_block(lines)
    if appendix is None:
        errors.append(("M4", ARCH_DOC, 1, f"找不到附录 A 末尾的授权白名单（“{A_HEAD}”到“{A_END}”）"))
    else:
        for k in range(max(len(summary), len(appendix))):
            a = appendix[k] if k < len(appendix) else None
            c = summary[k] if k < len(summary) else None
            if not a or not c or a[1] != c[1]:
                dl = a[0] if a else appendix[-1][0] if appendix else 1
                errors.append(("M4", ARCH_DOC, dl, f"附录 A 末尾和 3.3 C 第 {k + 1} 句不一样（要一字不差）：3.3 C 是“{c[1] if c else '（没有）'}”"))
                break

    by_stmt = {}
    for dl, _, stmt, tag in summary:
        by_stmt.setdefault(stmt, []).append((dl, tag))
    seen = {}   # (语句, 文件前缀) → 次数
    for name, rel, raw, stmts in parsed:
        prefix = name[:4] if re.match(r"^000[1-7]_", name) else None
        for off, _, t in stmts:
            s = norm_sql(t)
            if not in_summary(s):
                continue
            line = line_of(raw, off)
            hits = by_stmt.get(s)
            if not hits:
                errors.append(("M4", rel, line, "这一句授权不在架构 3.3 C 的汇总里（先改 3.3 C 和附录 A，再写迁移）"))
                continue
            tags = {tg for _, tg in hits}
            if prefix and prefix not in tags:
                errors.append(("M4", rel, line, f"3.3 C 里这一行标的是 {'、'.join(sorted(t for t in tags if t))}，实际写在 {prefix}"))
            if not prefix and not any(tg and tg.startswith("B") for tg in tags):
                errors.append(("M4", rel, line, f"3.3 C 里这一行标在 {'、'.join(sorted(t for t in tags if t))}，不该写进新迁移"))
            seen[(s, prefix)] = seen.get((s, prefix), 0) + 1
    present = {n[:4] for n, *_ in parsed if re.match(r"^000[1-7]_", n)}
    for dl, _, stmt, tag in summary:
        if tag and tag in present and seen.get((stmt, tag), 0) == 0:
            errors.append(("M4", ARCH_DOC, dl, f"3.3 C 这一行标在 {tag}，{tag} 里没有这一句"))
        if tag and tag in present and seen.get((stmt, tag), 0) > 1:
            errors.append(("M4", ARCH_DOC, dl, f"3.3 C 这一行在 {tag} 里写了 {seen[(stmt, tag)]} 次"))


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent.parent))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    root = pathlib.Path(args.root).resolve()

    errors = []
    check_functions(root, errors)
    check_pages(root, errors)
    check_migrations(root, errors)
    errors = sorted(set(errors), key=lambda e: (e[1], e[2], e[0], e[3]))
    # 同一处同一条规则只报一次
    seen, uniq = set(), []
    for e in errors:
        if (e[0], e[1], e[2]) not in seen:
            seen.add((e[0], e[1], e[2]))
            uniq.append(e)

    if args.json:
        print(json.dumps({"errors": [{"rule": r, "file": f, "line": ln, "message": m} for r, f, ln, m in uniq]}, ensure_ascii=False))
    else:
        for r, f, ln, m in uniq:
            print(f"错误 {r} {f}:{ln} {m}")
        print(f"check_backend：{len(uniq)} 个错误")
    return 1 if uniq else 0


if __name__ == "__main__":
    sys.exit(main())
