"""正式发布（R-499）：核对下载下来的发布包，release-publish.yml 的 verify 任务在“不带任何密钥”时运行。

由 tools/release/publish.ps1 第 3 步（Assert-PubManifest、Assert-PubContent、Assert-PubSourceMatchesRepo、Assert-SharedRewritten、
Assert-NoPreviewFunctions、“要部署的函数在发布包里都有”）搬到 CI。原来最后一步“负责人在 iPhone 上核对总指纹”不再需要：
发布包是按运行号从 GitHub 直接取的（verify 任务先核对那次运行是本仓库、对应工作流、这个 tag 的提交），这里按包里的 SHA256SUMS
逐个核对、再和这个 tag 的源码逐个比。

用法（仓库根目录，检出的就是这个 tag 的提交）：
  python3 -I build/ci/release_bundle_check.py <发布包目录> <SHA256SUMS 文件> --env production|preview --expect <版本>
      --functions a,b,c --preview-funcs x,y
  SHA256SUMS 要先从发布包目录里挪出来（不算进包里的文件）。
输出（stdout 最后两行，和 build/ci/dist_hash.py 一样）：文件数、总指纹。出错打印 ::error:: 并退出 1。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path.cwd()
GEN_HEAD = "// 生成文件：由 build/copy_shared.mjs"
IMPORT_RE = r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]"""


class Stop(Exception):
    pass


def fail(msg: str) -> None:
    raise Stop(msg)


def sha_file(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def manifest(root: pathlib.Path) -> str:
    """算法和 build/ci/dist_hash.py、build/ci/sha256sums.sh 一样：按路径 UTF-8 字节排序，每行“哈希␠␠路径\\n”。"""
    rows = []
    for p in root.rglob("*"):
        if p.is_symlink():
            fail(f"发布包里不应有符号链接：{p.relative_to(root).as_posix()}")
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            rows.append((rel.encode("utf-8"), rel, sha_file(p)))
    if not rows:
        fail("发布包是空的")
    rows.sort()
    return "".join(f"{d}  {rel}\n" for _, rel, d in rows)


def check_manifest(pub: pathlib.Path, sums: pathlib.Path) -> str:
    want = sums.read_bytes().decode("utf-8")
    if "\r" in want or not want.endswith("\n"):
        fail("SHA256SUMS 的格式不对（要 LF 换行、最后一行也换行）")
    seen = set()
    for line in want[:-1].split("\n"):
        m = re.fullmatch(r"[0-9a-f]{64}  (\S(?:.*\S)?)", line)
        if not m:
            fail(f"SHA256SUMS 里有一行格式不对：{line[:120]}")
        rel = m.group(1)
        segs = rel.split("/")
        if not rel.startswith(("dist/web/", "supabase/")) or "\\" in rel or any(s in ("", "..") or s.startswith(".") for s in segs):
            fail(f"SHA256SUMS 里有不允许的路径：{rel}")
        if rel in seen:
            fail(f"SHA256SUMS 里同一个文件写了两次：{rel}")
        seen.add(rel)
    got = manifest(pub)
    if got != want:
        w = {ln[66:]: ln[:64] for ln in want[:-1].split("\n")}
        g = {ln[66:]: ln[:64] for ln in got[:-1].split("\n")}
        diff = sorted([f"少了 {k}" for k in w if k not in g] + [f"内容不同 {k}" for k in w if k in g and g[k] != w[k]]
                      + [f"多了 {k}" for k in g if k not in w])
        fail(f"发布包里的文件和 SHA256SUMS 对不上：{'、'.join(diff[:10])}{f' 等 {len(diff)} 处' if len(diff) > 10 else ''}")
    return got


def check_web(pub: pathlib.Path, expect: str) -> None:
    web = pub / "dist" / "web"
    vj = web / "app" / "version.json"
    try:
        v = json.loads(vj.read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError):
        v = None
    if v != expect:
        fail(f"发布包里 version.json 的版本是「{v}」，不是 {expect}")
    if not (web / "_worker.js" / "index.js").is_file():
        fail("发布包里没有打包好的 Pages Functions（dist/web/_worker.js/index.js）")
    for p in web.rglob("*"):
        if p.is_file() and (p.suffix == ".map" or (p.suffix == ".js" and b"sourceMappingURL" in p.read_bytes())):
            fail(f"发布包的 dist/web 里有 source map：{p.relative_to(web).as_posix()}")


def tracked(*paths: str) -> list[str]:
    r = subprocess.run(["git", "-c", "core.quotepath=false", "ls-files", "--", *paths], cwd=ROOT, capture_output=True, check=True)
    return [x for x in r.stdout.decode("utf-8").splitlines() if x.strip()]


def check_source(pub: pathlib.Path, text: str, env: str, preview_funcs: list[str]) -> None:
    """服务器函数、迁移、配置和这个 tag 的源码逐个一致（_shared/gen 另按 copy_shared 的规则核，见 check_shared）。"""
    rows = {ln[66:]: ln[:64] for ln in text[:-1].split("\n")}
    bad = []
    for rel in sorted(r for r in rows if r.startswith("supabase/")):
        if rel.startswith("supabase/functions/_shared/gen/"):
            continue
        if env == "preview":
            m = re.fullmatch(r"supabase/functions/([a-z][a-z0-9-]{0,62})/index\.ts", rel)
            if m and m.group(1) in preview_funcs:
                n = m.group(1)
                stub = f"// 由 deploy-preview.yml 在预览产物里生成，不进仓库。源码在 ../_preview/{n}/\nimport '../_preview/{n}/index.ts';\n"
                if (pub / rel).read_bytes() != stub.encode("utf-8"):
                    bad.append(f"{rel}（不是 deploy-preview 生成的那两行入口）")
                continue
            if rel == "supabase/config.toml":
                mine = (ROOT / rel).read_bytes().decode("utf-8")
                theirs = (pub / rel).read_bytes().decode("utf-8")
                names = "|".join([re.escape(n) for n in preview_funcs] + ["(?!)"])
                if not theirs.startswith(mine) or not re.fullmatch(rf"(\n\[functions\.({names})\]\nverify_jwt = false\n)*", theirs[len(mine):]):
                    bad.append(f"{rel}（除了末尾追加的预览专用函数配置，还有别的不同）")
                continue
        src = ROOT / rel
        if not src.is_file():
            bad.append(f"{rel}（这个 tag 的源码里没有）")
        elif sha_file(src) != rows[rel]:
            bad.append(f"{rel}（和源码不一样）")
    scope = ["supabase"] if env == "preview" else ["supabase/config.toml", "supabase/migrations", "supabase/functions", "supabase/templates"]
    for t in tracked(*scope):
        if t != "supabase/functions/.env.example" and t not in rows:
            bad.append(f"{t}（发布包里缺）")
    if bad:
        fail(f"发布包里的服务器函数、迁移、配置和这个 tag 的源码对不上：{'、'.join(bad[:10])}{f' 等 {len(bad)} 处' if len(bad) > 10 else ''}")


def check_shared(pub: pathlib.Path) -> int:
    fn = pub / "supabase" / "functions"
    gen = fn / "_shared" / "gen"
    files = sorted(gen.rglob("*.ts")) if gen.is_dir() else []
    other = sorted(p.relative_to(gen).as_posix() for p in gen.rglob("*") if p.is_file() and p.suffix != ".ts") if gen.is_dir() else []
    if other:
        # copy_shared 只生成 .ts；别的文件（.js、.mjs、.json）没人核对过内容，函数却能引到它
        fail(f"发布包的 supabase/functions/_shared/gen 里有不是 .ts 的文件：{'、'.join(other[:10])}")
    if not files:
        fail("发布包的 supabase/functions/_shared/gen 里没有生成的文件（CI 的 copy:shared 没跑成）")
    imports = json.loads((fn / "deno.json").read_text(encoding="utf-8")).get("imports") or {}
    allowed = {v for v in imports.values() if isinstance(v, str) and v.startswith("npm:")}
    if not allowed:
        fail("supabase/functions/deno.json 的 imports 里没有一项 npm:包@版本，核对不了 _shared/gen 引的版本")
    bad = []
    for f in files:
        rel = f.relative_to(gen).as_posix()
        t = f.read_bytes().decode("utf-8")
        if not t.startswith(GEN_HEAD):
            bad.append(f"{rel}（不是 copy_shared 生成的）")
            continue
        m = re.search(IMPORT_RE + r"(zod|aws4fetch)['\"]", t)
        if m:
            bad.append(f"{rel}（裸引 {m.group(2)}）")
            continue
        for m in re.finditer(IMPORT_RE + r"(npm:[^'\"]+)['\"]", t):
            if m.group(2) not in allowed:
                bad.append(f"{rel}（引的 {m.group(2)} 不是 deno.json 锁的版本）")
    if bad:
        fail(f"发布包的 _shared/gen 不是 build/copy_shared.mjs 按锁定版本改写过的：{'、'.join(bad[:10])}")
    return len(files)


def check_preview_free(pub: pathlib.Path, preview_funcs: list[str]) -> None:
    for n in preview_funcs:
        if (pub / "supabase" / "functions" / n).exists():
            fail(f"发布包里有 supabase/functions/{n}：{n} 是预览专用函数，正式环境不能部署它")
    cfg = pub / "supabase" / "config.toml"
    text = cfg.read_text(encoding="utf-8") if cfg.exists() else ""
    if re.search(r"(?<![A-Za-z0-9_])_preview(?![A-Za-z0-9_])", text):
        fail("发布包的 supabase/config.toml 里出现了 _preview")
    for n in preview_funcs:
        if re.search(r"(?m)^\s*\[\s*functions\s*\.\s*[\"']?" + re.escape(n) + r"[\"']?\s*[\].]", text):
            fail(f"发布包的 supabase/config.toml 里声明了预览专用函数 [functions.{n}]")


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("pub")
    ap.add_argument("sums")
    ap.add_argument("--env", choices=("production", "preview"), required=True)
    ap.add_argument("--expect", required=True)
    ap.add_argument("--functions", required=True)
    ap.add_argument("--preview-funcs", default="")
    a = ap.parse_args(argv)
    pub, sums = pathlib.Path(a.pub), pathlib.Path(a.sums)
    fns = [x for x in a.functions.split(",") if x]
    pfs = [x for x in a.preview_funcs.split(",") if x]
    try:
        if not pub.is_dir() or not sums.is_file():
            fail("发布包目录或 SHA256SUMS 不存在")
        if not fns:
            fail("没有要部署的服务器函数名单")
        text = check_manifest(pub, sums)
        check_web(pub, a.expect)
        check_source(pub, text, a.env, pfs)
        ngen = check_shared(pub)
        if a.env == "production":
            check_preview_free(pub, pfs)
        missing = [n for n in fns if not (pub / "supabase" / "functions" / n / "index.ts").is_file()]
        if missing:
            fail(f"发布包里没有要部署的服务器函数：{'、'.join(missing)}")
    except Stop as e:
        print(f"::error::发布包核对没通过（还没部署任何东西）：{e}")
        return 1
    print(f"发布包核对通过：SHA256SUMS 逐个对上，version.json 是 {a.expect}，有 _worker.js、没有 source map，"
          f"服务器函数、迁移、配置和源码逐个一致，_shared/gen {ngen} 个文件按锁定版本改写，{len(fns)} 个函数都在")
    print(f"文件数：{text.count(chr(10))}")
    print(f"总指纹：{hashlib.sha256(text.encode('utf-8')).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
