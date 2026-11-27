"""旧版客户端契约测试的“基线”：决定拿哪个提交的 tests/compat/ 去打当前的数据库（架构 0.27 第 1 点、0.28 第 4 点，TC-B0-57）。

规则（详见 docs/08-发布/compat-baseline说明.md）：
- 有 4.0.0 及以后的正式发布 tag（vX.Y.Z，X ≥ 4，不带 -preview 之类后缀）以后：基线 = 当前提交能追溯到的最新一个发布 tag，**必须通过**（strict）。
- 还没有发布 tag（4.0.0 上线前）：基线 = 内部 tag `compat-baseline`，**只报告、不拦**（report）。
- 两个都没有：跳过，并提示先打 `compat-baseline`。

用法：
  python -I build/compat_baseline.py resolve
      打印 ref=… 和 strict=true/false；在 GitHub Actions 里同时写进 $GITHUB_OUTPUT。
  python -I build/compat_baseline.py extract <ref> <目录>
      把 <ref> 那个提交的 tests/compat/ 原样取出到 <目录>（不切分支、不动工作区）。
  python -I build/compat_baseline.py tag [--move --reason "为什么挪"]
      在当前提交上打带说明的 tag `compat-baseline`（只在本机打，不推送）。
      检查：工作区干净；tests/compat/ 里有文件；还没有正式发布 tag；已有 compat-baseline 时必须 --move 并写理由。

只用标准库；只读 git，`tag` 子命令才会写本机的 tag。推送由主持人手动执行（脚本最后会打印命令）。
"""
import io
import os
import pathlib
import re
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASELINE_TAG = "compat-baseline"
RELEASE_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
COMPAT_DIR = "tests/compat"


def git(*args, check=True, binary=False):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if check and r.returncode != 0:
        raise SystemExit("git " + " ".join(args) + " 出错：" + r.stderr.decode("utf-8", "replace").strip())
    return r if binary else subprocess.CompletedProcess(
        r.args, r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace"))


def release_tags_reachable():
    """当前提交能追溯到的正式发布 tag，按版本从新到旧。"""
    out = git("tag", "--merged", "HEAD").stdout.split()
    # v3.0.0 等 4.0.0 以前的 tag 没有 tests/compat/，也不是 4.x 数据库的客户端，不算
    tags = [t for t in out if RELEASE_RE.match(t) and int(RELEASE_RE.match(t).group(1)) >= 4]
    return sorted(tags, key=lambda t: tuple(int(x) for x in RELEASE_RE.match(t).groups()), reverse=True)


def tag_exists(name):
    return git("rev-parse", "-q", "--verify", f"refs/tags/{name}", check=False).returncode == 0


def resolve():
    releases = release_tags_reachable()
    if releases:
        return releases[0], True
    if tag_exists(BASELINE_TAG):
        return BASELINE_TAG, False
    return "", False


def cmd_resolve():
    ref, strict = resolve()
    if ref:
        mode = "必须通过" if strict else "只报告、不拦（上线前）"
        print(f"契约测试基线：{ref}（{mode}）")
    else:
        print(f"还没有发布 tag，也没有 {BASELINE_TAG}：本次跳过契约测试。"
              f"tests/compat/ 第一批用例合并后，按 docs/08-发布/compat-baseline说明.md 打 tag。")
    print(f"ref={ref}")
    print(f"strict={'true' if strict else 'false'}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"ref={ref}\nstrict={'true' if strict else 'false'}\n")
    return 0


def cmd_extract(ref, dest):
    if not ref:
        raise SystemExit("没有基线可取")
    git("rev-parse", "--verify", f"{ref}^{{commit}}")
    dest = pathlib.Path(dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    data = git("archive", "--format=tar", ref, "--", COMPAT_DIR, binary=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            # 只接受普通文件和目录，路径必须落在 dest 里（防止 ../ 和链接）
            target = (dest / m.name).resolve()
            if not (m.isfile() or m.isdir()) or not str(target).startswith(str(dest)):
                raise SystemExit(f"基线里有不接受的条目：{m.name}")
        tar.extractall(dest, filter="data")
    n = sum(1 for p in (dest / COMPAT_DIR).rglob("*") if p.is_file())
    print(f"已取出 {ref} 的 {COMPAT_DIR}/（{n} 个文件）到 {dest}")
    return 0


def cmd_tag(argv):
    move = "--move" in argv
    reason = ""
    if "--reason" in argv:
        i = argv.index("--reason")
        reason = argv[i + 1].strip() if i + 1 < len(argv) else ""
    dirty = git("status", "--porcelain", "--untracked-files=all").stdout.strip()
    if dirty:
        raise SystemExit("工作区有没提交的改动，先提交再打 tag：\n" + dirty)
    files = git("ls-files", "--", COMPAT_DIR).stdout.split()
    if not files:
        raise SystemExit(f"{COMPAT_DIR}/ 里还没有已提交的文件，没有可以当基线的契约测试")
    releases = release_tags_reachable()
    if releases:
        raise SystemExit(f"已经有正式发布 tag {releases[0]}，从它起基线就是发布 tag，不再打 {BASELINE_TAG}")
    head = git("rev-parse", "HEAD").stdout.strip()
    if tag_exists(BASELINE_TAG):
        old = git("rev-parse", f"{BASELINE_TAG}^{{commit}}").stdout.strip()
        if old == head:
            print(f"{BASELINE_TAG} 已经在当前提交 {head[:12]} 上，不用再打")
            return 0
        if not move or not reason:
            raise SystemExit(f"{BASELINE_TAG} 已在 {old[:12]}；要挪到当前提交，加 --move --reason \"为什么挪\"")
        git("tag", "-d", BASELINE_TAG)
        print(f"已删除本机的旧 {BASELINE_TAG}（原在 {old[:12]}）")
    msg = (f"契约测试基线（上线前只报告、不拦，0.28 第 4 点）\n\n"
           f"tests/compat/ 文件数：{len(files)}\n"
           f"理由：{reason or 'B0 第一次打'}")
    git("tag", "-a", BASELINE_TAG, "-m", msg, head)
    print(f"已在 {head[:12]} 打 {BASELINE_TAG}（本机）。推送由主持人执行：")
    if move:
        print(f"  git push --force origin refs/tags/{BASELINE_TAG}")
    else:
        print(f"  git push origin refs/tags/{BASELINE_TAG}")
    return 0


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "resolve" and len(argv) == 2:
        return cmd_resolve()
    if cmd == "extract" and len(argv) == 4:
        return cmd_extract(argv[2], argv[3])
    if cmd == "tag":
        return cmd_tag(argv[2:])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
