// 每日备份的文件约定在三种语言里各有一份（B7a 评审第 15 条）：服务器 supabase/functions/_shared/backup-format.ts 是准，
// 本机拉回 tools/backup/backup-lib.ps1、恢复 tools/backup/restore-lib.mjs、读取口和统计迁移 20261126130000 各抄一份。
// 这里逐字核对，改约定时漏改哪一边就在这里红：文件名正则、_manifest 文件名、文件格式名、R2 桶名单、经读取口读的表。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLE_KEYS } from '../../supabase/functions/backup-daily/core.ts';
import {
  BACKUP_DATE_RE, BACKUP_FILE_RE, DATA_FILE_RE, FILE_FORMAT, MANIFEST_FILE, MANIFEST_FORMAT, UUID_RE, runningFile,
} from '../../supabase/functions/_shared/backup-format.ts';
import { R2_BUCKETS } from '../../supabase/functions/_shared/objstore-buckets.ts';
import * as restoreLib from '../../tools/backup/restore-lib.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const PS1 = readFileSync(join(ROOT, 'tools', 'backup', 'backup-lib.ps1'), 'utf8');
const MIG = readFileSync(join(ROOT, 'supabase', 'migrations', '20261126130000_core_backup_read_dispatch.sql'), 'utf8');

/** backup-lib.ps1 里 $script:<名字> = '<值>' 的值（单引号字符串） */
function psString(name: string): string {
  const m = new RegExp(`^\\$script:${name} = '([^']*)'`, 'm').exec(PS1);
  if (!m?.[1]) throw new Error(`backup-lib.ps1 里没有 $script:${name}`);
  return m[1];
}

describe('备份文件约定：TS、PowerShell、Node、SQL 一致', () => {
  it('PowerShell 的 BackupFileRe 认得的文件名 = 服务器的 BACKUP_FILE_RE 去掉认领标记 _running.<编号>（pull.ps1 用不着正在做的标记）', () => {
    expect(psString('BackupFileRe')).toBe(BACKUP_FILE_RE.source.replace('_manifest|_running\\.[1-9][0-9]{3,8}|', '_manifest|'));
    expect(BACKUP_FILE_RE.test(runningFile(1, 0)) && BACKUP_FILE_RE.test(runningFile(12, 79))).toBe(true);
    const ps = new RegExp(psString('BackupFileRe'));
    for (const n of [MANIFEST_FILE, 'a_notes.json.gz', 'b_notes.12.json.gz', 'a_vault_ai.json.gz']) expect([n, ps.test(n)]).toEqual([n, true]);
    for (const n of [runningFile(1, 0), '_running.json.gz', 'notes.json.gz', 'c_notes.json.gz', 'a_notes.0.json.gz', 'a_notes.10000.json.gz', '../a_x.json.gz']) expect([n, ps.test(n)]).toEqual([n, false]);
  });

  it('PowerShell 的 UuidRe 和服务器的 UUID_RE 一字不差；DateRe 认的和 BACKUP_DATE_RE 一样', () => {
    expect(psString('UuidRe')).toBe(UUID_RE.source);
    const ps = new RegExp(psString('DateRe'));
    for (const d of ['2026-12-02', '2026-1-02', '20261202', '2026-12-02x']) expect([d, ps.test(d)]).toEqual([d, BACKUP_DATE_RE.test(d)]);
  });

  it('Node 恢复脚本的 DATA_FILE_RE、_manifest 文件名、格式名和服务器一字不差', () => {
    expect(restoreLib.DATA_FILE_RE.source).toBe(DATA_FILE_RE.source);
    expect(restoreLib.DATA_FILE_RE.flags).toBe(DATA_FILE_RE.flags);
    expect([restoreLib.MANIFEST_FILE, restoreLib.MANIFEST_FORMAT, restoreLib.FILE_FORMAT]).toEqual([MANIFEST_FILE, MANIFEST_FORMAT, FILE_FORMAT]);
  });

  it('PowerShell 的 R2Buckets 名单和顺序 = _shared/objstore-buckets.ts', () => {
    const m = /^\$script:R2Buckets = \[ordered\]@\{(.*)\}$/m.exec(PS1);
    const names = [...(m?.[1] ?? '').matchAll(/'([a-z-]+)' = /g)].map((x) => x[1]);
    expect(names).toEqual([...R2_BUCKETS]);
    // restore-files.ps1 的 -Bucket 只收这四个（空 = 全部）
    const files = readFileSync(join(ROOT, 'tools', 'backup', 'restore-files.ps1'), 'utf8');
    const set = /\[ValidateSet\('', ([^\]]+)\)\]\[string\]\$Bucket/.exec(files)?.[1] ?? '';
    expect([...set.matchAll(/'([a-z-]+)'/g)].map((x) => x[1])).toEqual([...R2_BUCKETS]);
  });

  it('SQL：backup_read 的 case 正好是 TABLE_KEYS 里 rpc 的几张表；backup_missing 数的是 <日期>/<user_id>/_manifest 文件', () => {
    const cases = [...MIG.matchAll(/^\s+when '([a-z_]+)' then/gm)].map((x) => x[1]).sort();
    const rpc = [...TABLE_KEYS].filter(([, v]) => v.rpc).map(([k]) => k).sort();
    expect(cases).toEqual(rpc);
    expect(MIG).toContain(`'/${MANIFEST_FILE}'`);
  });
});
