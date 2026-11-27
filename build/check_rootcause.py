# 修 bug 的提交要写根因证据（负责人 2026-11-24：“你不确定的话能不能先问问我？”“每次都是这样”“给我方案以后怎么避免”，弹窗选“全部写进规则并加硬拦”）
# 起因：11-24 顶部发白，510 对照版截图像素不变就断定“iOS 系统模糊”，可那一块底下没内容、糊不糊都一样，证据分不出两种可能；顺着错的结论上了 511 实色条，又返工一版。
# 两种用法：
#   python -I build/check_rootcause.py --commit-msg <提交说明文件>   本机 commit-msg 钩子（.githooks/commit-msg）调
#   python -I build/check_rootcause.py --range <起>..<止>            CI（unit.yml）查推上来、PR 里的每个提交
# 规则：提交说明第一行像是在修问题（见 FIX），说明里必须有一行
#   根因证据：<证据是什么（日志哪几行、截图量到什么）>，排除了<另一种可能>
# 这一行里要有“排除”两个字：写不出排除了什么，就说明证据分不出两种可能，还不能叫根因，先别提交修复。
# 合并、撤销提交不查；START 之前的提交不查。
import re, subprocess, sys

START = '2026-11-24T14:30:00+09:00'
FIX = re.compile(r'修|bug|不再|根因|\bfix', re.I)
EVID = re.compile(r'^根因证据[:：]\s*(\S.{5,})$', re.M)
NEED = ('提交说明第一行像是在修问题，说明里要有一行：\n'
        '  根因证据：<证据：日志哪几行、截图量到什么>，排除了<另一种可能>\n'
        '写不出“排除了什么”，说明证据分不出两种可能，还不是根因：先补证据或先问负责人，别提交修复。\n'
        '负责人 11-24：“你不确定的话能不能先问问我？”“每次都是这样”。')


def git(*args):
    r = subprocess.run(['git', *args], capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f'check_rootcause：git {" ".join(args[:2])} 失败：{r.stderr.decode("utf-8", "replace").strip()}')
    return r.stdout.decode('utf-8', 'replace')


def problem(msg):
    """缺什么；不像修问题的提交返回空"""
    if msg.startswith(('Merge ', 'Revert ')):
        return ''
    head = msg.splitlines()[0] if msg.strip() else ''
    if not FIX.search(head):
        return ''
    m = EVID.search(msg)
    if not m:
        return '缺“根因证据：”'
    if '排除' not in m.group(1):
        return '“根因证据：”这一行没写排除了哪种可能'
    return ''


def commit_msg(msg_file):
    msg = open(msg_file, encoding='utf-8', errors='replace').read()
    bad = problem(msg)
    if not bad:
        return 0
    print(f'commit-msg：{bad}，提交已取消。\n{NEED}', file=sys.stderr)
    return 1


def check_range(rng):
    base = rng.split('..')[0]
    if not base or set(base) == {'0'}:
        print('check_rootcause：没有起点（新分支第一次推），跳过')
        return 0
    bad = []
    for line in git('log', '--no-merges', f'--since={START}', '--format=%H', rng).splitlines():
        sha = line.strip()
        msg = git('log', '-1', '--format=%B', sha)
        miss = problem(msg)
        if miss:
            bad.append(f'{sha[:8]} {msg.splitlines()[0][:80]}：{miss}')
    if bad:
        print('check_rootcause：下面这些修问题的提交没写根因证据：\n' + '\n'.join(bad) + '\n' + NEED, file=sys.stderr)
        return 1
    print('check_rootcause：修问题的提交都写了根因证据')
    return 0


def main(argv):
    for st in (sys.stdout, sys.stderr):
        st.reconfigure(encoding='utf-8')
    if len(argv) >= 2 and argv[0] == '--commit-msg':
        return commit_msg(argv[1])
    if len(argv) >= 2 and argv[0] == '--range':
        return check_range(argv[1])
    print('用法见文件头', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
