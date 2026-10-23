# 职责：架构检查。按 docs/10-架构/架构约定.md 检查 src/ 有没有走样：分层越界、文件头缺失、依赖顺序与 manifest 矛盾、
#       用了别的模块却没在文件头声明、src/ 下有文件没写进 manifest、单文件过长。不通过时给出中文原因和“文件:行号”。
#   用法：python build/check_arch.py              检查当前源码（build.py 默认先跑它）
#         python build/check_arch.py --self-test  用 tests/arch-fixtures/ 里故意违规的示例证明每条规则真能拦住
# 依赖：Python 3.8+ 标准库
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = "src/scripts/"
MAX_LINES = 250
LAYERS = ["core", "logic", "platform", "data", "ui", "app"]
# 每层允许依赖的层（含本层）。app.js 是入口，可以依赖任何层。
ALLOWED = {
    "core": {"core"},
    "logic": {"core", "logic"},
    "platform": {"core", "platform"},
    "data": {"core", "logic", "platform", "data"},
    "ui": {"core", "logic", "platform", "data", "ui"},
    "app": set(LAYERS),
}
RULES = {
    "A1": "logic/ 和 core/ 必须是纯的，不能碰页面、浏览器、系统时间或别的层",
    "A2": "data/ 不能碰界面（DOM、App.ui、classList、matchMedia、innerHTML）",
    "A3": "只有 platform/ 能使用 window.claude 和 localStorage",
    "A4": "ui/ 不能直接调用存储（store.），写入要走 data/write.js",
    "A5": "platform/ 不能反过来依赖 data/ 或 ui/",
    "A6": "文件头缺少“职责：”或“依赖：”注释",
    "A7": "文件头“依赖：”里的文件在 manifest 中排在本文件后面（或不在 manifest 里）",
    "A8": "依赖方向错误：文件头声明了不允许依赖的层",
    "A9": "用到了别的模块，但文件头的“依赖：”或“运行时调用：”里没写",
    "A10": "src/ 下的文件没写进 build/manifest.json，或 manifest 里的文件不存在",
    "W1": "单个 JS 文件超过 %d 行，应该拆分（警告）" % MAX_LINES,
}
# (规则, 适用层, 正则, 说明)
PATTERNS = [
    ("A1", {"core", "logic"}, r"\bdocument\b", "document"),
    ("A1", {"core", "logic"}, r"\bwindow\b", "window"),
    ("A1", {"core", "logic"}, r"\blocalStorage\b", "localStorage"),
    ("A1", {"core", "logic"}, r"\bDate\.now\s*\(", "Date.now()"),
    ("A1", {"core", "logic"}, r"\bnew\s+Date\s*\(\s*\)", "不带参数的 new Date()"),
    ("A1", {"core", "logic"}, r"\bApp\.ui\b", "App.ui"),
    ("A1", {"core", "logic"}, r"\bApp\.data\b", "App.data"),
    ("A1", {"core", "logic"}, r"\bApp\.platform\b", "App.platform"),
    ("A1", {"core", "logic"}, r"\bApp\.clock\b", "App.clock（时间请由参数传入）"),
    ("A2", {"data"}, r"\bdocument\b", "document"),
    ("A2", {"data"}, r"\bApp\.ui\b", "App.ui"),
    ("A2", {"data"}, r"\bclassList\b", "classList"),
    ("A2", {"data"}, r"\bmatchMedia\b", "matchMedia"),
    ("A2", {"data"}, r"\binnerHTML\b", "innerHTML"),
    ("A3", {"core", "logic", "data", "ui", "app"}, r"\bwindow\.claude\b", "window.claude"),
    ("A3", {"core", "logic", "data", "ui", "app"}, r"\blocalStorage\b", "localStorage"),
    ("A4", {"ui"}, r"(?<![\w$])store\s*\.", "store."),
    ("A4", {"ui"}, r"\bApp\.data\.store\b", "App.data.store"),
    ("A5", {"platform"}, r"\bApp\.(?:data|ui)\b", "App.data / App.ui"),
]
SPECIAL_PROVIDERS = {"App.clock": "src/scripts/app.js", "App.BUILD": "build/build.py"}


def layer_of(path):
    rel = path[len(SCRIPTS):] if path.startswith(SCRIPTS) else path
    first = rel.split("/")[0]
    if first in LAYERS:
        return first
    return "app" if rel == "app.js" else None


def strip_comments(src):
    """去掉 JS 注释（换成空格、保留换行，行号不变）；字符串、模板字符串、正则字面量原样保留。"""
    out, i, n = [], 0, len(src)
    prev = ""   # 上一个非空白的有效字符，用来判断 / 是除号还是正则开头
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i)); i = j; continue
        if c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", src[i:j])); i = j; continue
        if c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1; prev = c; continue
        if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^"):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            out.append(src[i:j + 1]); i = j + 1; prev = "/"; continue
        out.append(c)
        if not c.isspace():
            prev = c
        i += 1
    return "".join(out)


def header(src):
    """读文件头注释：返回 (有职责, 依赖列表, 运行时调用列表, 依赖所在行号)。"""
    lines = src.splitlines()
    head = []
    for ln in lines[:12]:
        if not ln.startswith("//") and not ln.startswith("#"):
            break
        head.append(ln)
    text = "\n".join(head)
    has_duty = "职责：" in text
    blocks, cur, dep_line = {"依赖": "", "运行时调用": ""}, None, 0
    for k, ln in enumerate(head, 1):
        body = ln.lstrip("/# ").strip()
        m = re.match(r"(职责|依赖|运行时调用)：(.*)", body)
        if m:
            cur = m.group(1)
            if cur == "依赖":
                dep_line = k
            if cur in blocks:
                blocks[cur] += " " + m.group(2)
        elif cur in blocks:
            blocks[cur] += " " + body
    parse = lambda s: re.findall(r"(?:core|logic|platform|data|ui)/[\w-]+\.js|App\.clock", s)
    return has_duty, ("依赖：" in text), parse(blocks["依赖"]), parse(blocks["运行时调用"]), dep_line


def providers(files):
    """谁提供了哪个命名空间：行首的 App.x.y = ... 赋值。"""
    prov = dict(SPECIAL_PROVIDERS)
    for path, src in files.items():
        for m in re.finditer(r"^App\.(\w+)\.(\w+)(?:\[[^\]]+\])?\s*=", strip_comments(src), re.M):
            prov.setdefault("App.%s.%s" % (m.group(1), m.group(2)), path)
    return prov


def check(manifest, files, all_src_files):
    """manifest：dict；files：{路径: 源码}（manifest 里的 JS）；all_src_files：src/ 下全部 .js/.css 路径。返回 (错误, 警告)。"""
    errors, warns = [], []
    err = lambda rule, path, line, msg: errors.append((rule, path, line, msg))
    order = list(manifest["scripts"]) + [manifest["entry"]]
    listed = set(order) | set(manifest["styles"]) | {manifest["template"]}
    for p in sorted(all_src_files):
        if p.endswith((".js", ".css")) and p not in listed:
            err("A10", p, 0, "这个文件没写进 build/manifest.json，构建时会被漏掉")
    for p in sorted(listed):
        if p not in all_src_files and p not in files:
            err("A10", "build/manifest.json", 0, "manifest 里的 %s 不存在" % p)
    prov = providers(files)
    short = lambda p: p[len(SCRIPTS):] if p.startswith(SCRIPTS) else p
    pos = {short(p): i for i, p in enumerate(order)}
    for path in order:
        if path not in files:
            continue
        src, lay = files[path], layer_of(path)
        code = strip_comments(src)
        lines = code.splitlines()
        if len(src.splitlines()) > MAX_LINES:
            warns.append(("W1", path, 0, "共 %d 行，超过 %d 行，建议拆分" % (len(src.splitlines()), MAX_LINES)))
        has_duty, has_dep, deps, runtime, dep_line = header(src)
        if not (has_duty and has_dep):
            err("A6", path, 1, "文件开头要有“// 职责：……”和“// 依赖：……”两行注释（没有依赖写“依赖：无”）")
        for rule, layers, pat, what in PATTERNS:
            if lay not in layers:
                continue
            for no, ln in enumerate(lines, 1):
                if re.search(pat, ln):
                    err(rule, path, no, "%s 里不能出现 %s：%s" % (lay + "/" if lay != "app" else "app.js", what, ln.strip()[:80]))
        me = short(path)
        for d in deps + runtime:
            if d == "App.clock":
                continue
            dl = d.split("/")[0]
            if dl not in ALLOWED.get(lay, set()):
                err("A8", path, dep_line, "%s 层不能依赖 %s（%s）；允许的方向见架构约定" % (lay, dl, d))
        for d in deps:
            if d == "App.clock":
                continue
            if d not in pos:
                err("A7", path, dep_line, "依赖的 %s 不在 manifest 的 scripts 里" % d)
            elif pos[d] >= pos[me]:
                err("A7", path, dep_line, "依赖的 %s 排在本文件后面，加载时会拿不到；请调整 manifest 顺序" % d)
        declared = set(deps) | set(runtime)
        for no, ln in enumerate(lines, 1):
            for m in re.finditer(r"\bApp\.(\w+)(?:\.(\w+))?", ln):
                name = "App.%s.%s" % (m.group(1), m.group(2)) if m.group(2) else "App." + m.group(1)
                src_file = prov.get(name)
                if not src_file or src_file == path or src_file.startswith("build/"):
                    continue
                want = "App.clock" if name == "App.clock" else short(src_file)
                if want not in declared and not src_file.startswith("tests/"):
                    err("A9", path, no, "用到了 %s（在 %s），文件头没声明" % (name, want))
                    declared.add(want)   # 每个文件每个模块只报一次
    return errors, warns


def load_real():
    m = json.loads((ROOT / "build/manifest.json").read_text(encoding="utf-8-sig"))
    all_src = {p.relative_to(ROOT).as_posix() for p in (ROOT / "src").rglob("*") if p.is_file()}
    files = {}
    for p in list(m["scripts"]) + [m["entry"]]:
        f = ROOT / p
        if f.exists():
            files[p] = f.read_text(encoding="utf-8-sig")
    return m, files, all_src


def report(errors, warns):
    for rule, path, line, msg in errors:
        print("  错误 [%s] %s%s  %s" % (rule, path, ":%d" % line if line else "", msg))
    for rule, path, line, msg in warns:
        print("  警告 [%s] %s  %s" % (rule, path, msg))


def run():
    m, files, all_src = load_real()
    errors, warns = check(m, files, all_src)
    report(errors, warns)
    if errors:
        rules = sorted({e[0] for e in errors}, key=lambda r: int(r[1:]))
        print("架构检查未通过：%d 处错误（%s）。规则说明：" % (len(errors), "、".join(rules)))
        for r in rules:
            print("  %s  %s" % (r, RULES[r]))
        return 1
    print("架构检查通过（%d 个脚本，%d 条警告）" % (len(files), len(warns)))
    return 0


def self_test():
    """每个示例文件头写着 @fixture 路径=… 期望=…；把它当作那个路径的源码加入检查，期望的规则必须报出来。"""
    m, files, all_src = load_real()
    base_err, _ = check(m, files, all_src)
    ok = not base_err
    print("当前源码：%s" % ("无错误" if ok else "有 %d 处错误（自检要求当前源码先通过）" % len(base_err)))
    fixtures = sorted((ROOT / "tests/arch-fixtures").glob("*.js"))
    for fx in fixtures:
        src = fx.read_text(encoding="utf-8-sig")
        meta = dict(re.findall(r"(\S+?)=(\S+)", re.search(r"@fixture(.*)", src).group(1)))
        path, expect = meta["路径"], meta["期望"]
        mm = json.loads(json.dumps(m))
        fs, srcs = dict(files), set(all_src) | {path}
        fs[path] = src
        if meta.get("登记") != "否":
            if meta.get("位置") == "开头":
                mm["scripts"].insert(0, path)
            else:
                mm["scripts"].append(path)
        errors, warns = check(mm, fs, srcs)
        got = {e[0] for e in errors + warns if e[1] in (path, "build/manifest.json")}
        hit = expect in got
        ok &= hit
        print("  %s  %-34s 期望 %-4s 实际 %s" % ("拦住" if hit else "漏掉", fx.name, expect, "、".join(sorted(got)) or "无"))
    # W1：临时生成一个超长文件
    path = SCRIPTS + "logic/too-long.js"
    long_src = "// 职责：自检用的超长文件\n// 依赖：无\n" + "const x = 1;\n" * (MAX_LINES + 5)
    mm = json.loads(json.dumps(m)); mm["scripts"].append(path)
    fs = dict(files); fs[path] = long_src
    _, warns = check(mm, fs, set(all_src) | {path})
    hit = any(w[0] == "W1" and w[1] == path for w in warns)
    ok &= hit
    print("  %s  %-34s 期望 %-4s" % ("拦住" if hit else "漏掉", "（生成的 %d 行文件）" % (MAX_LINES + 7), "W1"))
    print("自检%s：%d 个示例" % ("通过" if ok else "失败", len(fixtures) + 1))
    return 0 if ok else 1


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(self_test() if "--self-test" in sys.argv else run())


if __name__ == "__main__":
    main()
