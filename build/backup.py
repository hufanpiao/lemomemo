"""版本前源码备份（ADR-009；R-105 放 E 盘，R-208 不再备份 v3 数据，R-209 不加密）。

用法：python build/backup.py <时机>      例如：python build/backup.py 4.0.0开工前

做四件事：
1. 检查工作区是否都已提交（有未提交的改动就停下，避免备份不完整）。
2. 源码：用 git bundle 把整个仓库连同全部历史打包，并用 git bundle verify 校验。
3. 恢复测试：把 bundle clone 到临时目录（开 core.longpaths），跑 git fsck --full，
   核对 HEAD、HEAD^{tree} 和全部分支、标签（替 QA 做一次可恢复验证，结果写进清单）。
4. bundle 和 清单.json 写到 E:\\柠檬记-备份\\版本前\\<日期>_<时机>\\；这个文件夹已存在就停下，不覆盖。
   中途出错会删掉做了一半的文件夹。

数据不在这里备份：R-208 起 v3 数据不要了；4.0.0 上线后的数据备份另行设计（架构第 10 节）。
恢复：git -c core.longpaths=true clone <bundle 文件> 柠檬记APP，再 git -C 柠檬记APP config core.longpaths true
      （仓库里有超长路径，不加 core.longpaths=true 会检出失败）
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
# R-105：备份放 E 盘、不放 D:\claude code\ 下面（架构第 10 节）；R-209：版本前源码备份不加密
BACKUP_ROOT = pathlib.Path("E:/柠檬记-备份") / "版本前"
# 标签形如 2026-10-28_4.0.0开工前。时机名白名单：文字（L*）、数字（N*）、. _ -，1～40 个字，
# 不能有 “..”、不能以点结尾。Python 标准库的 re 不支持 \p{…}，所以用 unicodedata 逐字判断
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def valid_when(when):
    if not 1 <= len(when) <= 40:
        return False
    if ".." in when or when.endswith((".", " ")):
        return False
    return all(unicodedata.category(c)[0] in "LN" or c in "._-" for c in when)


def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")


def force_remove(func, path, _exc):
    # git 的对象文件是只读的，Windows 上要先去掉只读再删
    os.chmod(path, stat.S_IWRITE)
    func(path)


def remove_partial(out):
    """删掉做了一半的备份文件夹；返回给用户看的一句话。"""
    if out is None or not out.exists():
        return ""
    try:
        shutil.rmtree(out, onerror=force_remove)
        return f"\n（已删除做了一半的备份文件夹 {out}）"
    except OSError as e:
        return f"\n（做了一半的备份文件夹删不掉，请手动删除：{out}，原因：{e}）"


def fail(msg, out=None):
    print("备份失败：" + msg + remove_partial(out))
    sys.exit(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def refs_of(lines):
    # 只比分支和标签；HEAD 单独比。ls-remote 用制表符、show-ref 用空格分隔，统一拆成（提交号, 引用名）
    out = []
    for line in lines.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith(("refs/heads/", "refs/tags/")) and not parts[1].endswith("^{}"):
            out.append((parts[0], parts[1]))
    return sorted(out)


def restore_test(bundle, commit, tree):
    """从 bundle clone 到临时目录，跑 fsck，核对 HEAD、HEAD^{tree}、分支和标签。返回写进清单的结果。"""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="柠檬记恢复测试_"))
    try:
        target = tmp / "柠檬记APP"
        # 仓库里有超过 260 字符的路径（assets/reference/ui参考/…），不开 longpaths 会检出失败
        c = git("-c", "core.longpaths=true", "clone", "-q", str(bundle), str(target), cwd=tmp)
        if c.returncode != 0:
            return {"通过": False, "原因": "git clone 出错：" + c.stderr.strip()}
        fsck = git("fsck", "--full", "--no-progress", cwd=target)
        head = git("rev-parse", "HEAD", cwd=target).stdout.strip()
        head_tree = git("rev-parse", "HEAD^{tree}", cwd=target).stdout.strip()
        # bundle 里的引用和仓库里的引用逐条对照
        in_bundle = refs_of(git("ls-remote", str(bundle)).stdout)
        in_repo = refs_of(git("show-ref", "--heads", "--tags").stdout)
        result = {
            "时间": datetime.datetime.now().isoformat(timespec="seconds"),
            "方法": "git -c core.longpaths=true clone <bundle> 到临时目录；git fsck --full；"
                    "核对 HEAD、HEAD^{tree}，逐条比对分支和标签",
            "git fsck --full": "通过" if fsck.returncode == 0 else "没通过：" + fsck.stderr.strip()[:500],
            "恢复出的 HEAD": head,
            "HEAD 一致": head == commit,
            "HEAD^{tree} 一致": head_tree == tree,
            "分支和标签一致": in_bundle == in_repo,
            "分支和标签数": len(in_bundle),
        }
        result["通过"] = (fsck.returncode == 0 and result["HEAD 一致"]
                          and result["HEAD^{tree} 一致"] and result["分支和标签一致"])
        return result
    finally:
        shutil.rmtree(tmp, onerror=force_remove)


def run(state):
    if len(sys.argv) != 2 or sys.argv[1].startswith("--"):
        fail("请写明备份时机，例如：python build/backup.py 4.0.0开工前")
    when = sys.argv[1]
    if not valid_when(when):
        fail("时机名只能用文字、数字和 . _ -，1～40 个字，不能有“..”，不能以点结尾。例如：4.0.0开工前")
    today = datetime.date.today().isoformat()
    assert DATE_RE.fullmatch(today)
    tag = f"{today}_{when}"

    # 1. 工作区必须干净
    dirty = git("status", "--porcelain").stdout.strip()
    if dirty:
        fail("还有未提交的改动，先提交再备份：\n" + dirty)
    commit = git("rev-parse", "HEAD").stdout.strip()
    tree = git("rev-parse", "HEAD^{tree}").stdout.strip()
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()

    # 备份文件夹：已存在就停下，不覆盖旧备份
    out = BACKUP_ROOT / tag
    if out.exists():
        fail(f"备份文件夹已存在：{out}。不覆盖旧备份，请换一个时机名，或确认后手动处理。")
    out.mkdir(parents=True)
    state["out"] = out  # 从这里起出任何错都要删掉这个文件夹（见 main）

    # 2. 源码 bundle
    bundle = out / f"{tag}.bundle"
    r = git("bundle", "create", str(bundle), "--all")
    if r.returncode != 0:
        fail("git bundle 出错：" + r.stderr, out)
    v = git("bundle", "verify", str(bundle))
    if v.returncode != 0:
        fail("bundle 校验没通过：" + v.stderr, out)
    size = bundle.stat().st_size
    print(f"源码已打包：{bundle}（{size} 字节，提交 {commit[:7]}，分支 {branch}）")

    # 3. 恢复测试
    restore = restore_test(bundle, commit, tree)
    if not restore["通过"]:
        fail("恢复测试没通过：" + json.dumps(restore, ensure_ascii=False), out)
    print(f"恢复测试通过：git fsck --full 通过，clone 出的 HEAD {restore['恢复出的 HEAD'][:7]} 和目录树与仓库一致，"
          f"分支和标签 {restore['分支和标签数']} 条一致")

    # 4. 清单
    digest = sha256(bundle)
    manifest = {
        "备份时机": when,
        "时间": datetime.datetime.now().isoformat(timespec="seconds"),
        "git 提交": commit,
        "git 目录树": tree,
        "git 分支": branch,
        "源码 bundle": bundle.name,
        "bundle 大小（字节）": size,
        "bundle SHA256": digest,
        "bundle 校验": "git bundle verify 通过",
        "恢复测试": restore,
        "说明": "只备份源码，不加密（R-209）；v3 数据不再备份（R-208）。"
                "恢复：git -c core.longpaths=true clone <bundle> 柠檬记APP，再 git -C 柠檬记APP config core.longpaths true。",
    }
    (out / "清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    state["out"] = None  # 做完了，不再自动删除
    print(f"完成：{out}")
    print(f"  bundle SHA256：{digest}")
    print("请在 docs/08-发布/发布记录.md 的“备份记录”里记一笔（路径、大小、SHA256、提交号）。")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    state = {"out": None}
    try:
        run(state)
    except SystemExit:
        raise
    except BaseException as e:  # 含 Ctrl+C：意外出错时清理做了一半的备份文件夹
        print(f"备份失败：意外错误 {type(e).__name__}：{e}" + remove_partial(state["out"]))
        sys.exit(1)


if __name__ == "__main__":
    main()
