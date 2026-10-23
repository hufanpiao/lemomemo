# 职责：JS 语法检查。对 manifest 里的每个源码文件、以及拼好的页面（dist/*.html）里的每段内联 <script>，
#       抽到临时 .js 文件后跑 `node --check`；任何一处不过就返回失败，给出中文原因和“文件:行号”（页面按 HTML 里的行号报）。
#   用法：python build/check_js.py              检查 manifest 里的全部源码
#         python build/check_js.py --self-test  用 tests/syntax-fixtures/ 里故意写错的示例证明能拦住
#   build.py 构建前先检查源码，每个页面写出前再检查一次，不过就构建失败。
# 依赖：Python 3.8+ 标准库、Node.js（命令名 node，可用环境变量 NODE 指定）
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = os.environ.get("NODE", "node")


def node_ok():
    return shutil.which(NODE) is not None


def check_code(code):
    """返回 None（通过）或 (行号, 说明)。行号从 1 开始，相对这段代码。"""
    fd, tmp = tempfile.mkstemp(suffix=".js", prefix="planner-check-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(code)
        r = subprocess.run([NODE, "--check", tmp], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0:
            return None
        err = r.stderr or r.stdout
        m = re.search(re.escape(os.path.basename(tmp)) + r":(\d+)", err)
        line = int(m.group(1)) if m else 0
        msg = next((ln.strip() for ln in err.splitlines() if re.match(r"\s*\w*Error\b", ln)), err.strip().splitlines()[-1] if err.strip() else "语法错误")
        return line, msg
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def scripts_in_html(html):
    """[(开始行号, 脚本内容)]：只取内联脚本（不带 src）。开始行号是 <script> 后第一行在 HTML 里的行号。"""
    out = []
    for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S | re.I):
        out.append((html.count("\n", 0, m.start(1)) + 1, m.group(1)))
    return out


def check_html(name, html):
    """返回错误列表 [(名称, 行号, 说明)]。"""
    errs = []
    for start, code in scripts_in_html(html):
        r = check_code(code)
        if r:
            errs.append((name, start + r[0] - 1 if r[0] else start, r[1]))
    return errs


def check_files(paths):
    errs = []
    for p in paths:
        r = check_code((ROOT / p).read_text(encoding="utf-8-sig"))
        if r:
            errs.append((p, r[0], r[1]))
    return errs


def report(errs):
    for name, line, msg in errs:
        print("  错误 [语法] %s%s  %s" % (name, ":%d" % line if line else "", msg))


def run_sources():
    """检查 manifest 里的全部脚本（含测试用的模拟器）。返回 0 / 1。"""
    if not node_ok():
        print("JS 语法检查失败：找不到 node（需要 Node.js 18+，或用环境变量 NODE 指定路径）")
        return 1
    m = json.loads((ROOT / "build/manifest.json").read_text(encoding="utf-8-sig"))
    t = m.get("tests", {})
    paths = list(m["scripts"]) + [m["entry"]] + [t[k] for k in ("sampleData", "mockAdapter", "mockDownload", "claudeStub") if k in t]
    errs = check_files(paths)
    report(errs)
    if errs:
        print("JS 语法检查未通过：%d 个文件有语法错误" % len(errs))
        return 1
    print("JS 语法检查通过（%d 个文件）" % len(paths))
    return 0


def self_test():
    """tests/syntax-fixtures/ 里每个文件头写着“期望行=N”：检查必须报错，并且报在第 N 行。"""
    if not node_ok():
        print("自检失败：找不到 node")
        return 1
    ok = True
    files = sorted((ROOT / "tests/syntax-fixtures").glob("*.*"))
    for f in files:
        text = f.read_text(encoding="utf-8-sig")
        want = int(re.search(r"期望行=(\d+)", text).group(1))
        errs = check_html(f.name, text) if f.suffix == ".html" else [(f.name,) + r for r in [check_code(text)] if r]
        got = errs[0][1] if errs else None
        hit = got == want
        ok &= hit
        print("  %s  %-28s 期望第 %d 行报错，实际%s" % ("拦住" if hit else "漏掉", f.name, want, "第 %d 行：%s" % (got, errs[0][2]) if errs else "通过（没拦住）"))
    good = check_code("const a = 1;\nfunction f(){ return a; }\n") is None
    ok &= good
    print("  %s  %-28s 合法代码不能误报" % ("通过" if good else "误报", "（内置的合法示例）"))
    print("自检%s：%d 个示例" % ("通过" if ok else "失败", len(files) + 1))
    return 0 if ok else 1


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(self_test() if "--self-test" in sys.argv else run_sources())


if __name__ == "__main__":
    main()
