// 按用户从 JSON 备份恢复数据（上线与回滚手册第 3 层第 5 步；架构第 10 节；TC-B7a-10）。逻辑和测试见 restore-lib.mjs、tests/build/backup-restore.test.ts。
//
// 由负责人本人在自己的 PowerShell 窗口里运行（要用数据库连接串，postgres 角色）：
//   node tools\backup\restore.mjs --user <user_id> --from "E:\柠檬记-备份\每日\<日期>\<user_id>" --dry-run
//   看完条数，再去掉 --dry-run、加 --confirm <ref>（本机写 --confirm local）正式执行。
//   凭据类表（api_tokens、devices、device_secrets、vault_credentials、admins）和 vault、invites 默认不恢复，要恢复就 --only 点名
//   （B7a 评审第 12 条、复审第 2 条）；停用状态、AI 同意、PIN 锁定、用量上限、ai.* 设置保留库里现值（restore-lib 的 KEEP_LIVE）。
// 连接串：环境变量 LEMO_RESTORE_DB_URL 只在指向本机（127.0.0.1、localhost）时才认，本机测试用（B7a 复审第 10 条）；
//   正式、预览一律在这里提示粘贴，屏幕不显示。不打印、不写文件、不进命令行参数。
//   正式、预览的连接串在 Supabase 控制台 Project Settings → Database（直连 db.<ref>.supabase.co 或连接池 Session 模式都行）。
// 整个恢复在一个事务里：中途出错整体回退。只增改、不删（库里多出来的行只报条数）；可以放心重跑。图片和附件不在这里，见 restore-files.ps1。
// 例外：库里占着备份里同一句 AI 记忆、同名分类、同一个设置 key（主键不同）的行，先软删（设置是删掉）、引用改指到备份那条，试运行会报出条数（restore-lib 的 SECOND_UNIQUE）。
// 退出码：0 成功；1 参数或备份文件不对（一条没写）；2 连不上库或密码错（db_connect，一条没写）、写库失败（db_write，已整体回退）、
//   提交那一步出错（commit_unknown，前后不确定，先 --dry-run 核对）；4 已经恢复并提交，之后打印报告时出错（数据已写好，不是连库问题）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import postgres from 'postgres';
import { KEEP_LIVE, RestoreError, dbUrlFromEnv, loadBackup, parseArgs, restore, sqlClient, targetOfDbUrl } from './restore-lib.mjs';

const say = (s) => process.stdout.write(`${s}\n`);

/** 屏幕不回显地读一行（TTY）；不是 TTY 时报错（不从管道读连接串，免得进历史） */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    if (!stdin.isTTY) { reject(new RestoreError('no_db_url', '没有数据库连接串：在自己的 PowerShell 窗口里运行，按提示粘贴')); return; }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err); else resolve(buf.trim());
    };
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(null); return; }
        if (c === '\u0003') { done(new RestoreError('cancelled', '已取消')); return; }
        if (c === '\u0008' || c === '\u007f') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backup = loadBackup((name) => readFileSync(join(args.from, name)), args.user);
  say(`备份：${backup.manifest.date}（项目 ${backup.manifest.project ?? '没写'}，完成于 ${backup.manifest.finished_at}），${backup.tables.length} 张表，文件和 sha256 全部对上`);
  let dbUrl = dbUrlFromEnv(process.env.LEMO_RESTORE_DB_URL) || await readHidden('粘贴目标项目的数据库连接串（屏幕不显示），回车：');
  const target = targetOfDbUrl(dbUrl);
  if (!target) throw new RestoreError('bad_args', '连接串只认 db.<ref>.supabase.co、*.pooler.supabase.com（用户名 postgres.<ref>）或本机 127.0.0.1');
  if (!args.dryRun && args.confirm !== target) {
    throw new RestoreError('bad_args', `正式执行要加 --confirm ${target}（先用 --dry-run 看过条数）`);
  }
  const sql = postgres(dbUrl, {
    max: 1, prepare: false, connect_timeout: 15, idle_timeout: 5, onnotice: () => {},
    ssl: target === 'local' ? false : 'require',
  });
  dbUrl = '';
  let result;
  try {
    result = await restore({ backup, userId: args.user, target, client: sqlClient(sql), dryRun: args.dryRun, only: args.only, say });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  // 到这里正式执行已经提交：下面只是打印，出错不能再报成连库或写库失败（B7a 复审第 9 条）
  try {
    printReport(args.dryRun, result);
  } catch {
    throw new RestoreError('print_after_commit', args.dryRun ? '试运行做完了，打印报告时出错（一条没写）' : '已经恢复并提交；之后打印报告时出错（数据已写好，不是连库问题），用 --dry-run 再看一遍条数');
  }
}

function printReport(dryRun, { report, skipped, warnings }) {
  say(dryRun ? '试运行（一条没写）：' : '已恢复（一个事务，已提交）：');
  const will = dryRun ? '会' : '已';
  for (const r of report) {
    const retire = r.retire ? `；库里占着备份里同一个唯一值（主键不同）的 ${r.retire} 条${will}先软删或删掉（备份占先）` : '';
    const repoint = r.repoint ? `；指着它们的引用 ${r.repoint} 行${will}改指到备份里那条` : '';
    const keep = Object.hasOwn(KEEP_LIVE, r.table) ? `；${KEEP_LIVE[r.table].label}保留库里现值${r.kept ? `（备份里这类 ${r.kept} 行不写）` : ''}` : '';
    say(`  ${r.table}：备份 ${r.backup} 行，库里原有 ${r.current} 行 → 新增 ${r.insert}、覆盖 ${r.overwrite}；库里有、备份里没有 ${r.extra} 行（不动）${retire}${repoint}${keep}`);
  }
  if (skipped.length) say(`  默认不恢复的表（凭据类、PIN 状态、邀请码；要恢复用 --only 点名）：${skipped.join('、')}`);
  for (const w of warnings) say(`  超上限：${w}`);
  if (!dryRun) say('完成。请 QA 核对条数、抽查；本人在 iPhone 上整表重拉后看一遍（手册第 3 层第 6 步）。');
}

main().catch((e) => {
  const code = e instanceof RestoreError ? e.code : 'error';
  process.stderr.write(`restore.mjs：${e instanceof RestoreError ? e.message : '意外错误（连接串格式不对或脚本出错）'}（${code}）\n`);
  if (code === 'print_after_commit') process.exit(4);
  process.exit(['db_read', 'db_write', 'db_connect', 'commit_unknown', 'verify', 'error'].includes(code) ? 2 : 1);
});
