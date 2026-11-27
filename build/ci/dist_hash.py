"""给构建产物算一个总指纹，用来核对“本机发布用的产物”和“CI 在同一个 tag 上构建的产物”是同一份（R-206）。

用法：python -I build/ci/dist_hash.py <目录> [--list 清单文件]
  输出两行：文件数、总指纹（SHA-256）。
  --list：另把每个文件的“SHA-256  相对路径”写进清单文件，两边对不上时拿两份清单比，看是哪个文件不同。

算法：目录下每个文件按相对路径（/ 分隔、按 UTF-8 字节排序）逐个算 SHA-256，
拼成“哈希␠␠路径\n”的文本，再对整段文本算 SHA-256。和文件修改时间、换行符设置、操作系统无关。
只读，不改任何文件；不跟随符号链接。
"""
import hashlib
import pathlib
import sys


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def manifest(root):
    rows = []
    for p in root.rglob("*"):
        if p.is_symlink():
            raise SystemExit(f"产物里不应有符号链接：{p}")
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            rows.append((rel.encode("utf-8"), rel, file_sha256(p)))
    rows.sort()
    return [(rel, digest) for _, rel, digest in rows]


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--list"):
        print(__doc__)
        return 2
    root = pathlib.Path(argv[1])
    if not root.is_dir():
        print(f"目录不存在：{root}")
        return 1
    rows = manifest(root)
    if not rows:
        print(f"目录是空的：{root}")
        return 1
    text = "".join(f"{digest}  {rel}\n" for rel, digest in rows)
    total = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if len(argv) == 4:
        pathlib.Path(argv[3]).write_text(text, encoding="utf-8", newline="\n")
    print(f"文件数：{len(rows)}")
    print(f"总指纹：{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
