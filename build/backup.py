"""版本前备份：源码 + 数据，放进暂存目录，等负责人本人加密（ADR-009，R-105 起）。

用法：python build/backup.py <时机> [--no-data]
      例如：python build/backup.py 4.0.0开发前
            python build/backup.py 测试 --no-data      （只备份源码，不要求数据已导出）

做五件事：
1. 检查工作区是否都已提交（有未提交的改动就停下，避免备份不完整）。
2. 源码：用 git bundle 把整个仓库连同全部历史打包，并用 git bundle verify 校验。
3. 恢复测试：把 bundle clone 到临时目录，核对 HEAD 和全部分支、标签是否和仓库一致
   （替 QA 做加密前的可恢复验证，结果写进清单；加密后的恢复演练仍由 QA 做）。
4. 数据：读 data/backups/<日期>_<时机>/（Claude 用 ArtifactData 导出的 events/、todos/、logs/），
   统计条数，复制进暂存目录。没导出时提示并以退出码 1 结束；加 --no-data 则跳过数据。
5. 把 bundle、数据文件夹、清单.json 放进暂存目录 E:\\柠檬记-备份\\暂存\\<日期>_<时机>\\，
   最后打印一条负责人要在自己 PowerShell 里运行的加密命令。

本脚本**不做加密**：密码只由负责人本人保存，AI 不接触明文（R-105、架构第 10 节）。
加密、测试、删除明文都由 build/backup_encrypt.ps1 完成，负责人本人运行。
恢复：先用 7-Zip 解开 .7z（输入密码），再 git -c core.longpaths=true clone <bundle 文件> 待办APP
      （仓库里有超长路径，不加 core.longpaths=true 会检出失败）
"""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
# R-105：备份放 E 盘、不放 D:\claude code\ 下面（架构第 10 节）；暂存目录在加密后由 ps1 删除
BACKUP_HOME = pathlib.Path("E:/柠檬记-备份")
STAGE_ROOT = BACKUP_HOME / "暂存"
ENCRYPT_PS1 = ROOT / "build" / "backup_encrypt.ps1"
ARTIFACT_URL = "https://claude.ai/artifact/MVXvnr3rFUxgFKZesXWGVT"
COLLECTIONS = ("events", "todos", "logs")
BAD_CHARS = set('\\/:*?"<>|')


def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")


def fail(msg, stage=None):
    # stage：已经建好的暂存目录，失败时删掉，免得留下半成品挡住下一次
    if stage is not None and stage.exists():
        shutil.rmtree(stage, onerror=force_remove)
        msg += f"\n（已删除没做完的暂存目录 {stage}）"
    print("备份失败：" + msg)
    sys.exit(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def force_remove(func, path, _exc):
    # git 的对象文件是只读的，Windows 上要先去掉只读再删
    os.chmod(path, stat.S_IWRITE)
    func(path)


def refs_of(lines):
    # 只比分支和标签；HEAD 单独比。ls-remote 用制表符、show-ref 用空格分隔，统一拆成（提交号, 引用名）
    out = []
    for line in lines.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith(("refs/heads/", "refs/tags/")) and not parts[1].endswith("^{}"):
            out.append((parts[0], parts[1]))
    return sorted(out)


def restore_test(bundle, commit):
    """从 bundle clone 到临时目录，核对 HEAD 和分支、标签。返回写进清单的结果。"""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="柠檬记恢复测试_"))
    try:
        target = tmp / "待办APP"
        # 仓库里有超过 260 字符的路径（assets/reference/ui参考/…），不开 longpaths 会检出失败
        c = git("-c", "core.longpaths=true", "clone", "-q", str(bundle), str(target), cwd=tmp)
        if c.returncode != 0:
            return {"通过": False, "原因": "git clone 出错：" + c.stderr.strip()}
        head = git("rev-parse", "HEAD", cwd=target).stdout.strip()
        # bundle 里的引用和仓库里的引用逐条对照
        in_bundle = refs_of(git("ls-remote", str(bundle)).stdout)
        in_repo = refs_of(git("show-ref", "--heads", "--tags").stdout)
        ok = head == commit and in_bundle == in_repo
        return {
            "通过": ok,
            "时间": datetime.datetime.now().isoformat(timespec="seconds"),
            "方法": "git clone <bundle> 到临时目录，核对 HEAD，并逐条比对分支和标签",
            "恢复出的 HEAD": head,
            "HEAD 一致": head == commit,
            "分支和标签一致": in_bundle == in_repo,
            "分支和标签数": len(in_bundle),
        }
    finally:
        shutil.rmtree(tmp, onerror=force_remove)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if flags - {"--no-data"}:
        fail("不认识的参数：" + "、".join(sorted(flags - {"--no-data"})))
    if len(args) != 1:
        fail("请写明备份时机，例如：python build/backup.py 4.0.0开发前（只备份源码加 --no-data）")
    when = args[0]
    if BAD_CHARS & set(when):
        fail("时机里不能有这些字符：\\ / : * ? \" < > |")
    no_data = "--no-data" in flags
    today = datetime.date.today().isoformat()
    tag = f"{today}_{when}"

    # 1. 工作区必须干净
    dirty = git("status", "--porcelain").stdout.strip()
    if dirty:
        fail("还有未提交的改动，先提交再备份：\n" + dirty)
    commit = git("rev-parse", "HEAD").stdout.strip()
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()

    # 数据先检查，免得打完 bundle 才发现没导出
    data_dir = ROOT / "data" / "backups" / tag
    if not no_data and not data_dir.is_dir():
        fail(f"没找到数据备份文件夹 {data_dir.relative_to(ROOT)}。"
             "请先让主持人（Claude）用 ArtifactData 把 events、todos、logs 导出到这里，再运行本脚本；"
             "只备份源码请加 --no-data。")

    # 暂存目录：已存在就停下，不和上一次的混在一起
    stage = STAGE_ROOT / tag
    if stage.exists():
        fail(f"暂存目录已存在：{stage}。上一次可能还没加密，先运行加密脚本或确认后手动删除。")
    if (BACKUP_HOME / "版本前" / f"{tag}.7z").exists():
        fail(f"今天这个时机的加密备份已经有了：{BACKUP_HOME / '版本前' / (tag + '.7z')}，换一个时机名。")
    (stage / "源码").mkdir(parents=True)

    # 2. 源码 bundle
    bundle = stage / "源码" / f"{tag}.bundle"
    r = git("bundle", "create", str(bundle), "--all")
    if r.returncode != 0:
        fail("git bundle 出错：" + r.stderr, stage)
    v = git("bundle", "verify", str(bundle))
    if v.returncode != 0:
        fail("bundle 校验没通过：" + v.stderr, stage)
    print(f"源码已打包：{bundle}（{bundle.stat().st_size} 字节，提交 {commit[:7]}，分支 {branch}）")

    # 3. 恢复测试（加密前）
    restore = restore_test(bundle, commit)
    if not restore["通过"]:
        fail("恢复测试没通过：" + json.dumps(restore, ensure_ascii=False), stage)
    print(f"恢复测试通过：clone 出的 HEAD {restore['恢复出的 HEAD'][:7]} 与仓库一致，"
          f"分支和标签 {restore['分支和标签数']} 条一致")

    # 4. 数据
    counts = None
    if not no_data:
        counts = {}
        for c in COLLECTIONS:
            d = data_dir / c
            counts[c] = len(list(d.glob("*.json"))) if d.is_dir() else 0
        shutil.copytree(data_dir, stage / "数据")
        print(f"数据已复制：{data_dir.relative_to(ROOT)} → {stage / '数据'}"
              f"  日程 {counts['events']} 条、待办 {counts['todos']} 条、日志 {counts['logs']} 份")
    else:
        print("按 --no-data 跳过数据，只备份源码。")

    # 5. 清单
    manifest = {
        "备份时机": when,
        "时间": datetime.datetime.now().isoformat(timespec="seconds"),
        "线上地址": ARTIFACT_URL,
        "条数": counts if counts is not None else "未备份数据（--no-data）",
        "数据来源": None if no_data else str(data_dir),
        "git 提交": commit,
        "git 分支": branch,
        "源码 bundle": f"源码/{bundle.name}",
        "bundle 大小（字节）": bundle.stat().st_size,
        "bundle SHA256": sha256(bundle),
        "bundle 校验": "git bundle verify 通过",
        "恢复测试（加密前）": restore,
        "加密": f"尚未加密；由负责人运行 build/backup_encrypt.ps1 打成 {BACKUP_HOME / '版本前' / (tag + '.7z')}",
        "说明": "条数为 0 表示导出时该集合为空。恢复方法见 data/backups/README.md。",
    }
    (stage / "清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"暂存完成：{stage}（里面是明文，加密后会被删除）")
    print()
    print("下一步请负责人本人在自己的 PowerShell 里运行（会提示输入两次密码、测试时再输一次；密码存 iPhone“密码”App）：")
    print(f'  powershell -NoProfile -ExecutionPolicy Bypass -File "{ENCRYPT_PS1}" -Tag "{tag}"')
    print("加密成功后，请在 docs/08-发布/发布记录.md 的“备份记录”里记一笔（.7z 路径、大小、SHA256）。")


if __name__ == "__main__":
    main()
