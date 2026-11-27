"""迁移里整段 create or replace 的函数，最新一版不能悄悄丢掉上一版的 delete 语句和表名（后端安全审查第 9 条）。

用法：python -I build/check_fn_redefs.py [--root 目录]
      有错误时退出码 1。check_backend.py 把它当 M7 一起跑（unit.yml 第一项、本地全套、publish.ps1 都经 check_backend，入口只有一个）。

为什么要有：cleanup_batch、files_authorize_impl 这类函数每改一处就整段复制一遍（create or replace 只能整段替换），
  靠人“逐字照上一版”。漏抄一句 delete（例如 todo_items 那句），清理就悄悄停了，任何测试都不一定看得出来。
核对的函数（FUNCS）：按文件名顺序取每个函数的各版函数体（不管参数签名变没变，drop 后重建的也算下一版），
  拿最新一版和前一版比：
  R1  前一版每个 delete from <表> 的表，最新一版也要有 delete from 这张表；
  R2  前一版出现过的每个带 schema 的表名（public.x、private.x、auth.x、storage.x），最新一版也要出现。
  确实是有意删掉的，写进 ALLOW（函数、表、哪份迁移删的、为什么），不要改规则。
只读迁移文件（UTF-8），不连数据库。
"""
import argparse
import pathlib
import re
import sys

FUNCS = ("private.cleanup_batch", "private.files_authorize_impl", "private.remind_queue_pop", "public.apply_patch", "private.record_consent_impl")

# (函数, 表) → 理由：有意从最新一版去掉的表（以后真要删一张表，先在这里写明哪份迁移、为什么）
ALLOW = {}

SCHEMAS = ("public", "private", "auth", "storage")
CREATE_RE = re.compile(r"\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(", re.IGNORECASE)
DOLLAR_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
DELETE_RE = re.compile(r"\bdelete\s+from\s+((?:public|private|auth|storage)\.[a-z_][a-z0-9_]*)", re.IGNORECASE)
TABLE_RE = re.compile(r"\b((?:public|private|auth|storage)\.[a-z_][a-z0-9_]*)\b(?!\s*\()", re.IGNORECASE)


def strip_line_comments(body):
    """去掉 -- 注释（函数体里的字符串不含 --，迁移惯例如此）"""
    return "\n".join(re.sub(r"--.*$", "", ln) for ln in body.split("\n"))


def versions(mig_dir):
    """{函数: [(文件名, 行号, 函数体)]}，按文件名顺序"""
    out = {f: [] for f in FUNCS}
    for p in sorted(mig_dir.glob("*.sql")):
        text = p.read_text(encoding="utf-8")
        for m in CREATE_RE.finditer(text):
            name = f"{m.group(1).lower()}.{m.group(2).lower()}"
            if name not in out:
                continue
            d = DOLLAR_RE.search(text, m.end())
            if not d:
                continue
            tag = d.group(0)
            end = text.find(tag, d.end())
            if end < 0:
                continue
            out[name].append((p.name, text.count("\n", 0, m.start()) + 1, strip_line_comments(text[d.end():end])))
    return out


def tables(body):
    """函数体里带 schema 的表名（去掉函数调用：后面紧跟左括号的不算）"""
    return {t.lower() for t in TABLE_RE.findall(body)}


def deletes(body):
    return {t.lower() for t in DELETE_RE.findall(body)}


def check(root, errors):
    mig = root / "supabase" / "migrations"
    if not mig.exists():
        return
    for fn, vs in versions(mig).items():
        if len(vs) < 2:
            continue
        (prev_file, _, prev), (last_file, line, last) = vs[-2], vs[-1]
        rel = f"supabase/migrations/{last_file}"
        for t in sorted(deletes(prev) - deletes(last)):
            if (fn, t) not in ALLOW:
                errors.append(("M7", rel, line, f"{fn} 最新一版没有 delete from {t}（上一版 {prev_file} 有）：整段照抄时漏了？有意删的写进 build/check_fn_redefs.py 的 ALLOW"))
        for t in sorted(tables(prev) - tables(last)):
            if (fn, t) not in ALLOW:
                errors.append(("M7", rel, line, f"{fn} 最新一版不再出现 {t}（上一版 {prev_file} 有）：整段照抄时漏了？有意删的写进 build/check_fn_redefs.py 的 ALLOW"))


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent.parent))
    args = ap.parse_args(argv)
    errors = []
    check(pathlib.Path(args.root).resolve(), errors)
    for r, f, ln, m in errors:
        print(f"错误 {r} {f}:{ln} {m}")
    print(f"check_fn_redefs：{len(errors)} 个错误")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
