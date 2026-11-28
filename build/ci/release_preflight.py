"""正式发布（R-499）第一个任务的发布前检查：release-publish.yml 的 verify 任务在“不带任何密钥”时运行。

由 tools/release/publish.ps1 第 1 步（Invoke-Checks、Assert-OpsPlan、Assert-NoDotEnv、Get-DeployFunctionNames、
Assert-NoHiddenGitState、Assert-NoRiskyGitConfig、Assert-ContentMatchesHead）搬到 CI。本机才有的检查（剪贴板、transcript、
窗口环境变量）在 CI 里没有对应的东西，不搬；git 的几条在 CI 的新机器上本来就该是干净的，照样查一遍，几乎不花时间。

用法（仓库根目录，actions/checkout 要 fetch-depth: 0，才有 origin/main 和带说明的 tag 对象）：
  python3 -I build/ci/release_preflight.py
读环境变量：GITHUB_REF、GITHUB_SHA、GITHUB_EVENT_NAME、ONLY（all / functions，手动触发时的输入，push 时为空）、
  GITHUB_OUTPUT（写结果）、GITHUB_STEP_SUMMARY（写摘要，可以没有）。
写出（GITHUB_OUTPUT）：env、tag、ver、expect、run_no、only、ops、functions、preview_funcs、pages_project、site_origin、
  build_workflow、artifact_name。出错打印 ::error:: 并退出 1。

两种 tag：
  vX.Y.Z             正式：部署到正式环境（GitHub Environment production，要负责人批准）；
  vX.Y.Z-preview.N   预览演练：N 是 deploy-preview 的运行号，部署那次运行的 preview-bundle 到预览环境（Environment preview）。
"""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path.cwd()
PROD_TAG = re.compile(r"v([0-9]+)\.([0-9]+)\.([0-9]+)")
PREVIEW_TAG = re.compile(r"v([0-9]+)\.([0-9]+)\.([0-9]+)-preview\.([1-9][0-9]{0,8})")
FN_NAME = re.compile(r"[a-z][a-z0-9-]{0,62}")
OPS_CONFIG = "workers/lemo-ops/wrangler.toml"
# Git for Windows / runner 自带的 git-lfs 设置，system、global 一级只放行这四项，值要一字不差（publish.ps1 的 AllowedSystemGitConfig）
LFS_OK = {
    "filter.lfs.clean": "git-lfs clean -- %f",
    "filter.lfs.smudge": "git-lfs smudge -- %f",
    "filter.lfs.process": "git-lfs filter-process",
    "filter.lfs.required": "true",
}
ENV_FILES = (".env", ".env.local", ".env.development", ".env.development.local", ".env.production")


class Stop(Exception):
    pass


def fail(msg: str) -> None:
    raise Stop(msg)


def git(*args: str, ok: tuple[int, ...] = (0,), env: dict | None = None) -> tuple[int, str]:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, env=env)
    if r.returncode not in ok:
        fail(f"git {' '.join(args)} 出错（退出码 {r.returncode}）")
    return r.returncode, r.stdout.decode("utf-8", "replace")


def parse_tag(ref: str) -> dict:
    if not ref.startswith("refs/tags/"):
        fail(f"只能在 tag 上发布（现在是 {ref}）：正式打 vX.Y.Z，预览演练打 vX.Y.Z-preview.N；手动触发时在“Use workflow from”里选 tag")
    tag = ref[len("refs/tags/"):]
    m = PROD_TAG.fullmatch(tag)
    if m:
        ver = ".".join(m.groups())
        return {"env": "production", "tag": tag, "ver": ver, "expect": ver, "run_no": ""}
    m = PREVIEW_TAG.fullmatch(tag)
    if m:
        ver = ".".join(m.groups()[:3])
        return {"env": "preview", "tag": tag, "ver": ver, "expect": f"{ver}-preview.{m.group(4)}", "run_no": m.group(4)}
    fail(f"tag 的格式不对：{tag}（正式 vX.Y.Z，预览演练 vX.Y.Z-preview.N，小写 v、半角数字）")
    raise AssertionError


def check_tag(info: dict, sha: str) -> None:
    tag = info["tag"]
    _, kind = git("cat-file", "-t", f"refs/tags/{tag}", ok=(0, 1, 128))
    if kind.strip() != "tag":
        fail(f"{tag} 不是带说明的 tag（要用 git tag -a）")
    _, commit = git("rev-parse", f"{tag}^{{commit}}")
    _, head = git("rev-parse", "HEAD")
    if not (commit.strip() == head.strip() == sha):
        fail(f"tag、检出的提交、触发的提交不是同一个（tag {commit.strip()[:12]}，HEAD {head.strip()[:12]}，触发 {sha[:12]}）")
    rc, _ = git("merge-base", "--is-ancestor", sha, "origin/main", ok=(0, 1))
    if rc != 0:
        fail(f"{tag} 不在 main 上：只许在 main 已有的提交上打 tag")
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if version != info["ver"]:
        fail(f"VERSION 是 {version}，tag 是 {tag}，对不上")


def newer_tags(ver: str) -> list[str]:
    _, out = git("tag", "-l", "v*")
    mine = tuple(int(x) for x in ver.split("."))
    return sorted(t for t in out.split() if (m := PROD_TAG.fullmatch(t)) and tuple(int(x) for x in m.groups()) > mine)


def check_git_state() -> None:
    """publish.ps1 的 Assert-NoHiddenGitState、Assert-NoRiskyGitConfig、Assert-ContentMatchesHead。"""
    _, dirty = git("status", "--porcelain", "--untracked-files=all")
    if dirty.strip():
        fail(f"检出的工作区不干净：{dirty.strip()[:400]}")
    _, lsv = git("-c", "core.quotepath=false", "ls-files", "-v")
    hidden = [ln[2:] for ln in lsv.splitlines() if re.match(r"^([a-z]|S) ", ln)]
    if hidden:
        fail(f"有文件被标成 assume-unchanged 或 skip-worktree：{'、'.join(hidden[:10])}")
    if (ROOT / ".git" / "info" / "sparse-checkout").exists():
        fail("开了稀疏检出（.git/info/sparse-checkout），发布前检查要完整检出")
    _, repl = git("for-each-ref", "--format=%(refname)", "refs/replace/")
    if repl.strip():
        fail(f"有替换对象（git replace）：{repl.strip()}")
    attr = ROOT / ".git" / "info" / "attributes"
    if attr.exists() and attr.stat().st_size > 0:
        fail(".git/info/attributes 不是空的")
    _, cfg = git("config", "--show-scope", "--list", "-z")
    bad = []
    # -z 时每项是“作用域\0名字\n值\0”
    parts = cfg.split("\0")
    for i in range(0, len(parts) - 1, 2):
        scope = parts[i]
        name, _, value = parts[i + 1].partition("\n")
        low = name.lower()
        risky = low.startswith("filter.") or low in ("core.attributesfile", "attr.tree")
        if scope == "local":
            risky = risky or low.startswith(("include.", "includeif.")) or low in (
                "core.worktree", "core.hookspath", "core.fsmonitor", "extensions.worktreeconfig")
        if not risky or scope == "command":
            continue
        if scope in ("system", "global") and LFS_OK.get(name) == value:
            continue
        bad.append(f"{scope}:{name}")
    if bad:
        fail(f"git 配置里有发布时不许有的设置（会让 git 执行别的程序或读别处的属性）：{'、'.join(sorted(set(bad)))}")
    # R-269：不靠 git status 的大小和修改时间缓存，用临时索引从 HEAD 重建后逐个比内容
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(pathlib.Path(tmp) / "index"))
        git("-c", "core.splitIndex=false", "read-tree", "HEAD", env=env)
        git("-c", "core.ignoreStat=false", "update-index", "-q", "--refresh", ok=(0, 1), env=env)
        _, diff = git("-c", "core.quotepath=false", "diff-files", "--name-only", env=env)
    if diff.strip():
        fail(f"有被跟踪的文件内容和检出的提交不一样：{'、'.join(diff.split()[:10])}")


def check_no_env_files() -> None:
    found = [n for n in ENV_FILES if (ROOT / n).exists()]
    for sub in ("workers/lemo-ops", "supabase"):
        d = ROOT / sub
        if d.is_dir():
            found += [f"{sub}/{p.name}" for p in d.iterdir() if p.name.startswith(".env")]
    if found:
        fail(f"仓库里有 wrangler 或 Supabase CLI 会自动读的环境文件：{'、'.join(found)}")


def function_names(preview_funcs: list[str], env: str) -> list[str]:
    _, out = git("-c", "core.quotepath=false", "ls-files", "--", "supabase/functions")
    names = []
    for line in out.splitlines():
        m = re.fullmatch(r"supabase/functions/([^/]+)/index\.ts", line.strip(), re.IGNORECASE)
        if not m:
            continue
        if not line.strip().endswith("/index.ts"):
            fail(f"{line.strip()} 的文件名大小写不对，入口必须是小写的 index.ts")
        n = m.group(1)
        if n.startswith("_"):
            continue
        if not FN_NAME.fullmatch(n):
            fail(f"supabase/functions/{n} 的名字不合规（只许小写字母、数字和 -）")
        if n in preview_funcs:
            fail(f"supabase/functions/{n} 是预览专用函数，只许由 deploy-preview 在预览产物里生成入口")
        names.append(n)
    if not names:
        fail("supabase/functions 下没有被 git 跟踪的函数（<名>/index.ts）")
    if env == "preview":
        names += preview_funcs
    return sorted(names)


def ops_plan(env: str) -> bool:
    """usage-report 和 lemo-ops 必须同一次部署（上线与回滚手册第三节）：正式环境 tag 里两样都有就一起部署；预览没有 lemo-ops。"""
    toml = ROOT / OPS_CONFIG
    if env == "preview":
        return False
    if not toml.exists():
        if (ROOT / "supabase/functions/usage-report").exists():
            fail(f"有 usage-report 却没有 {OPS_CONFIG}：两样必须同一次部署")
        return False
    text = toml.read_text(encoding="utf-8")
    if not re.search(r'(?m)^\s*name\s*=\s*"lemo-ops"\s*$', text):
        fail(f"{OPS_CONFIG} 里的 name 不是 lemo-ops")
    ids = re.findall(r'(?m)^\s*id\s*=\s*"([^"]*)"', text)
    if not ids or any(not re.fullmatch(r"[0-9a-f]{32}", i) for i in ids):
        fail(f"{OPS_CONFIG} 里 KV 的 id 缺了或还是占位值（要 32 位小写十六进制）")
    return True


def preview_func_list() -> list[str]:
    r = subprocess.run([sys.executable, "-I", "build/check_backend.py", "--print-preview-funcs"], cwd=ROOT, capture_output=True)
    if r.returncode != 0:
        fail("读不出预览专用函数的名单（build/check_backend.py --print-preview-funcs）")
    names = [x.strip() for x in r.stdout.decode("utf-8").splitlines() if x.strip()]
    for n in names:
        if not FN_NAME.fullmatch(n):
            fail("预览专用函数名单里有不合规的名字")
    return names


def new_migrations(tag: str) -> list[str]:
    """上一个正式 tag 以来新加的迁移（只给负责人批准前看一眼，不决定任何事；真要执行哪些以部署时 db push --dry-run 为准）。"""
    mine = tuple(int(x) for x in tag[1:].split("-")[0].split("."))
    _, out = git("tag", "-l", "v*")
    older = sorted((tuple(int(x) for x in m.groups()), t) for t in out.split() if (m := PROD_TAG.fullmatch(t)))
    prev = [t for v, t in older if v < mine]
    if not prev:
        return []
    _, diff = git("-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=A", prev[-1], "HEAD", "--", "supabase/migrations")
    return [x for x in diff.splitlines() if x.strip()]


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    out_path = os.environ.get("GITHUB_OUTPUT")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    try:
        sha = os.environ.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            fail("没有 GITHUB_SHA")
        if not out_path:
            fail("没有 GITHUB_OUTPUT")
        only = os.environ.get("ONLY") or "all"
        if only not in ("all", "functions"):
            fail(f"only 只能是 all 或 functions，现在是 {only}")
        info = parse_tag(os.environ.get("GITHUB_REF", ""))
        check_tag(info, sha)
        warn = ""
        if info["env"] == "production" and only == "all":
            newer = newer_tags(info["ver"])
            if newer and os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
                fail(f"已有更高版本的 tag：{'、'.join(newer)}。推旧 tag 不自动发布（会让线上倒退）；确要发，在 Actions 里手动触发并选这个 tag")
            if newer:
                warn = f"已有更高版本的 tag：{'、'.join(newer)}，这次是手动发旧版本"
        check_git_state()
        check_no_env_files()
        pf = preview_func_list()
        fns = function_names(pf, info["env"])
        ops = ops_plan(info["env"])
        prod = info["env"] == "production"
        res = {
            **info,
            "only": only,
            "ops": "true" if ops else "false",
            "functions": ",".join(fns),
            "preview_funcs": ",".join(pf),
            "pages_project": "lemomemo" if prod else "lemomemo-preview",
            "site_origin": "https://lemomemo.com" if prod else "https://preview.lemomemo.com",
            "build_workflow": ".github/workflows/release-build.yml" if prod else ".github/workflows/deploy-preview.yml",
            "artifact_name": f"release-publish-{info['tag']}" if prod else "preview-bundle",
        }
        with open(out_path, "a", encoding="utf-8", newline="\n") as f:
            for k, v in res.items():
                f.write(f"{k}={v}\n")
        migs = new_migrations(info["tag"]) if prod else []
        lines = [
            f"## {info['tag']} 发布前检查通过（{'正式' if prod else '预览演练'}，{'只部署服务器函数' if only == 'functions' else '完整发布'}）",
            "",
            f"- 部署后线上 version.json 应是 `{info['expect']}`（{res['site_origin']}）",
            f"- 服务器函数（{len(fns)} 个）：{'、'.join(fns)}",
            f"- lemo-ops：{'一起部署' if ops else '不部署'}",
        ]
        if prod and only == "all":
            lines.append(f"- 上一个正式 tag 以来新加的迁移：{'、'.join(pathlib.PurePosixPath(m).name for m in migs) if migs else '没有'}")
        if warn:
            lines.append(f"- ⚠ {warn}")
            print(f"::warning::{warn}")
        text = "\n".join(lines) + "\n"
        print(text)
        if summary:
            with open(summary, "a", encoding="utf-8", newline="\n") as f:
                f.write(text + "\n")
        return 0
    except Stop as e:
        print(f"::error::发布停止（还没部署任何东西）：{e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
