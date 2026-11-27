// tools/backup/restore.mjs 的纯逻辑（上线与回滚手册第 3 层第 5 步；架构第 10 节“恢复时用导入脚本，从按用户的 JSON 写回”；TC-B7a-10、TC-B7a-23）。
// 拆出来给 tests/build/backup-restore.test.ts 直接测：不读环境变量、不起子进程；连库只经传进来的 client（sqlClient 包一个 postgres.js 连接）。
//
// 读一个人一天的备份目录（pull.ps1 下载的 E:\柠檬记-备份\每日\<日期>\<user_id>\，或服务器 backups/<日期>/<user_id>/ 下载下来的同样结构）：
//   _manifest.json.gz（backup-daily 最后写的清单，带 gen：这一次的数据文件是 a_ 还是 b_ 开头）→ 每张表的文件按清单顺序读，
//   核对字节数、sha256、格式、表名、每一行确实是这个人的、行数；切片 <代>_<表>.1.json.gz、<代>_<表>.2.json.gz… 按清单顺序拼回。
//   任何一处对不上就整体报错，一条都不写。
// 写回（B7a 评审第 2 条）：直连数据库（负责人本机输入连接串，postgres 角色），整个恢复在**一个事务**里，按清单顺序（父表在前）
//   insert … select … from jsonb_populate_recordset(null::<表>, $1::text::jsonb) on conflict (<清单里的主键>) do update；只写备份里有的列，生成列不写。
//   中途任何一步出错整体回退，库里一条都不变。为什么不走 PostgREST：隐私记四张表 service_role 没有表级权限（负责人 11-26：不放宽），
//   PostgREST 写不进去；直连用 postgres 角色、不改任何授权，又能一个事务做完（原来一批一批写，中途失败会留半截）。
//   只增改、不删：库里有、备份里没有的行不动，只在报告里列条数（备份时间之后新记的内容，删不删由负责人另定）。
//   例外：主键以外还有唯一索引的三张表（AI 记忆同一句话、同名分类、同一个设置 key），库里占位的行先软删或删掉、指着它的引用改指过去，
//   备份占先（SECOND_UNIQUE，B7a 遗留第 3 条）。
// 默认不恢复的表（DEFAULT_SKIP）：凭据类 api_tokens、devices、device_secrets、vault_credentials、admins（B7a 评审第 12 条：恢复旧的连接码、设备、
//   通行密钥、管理员身份会让已吊销的东西复活），加上 vault、invites（B7a 复审第 2 条：会把换过的 PIN、用完的邀请码退回旧值），
//   必须用 --only 点名才写；报告里列出跳过了哪几张。
// 安全和同意状态一律保留库里现值（KEEP_LIVE，B7a 复审第 2 条）：库里已有这一行时，下面这些列不拿备份覆盖——
//   profiles 的停用两列和 AI 同意记录；vault 的失败次数、锁定状态，pin_epoch 取两边较大的再加 1（旧的隐私记令牌全部失效）；
//   invites、user_limits 整行不覆盖（库里没有的才写）；settings 里 ai.* 的行一律不写（AI 开关、隐私记 AI 开关只认库里现在的）。
// 报错分开（B7a 复审第 9 条）：连不上库或密码错（db_connect，一条没写）、写库出错（db_write，整体回退）、
//   提交那一步出错（commit_unknown，库里是前是后不确定，先 --dry-run 核对）。
// 试运行另外预先算上限触发器（B7a 复审第 11 条）：row_quota（每表 2 万行，postgres 直连豁免时不算）、todo_items_cap（每条待办 30 个子项），
//   加上备份的行会超的写进报告的 warnings。
// 目标项目：清单里的 project（备份出自哪个项目）必须和目标一致；本机（127.0.0.1 / localhost）不限（0.29 续第 95 条②：
//   正式备份不写进预览项目，演练在本机或用预览自己的备份）。目标从连接串的主机名认：db.<ref>.supabase.co，
//   或连接池 *.pooler.supabase.com 的用户名 postgres.<ref>。
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const MANIFEST_FILE = '_manifest.json.gz';
export const MANIFEST_FORMAT = 'lemomemo-backup-manifest';
export const FILE_FORMAT = 'lemomemo-backup';
/** 数据文件名：<代 a|b>_<表>[.<片号>].json.gz（和 supabase/functions/_shared/backup-format.ts 的 DATA_FILE_RE 同一条，tests/build/backup-format-sync.test.ts 核对） */
export const DATA_FILE_RE = /^[ab]_[a-z_]+(\.[1-9][0-9]{0,3})?\.json\.gz$/;
/** 默认不恢复的表（--only 点名才写）：凭据类五张，加上 PIN 状态 vault、邀请码 invites */
export const DEFAULT_SKIP = Object.freeze(['api_tokens', 'devices', 'device_secrets', 'vault_credentials', 'admins', 'vault', 'invites']);
/**
 * 库里已有这一行时保留库里现值的列（B7a 复审第 2 条）：cols 不覆盖；bump 这一列取两边较大的再加 1（插入时也加 1）；
 * all 整行不覆盖（on conflict do nothing）；skipKeyPrefix：这张表 key 以它开头的备份行一律不写
 */
export const KEEP_LIVE = Object.freeze({
  profiles: Object.freeze({ cols: Object.freeze(['disabled_at', 'disabled_reason', 'consent_ai_at', 'consent_policy_ver']), label: '停用状态和 AI 同意记录' }),
  vault: Object.freeze({ cols: Object.freeze(['fail_count', 'lock_level', 'locked_until']), bump: 'pin_epoch', label: 'PIN 失败次数和锁定状态（pin_epoch 取较大的再加 1，旧令牌全部失效）' }),
  invites: Object.freeze({ all: true, label: '已有的邀请码（已用次数、有效期）' }),
  user_limits: Object.freeze({ all: true, label: '用量上限' }),
  settings: Object.freeze({ skipKeyPrefix: 'ai.', label: 'AI 开关（ai.* 的设置）' }),
});
/** row_quota 的上限（0001_core.sql：每人每张表 2 万行） */
export const ROW_QUOTA = 20_000;
/** todo_items_cap 的上限（20261113170000：每条待办看得见的子项 30 个） */
export const TODO_ITEMS_CAP = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z_]+$/;
const REF = /^[a-z0-9]{20}$/;
/**
 * 主键以外还有唯一索引的表（B7a 遗留第 3 条、负责人 11-26 定的追加）：备份里的一行，库里可能已有另一条（主键不同）占着同一个值——
 * 备份之后用户删了那条又建了同样的（同一句记忆、同名分类），或换了设备、同一个设置 key 新建了一行。照主键 upsert 会撞这个索引，
 * 整个恢复回退（本机 lemo-e2e 实测 23505 ai_memories_user_norm、categories_user_vault_name_key、settings_user_id_key_key）。
 * 恢复时**备份占先**：同一个事务里，写这张表之前先把库里占位的行处理掉，写完再把指着它们的引用改指过去：
 *   • cols：唯一索引里除 user_id 以外的列（lower: true 是索引里写的 lower(列)），按它们找“值相同、主键不同”的行；
 *   • partial：唯一索引带 where <列> is null（只管没删的行）就写那一列，只看两边没删的行；约束不分删没删（settings）写 null，两边所有行都看；
 *   • resolve：retire 软删（partial 那一列写当前毫秒，和 App 删除一样；被软删的那条若也在备份里，紧接着就按备份写回原样）；
 *     delete 真删（settings 的约束连软删的行也算，软删腾不出位置；删除触发器照常写墓碑，客户端同步时删掉旧行、拿到备份那行）；
 *   • refs：占位的那条不在备份里时，别的行指着它的 id 要改指到备份里同一个值的那条，引用一个不断：
 *     column 是“同一个人某张表的某一列存着这个 id”，pairs 是 settings 里这几个 key 的值存着 [id, id] 数组。
 *     tests/build/backup-restore.test.ts 从迁移里找出所有引用 categories 的外键和同名列、从 shared 取合并建议的两个 key，核对这里一个不漏。
 * 试运行只数不改：报告里 retire 是要处理的占位行数，repoint 是要改指的引用行数。这几张表的 key 都是一列 id。
 */
export const SECOND_UNIQUE = Object.freeze({
  ai_memories: Object.freeze({ index: 'ai_memories_user_norm', cols: Object.freeze([{ col: 'norm' }]), partial: 'deleted_at', resolve: 'retire', refs: Object.freeze([]), label: '同一句话' }),
  settings: Object.freeze({ index: 'settings_user_id_key_key', cols: Object.freeze([{ col: 'key' }]), partial: null, resolve: 'delete', refs: Object.freeze([]), label: '同一个设置 key' }),
  categories: Object.freeze({
    index: 'categories_user_vault_name_key', cols: Object.freeze([{ col: 'vault' }, { col: 'name', lower: true }]), partial: 'deleted_at', resolve: 'retire', label: '同名分类',
    refs: Object.freeze([
      Object.freeze({ kind: 'column', schema: 'public', table: 'notes', col: 'category_id' }),        // 外键 notes_category_id_user_id_fkey
      Object.freeze({ kind: 'column', schema: 'public', table: 'categories', col: 'merged_into' }),   // 合并进了哪个分类（没有外键）
      Object.freeze({ kind: 'pairs', schema: 'public', table: 'settings', keys: Object.freeze(['notes.merge_suggest', 'notes.merge_dismissed']) }),   // shared/logic/notes/category-merge.ts
    ]),
  }),
});
/** 一次 insert 最多几行（一条语句的参数是一个 jsonb，太大了占内存） */
export const BATCH_ROWS = 500;

export class RestoreError extends Error {
  /** @param {string} code @param {string} zh */
  constructor(code, zh) {
    super(zh);
    this.code = code;
  }
}

/**
 * 参数：--user <uuid> --from <目录> [--dry-run] [--confirm <ref 或 local>] [--only 表,表]
 * 连接串不进命令行参数（会留在历史里），由 restore.mjs 从环境变量或隐藏输入拿。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { user: '', from: '', dryRun: false, confirm: '', only: /** @type {string[] | null} */ (null) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (v === undefined) throw new RestoreError('bad_args', `参数 ${a} 后面缺值`);
    if (a === '--user') out.user = v;
    else if (a === '--from') out.from = v;
    else if (a === '--confirm') out.confirm = v;
    else if (a === '--only') out.only = v.split(',').filter(Boolean);
    else if (a === '--url') throw new RestoreError('bad_args', '--url 不用了：恢复改成直连数据库，按提示粘贴连接串（见手册第 3 层第 5 步）');
    else throw new RestoreError('bad_args', `不认识的参数 ${a}`);
    i++;
  }
  if (!UUID.test(out.user)) throw new RestoreError('bad_args', '--user 要写这个人的 user_id（小写 uuid）');
  if (!out.from) throw new RestoreError('bad_args', '--from 要写备份目录（里面有 _manifest.json.gz）');
  if (out.only && (out.only.length === 0 || !out.only.every((t) => NAME.test(t)))) throw new RestoreError('bad_args', '--only 的表名不对');
  return out;
}

/**
 * 连接串 → 目标：远端项目的 ref，或 'local'；认不出的返回 null。
 * 只认 postgres:// 或 postgresql://；远端只认 db.<ref>.supabase.co 和 *.pooler.supabase.com（用户名 postgres.<ref>）。
 * @param {string} dbUrl
 */
export function targetOfDbUrl(dbUrl) {
  let u;
  try { u = new URL(dbUrl); } catch { return null; }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
  const host = u.hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost') return 'local';
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host);
  if (direct) return direct[1];
  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
    const m = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(u.username));
    return m && REF.test(m[1]) ? m[1] : null;
  }
  return null;
}

/**
 * 环境变量 LEMO_RESTORE_DB_URL：只在指向本机时才认（B7a 复审第 10 条，免得测试时设的变量把正式库当成目标）。
 * 没设回 ''（restore.mjs 改为提示粘贴）；设了却不是本机就报错
 * @param {string | undefined} v
 */
export function dbUrlFromEnv(v) {
  if (!v) return '';
  if (targetOfDbUrl(v) !== 'local') throw new RestoreError('bad_args', 'LEMO_RESTORE_DB_URL 只给本机测试用（只认 127.0.0.1、localhost）；正式、预览不要设它，按提示粘贴连接串');
  return v;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * 读清单、按清单读全部文件并逐项核对。readFile(name) 返回 Buffer（找不到抛错）。
 * @returns {{ manifest: object, tables: { name: string, schema: string, key: string[], lookup: string, rows: object[] }[] }}
 */
export function loadBackup(readFile, userId) {
  let manifest;
  try {
    manifest = JSON.parse(gunzipSync(readFile(MANIFEST_FILE)).toString('utf8'));
  } catch {
    throw new RestoreError('no_manifest', '目录里没有可读的 _manifest.json.gz：这一天这个人的备份没做完，换一天的');
  }
  if (manifest?.format !== MANIFEST_FORMAT || manifest.version !== 1) throw new RestoreError('bad_manifest', '_manifest 格式不对');
  if (manifest.user_id !== userId) throw new RestoreError('wrong_user', '_manifest 里的 user_id 和 --user 不一致');
  if (manifest.gen !== 'a' && manifest.gen !== 'b') throw new RestoreError('bad_manifest', '_manifest 没写这一次的数据文件是哪一代（gen）');
  if (!Array.isArray(manifest.tables)) throw new RestoreError('bad_manifest', '_manifest 没有 tables');
  const tables = [];
  for (const t of manifest.tables) {
    const ok = t && NAME.test(t.name) && (t.schema === 'public' || t.schema === 'private') && NAME.test(t.lookup ?? '')
      && Array.isArray(t.key) && t.key.length > 0 && t.key.every((k) => NAME.test(k)) && Number.isSafeInteger(t.rows) && Array.isArray(t.files);
    if (!ok) throw new RestoreError('bad_manifest', `_manifest 里 ${String(t?.name)} 这一项不对`);
    const stem = `${manifest.gen}_${t.name}`;
    const rows = [];
    for (const f of t.files) {
      if (!DATA_FILE_RE.test(f?.name ?? '') || !(f.name === `${stem}.json.gz` || f.name.startsWith(`${stem}.`))) throw new RestoreError('bad_manifest', `${t.name} 的文件名不对`);
      let buf;
      try { buf = readFile(f.name); } catch { throw new RestoreError('missing_file', `缺文件 ${f.name}`); }
      if (buf.byteLength !== f.bytes || sha256(buf) !== f.sha256) throw new RestoreError('checksum', `${f.name} 的大小或 sha256 和 _manifest 对不上（文件坏了或不是同一次备份）`);
      let doc;
      try { doc = JSON.parse(gunzipSync(buf).toString('utf8')); } catch { throw new RestoreError('bad_file', `${f.name} 解不开`); }
      if (doc?.format !== FILE_FORMAT || doc.version !== 1 || doc.table !== t.name || !Array.isArray(doc.rows)) throw new RestoreError('bad_file', `${f.name} 的格式或表名不对`);
      for (const r of doc.rows) {
        if (typeof r !== 'object' || r === null || Array.isArray(r) || r[t.lookup] !== userId) throw new RestoreError('foreign_row', `${f.name} 里有不是这个人的行`);
        if (t.key.some((k) => r[k] === undefined || r[k] === null)) throw new RestoreError('bad_file', `${f.name} 里有缺主键的行`);
      }
      rows.push(...doc.rows);
    }
    if (rows.length !== t.rows) throw new RestoreError('row_count', `${t.name} 拼回来 ${rows.length} 行，_manifest 写的是 ${t.rows} 行`);
    tables.push({ name: t.name, schema: t.schema, key: [...t.key], lookup: t.lookup, rows });
  }
  return { manifest, tables };
}

/** 主键值拼成一个字符串比较（库里一律按 ::text 读回，备份里 uuid、text 本来就是字符串） */
const keyOf = (row, cols) => JSON.stringify(cols.map((c) => String(row[c])));
/** 标识符加双引号（名字都已过 NAME：只有小写字母和下划线） */
const q = (name) => {
  if (!NAME.test(name)) throw new RestoreError('bad_manifest', `名字不对：${name}`);
  return `"${name}"`;
};

/** 引用都按 user_id 限在这个人自己的行里（SECOND_UNIQUE 的 refs 三张表都是） */
const REF_LOOKUP = 'user_id';
const keepOf = (name) => (Object.hasOwn(KEEP_LIVE, name) ? KEEP_LIVE[name] : undefined);

/**
 * 备份里要和库比唯一值的行（partial 的只要没删的）：只留 id 和唯一值列，都转成字符串（和库里 ::text 比）
 * @param {{ name: string, key: string[], rows: object[] }} t
 * @param {typeof SECOND_UNIQUE[keyof typeof SECOND_UNIQUE]} spec
 */
export function uniqueRowsOf(t, spec) {
  if (t.key.length !== 1) throw new RestoreError('bad_manifest', `${t.name} 有主键以外的唯一索引，主键只能是一列`);
  const cols = [t.key[0], ...spec.cols.map((c) => c.col)];
  return t.rows.filter((r) => spec.partial === null || r[spec.partial] === null || r[spec.partial] === undefined)
    .map((r) => Object.fromEntries(cols.map((c) => [c, String(r[c])])));
}
/** 库里这个人（$1）占着 $2 里某条备份行的唯一值、主键又不同的行，回 old（占位那条的 id）、new（备份那条的 id）。列名都过 NAME，jsonb 键名直接写进语句 */
function conflictSql(t, spec) {
  const k = t.key[0];
  const side = (c, s) => (c.lower ? `lower(${s})` : s);
  const same = spec.cols.map((c) => `${side(c, `m.${q(c.col)}::text`)} = ${side(c, `(x->>'${c.col}')`)}`).join(' and ');
  return `select m.${q(k)}::text as old, x->>'${k}' as new
      from ${q(t.schema)}.${q(t.name)} as m join jsonb_array_elements($2::text::jsonb) x on ${same}
     where m.${q(t.lookup)} = $1::uuid${spec.partial === null ? '' : ` and m.${q(spec.partial)} is null`} and m.${q(k)}::text <> x->>'${k}'`;
}
/** settings 里存 [id, id] 数组的那几个 key（$3），值里出现了 $2 里某个 old 的行 */
function pairsCond() {
  return `s.${q(REF_LOOKUP)} = $1::uuid and s."key" in (select jsonb_array_elements_text($3::text::jsonb)) and jsonb_typeof(s."value") = 'array'
     and exists (select 1 from jsonb_array_elements(s."value") p(v), jsonb_array_elements(case when jsonb_typeof(p.v) = 'array' then p.v else '[]'::jsonb end) e(v),
                 jsonb_to_recordset($2::text::jsonb) as mp(old text, new text) where e.v #>> '{}' = mp.old)`;
}

/**
 * 包一个 postgres.js 连接（restore.mjs 建）：transaction(fn) 在 sql.begin 里跑，fn 抛错整体回退。
 * 不打印连接串；语句里的值都走参数（$1），表名、列名先过 NAME 再加引号。
 * @param {{ begin: (fn: (tx: any) => Promise<unknown>) => Promise<unknown> }} sql
 */
export function sqlClient(sql) {
  const ops = (tx) => ({
    /** 库里这个人这张表现有的主键 */
    async keys(t, userId) {
      const cols = t.key.map((k) => `${q(k)}::text as ${q(k)}`).join(', ');
      // 找人的列都是 uuid（user_id、invites 的 created_by）：参数转成 uuid 再比，用得上这一列的索引（B7a 复审第 12 条；原来写 列::text = $1 走不了索引）
      const rows = await tx.unsafe(`select ${cols} from ${q(t.schema)}.${q(t.name)} where ${q(t.lookup)} = $1::uuid`, [userId]);
      return new Set(rows.map((r) => keyOf(r, t.key)));
    },
    /** 这张表能写的列（不含生成列、已删的列）和要不要 overriding system value */
    async columns(t) {
      const rows = await tx.unsafe(
        `select a.attname as name, a.attidentity as ident from pg_attribute a
          where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
        [`${t.schema}.${t.name}`]);
      if (rows.length === 0) throw new RestoreError('db_read', `库里没有 ${t.schema}.${t.name} 这张表`);
      return { cols: rows.map((r) => r.name), identityAlways: rows.some((r) => r.ident === 'a') };
    },
    /** SECOND_UNIQUE：库里占位的行（old）和备份里同一个值的那条（new）；rows 是 uniqueRowsOf 的结果 */
    async conflicts(t, spec, userId, rows) {
      const got = await tx.unsafe(conflictSql(t, spec), [userId, JSON.stringify(rows)]);
      return got.map((r) => ({ old: String(r.old), new: String(r.new) }));
    },
    /** 处理占位的行：retire 软删（partial 列写当前毫秒）、delete 真删；ids 是 old 的列表，回处理了几条 */
    async resolve(t, spec, userId, ids) {
      const rel = `${q(t.schema)}.${q(t.name)}`;
      const where = `${q(t.lookup)} = $1::uuid and ${q(t.key[0])}::text in (select jsonb_array_elements_text($2::text::jsonb))`;
      const text = spec.resolve === 'delete'
        ? `delete from ${rel} where ${where} returning 1`
        : `update ${rel} set ${q(spec.partial)} = (extract(epoch from clock_timestamp()) * 1000)::bigint where ${where} and ${q(spec.partial)} is null returning 1`;
      return (await tx.unsafe(text, [userId, JSON.stringify(ids)])).length;
    },
    /** 引用占位行 id 的行有几条（试运行报告用）；map 是 [{old, new}] */
    async refCount(ref, userId, map) {
      const rel = `${q(ref.schema)}.${q(ref.table)}`;
      const rows = ref.kind === 'pairs'
        ? await tx.unsafe(`select count(*)::int as n from ${rel} s where ${pairsCond()}`, [userId, JSON.stringify(map), JSON.stringify(ref.keys)])
        : await tx.unsafe(`select count(*)::int as n from ${rel} r where r.${q(REF_LOOKUP)} = $1::uuid
            and r.${q(ref.col)} in (select old::uuid from jsonb_to_recordset($2::text::jsonb) as mp(old text, new text))`, [userId, JSON.stringify(map)]);
      return Number(rows[0]?.n ?? 0);
    },
    /** 把引用从 old 改指到 new（引用列都是 uuid；pairs 按原来的顺序逐项换），回改了几行 */
    async repoint(ref, userId, map) {
      const rel = `${q(ref.schema)}.${q(ref.table)}`;
      if (ref.kind === 'pairs') {
        const swap = `(select coalesce(jsonb_agg(case when jsonb_typeof(p.v) <> 'array' then p.v else
              (select coalesce(jsonb_agg(coalesce((select to_jsonb(mp.new) from jsonb_to_recordset($2::text::jsonb) as mp(old text, new text) where mp.old = e.v #>> '{}'), e.v) order by e.i), '[]'::jsonb)
                 from jsonb_array_elements(p.v) with ordinality as e(v, i)) end order by p.i), '[]'::jsonb)
             from jsonb_array_elements(s."value") with ordinality as p(v, i))`;
        return (await tx.unsafe(`update ${rel} s set "value" = ${swap} where ${pairsCond()} returning 1`, [userId, JSON.stringify(map), JSON.stringify(ref.keys)])).length;
      }
      return (await tx.unsafe(`update ${rel} r set ${q(ref.col)} = mp.new::uuid from jsonb_to_recordset($2::text::jsonb) as mp(old text, new text)
          where r.${q(REF_LOOKUP)} = $1::uuid and r.${q(ref.col)} = mp.old::uuid returning 1`, [userId, JSON.stringify(map)])).length;
    },
    async upsert(t, cols, identityAlways, rows) {
      const list = cols.map(q).join(', ');
      const keep = keepOf(t.name);
      // KEEP_LIVE：保留库里现值的列不进 update set；bump 列插入时加 1、冲突时取 max(库里 + 1, 备份 + 1)；all 整行不覆盖
      const pick = cols.map((c) => (c === keep?.bump ? `r.${q(c)} + 1` : `r.${q(c)}`)).join(', ');
      const upd = keep?.all ? [] : cols.filter((c) => !t.key.includes(c) && !(keep?.cols ?? []).includes(c))
        .map((c) => (c === keep?.bump ? `${q(c)} = greatest(t.${q(c)} + 1, excluded.${q(c)})` : `${q(c)} = excluded.${q(c)}`));
      const rel = `${q(t.schema)}.${q(t.name)}`;
      // 参数按 text 传、库里再转 jsonb：写成 $1::jsonb 时 postgres.js 认出参数是 jsonb，会把已经 JSON.stringify 过的字符串再包一层引号，
      // 库收到的是一个 JSON 字符串而不是数组（本机 lemo-e2e 实测 22023 cannot call jsonb_populate_recordset on a non-array，每张表都一样）
      await tx.unsafe(
        `insert into ${rel} as t (${list})${identityAlways ? ' overriding system value' : ''}
           select ${pick} from jsonb_populate_recordset(null::${rel}, $1::text::jsonb) as r
           on conflict (${t.key.map(q).join(', ')}) do ${upd.length ? `update set ${upd.join(', ')}` : 'nothing'}`,
        [JSON.stringify(rows)]);
    },
    /** 上限触发器的前提（B7a 复审第 11 条）：这个连接豁不豁免 row_quota（postgres 直连、没切角色时豁免），哪些表挂了 row_quota */
    async quotaContext() {
      const [who] = await tx.unsafe(`select session_user in ('postgres', 'supabase_admin') and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none' as exempt`, []);
      const tables = await tx.unsafe(`select distinct c.relname as name from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
          join pg_proc p on p.oid = g.tgfoid where n.nspname = 'public' and p.proname = 'row_quota' and not g.tgisinternal`, []);
      return { exempt: who?.exempt === true, rowQuota: tables.map((r) => String(r.name)) };
    },
    /** 这个人库里的待办子项：id、属于哪条待办、看不看得见（没删、没撤销）——todo_items_cap 数的就是看得见的 */
    async todoItems(userId) {
      const rows = await tx.unsafe(`select "id"::text as id, "todo_id"::text as todo_id, ("deleted_at" is null and not "undone") as visible
          from "public"."todo_items" where "user_id" = $1::uuid`, [userId]);
      return rows.map((r) => ({ id: String(r.id), todo_id: String(r.todo_id), visible: r.visible === true }));
    },
  });
  return {
    async transaction(fn) {
      return await sql.begin((tx) => fn(ops(tx)));
    },
  };
}

/** 按行数切批 */
export function batches(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH_ROWS) out.push(rows.slice(i, i + BATCH_ROWS));
  return out;
}

/** 试运行时回退事务用的记号（不当错误往外报） */
class DryRunDone extends Error {}

/**
 * 这张表在 SECOND_UNIQUE 里时：库里要处理的占位行（ids）和要改指的引用（map：只算不在备份里的占位行，在备份里的接着就按备份写回原样）
 * @returns {Promise<{ spec: typeof SECOND_UNIQUE[keyof typeof SECOND_UNIQUE], ids: string[], map: { old: string, new: string }[] } | null>}
 */
async function planOf(tx, t, userId) {
  const spec = Object.hasOwn(SECOND_UNIQUE, t.name) ? SECOND_UNIQUE[t.name] : undefined;
  if (!spec) return null;
  const rows = uniqueRowsOf(t, spec);
  const found = rows.length ? await tx.conflicts(t, spec, userId, rows) : [];
  const inBackup = new Set(t.rows.map((r) => String(r[t.key[0]])));
  const map = found.filter((c) => !inBackup.has(c.old));
  return { spec, ids: [...new Set(found.map((c) => c.old))], map };
}

/**
 * 核对目标、挑表（凭据类默认跳过）、算出每张表要新增、覆盖、库里多出来的条数；dryRun 为 false 时在同一个事务里按清单顺序写，
 * 写完再读一遍核对备份里的行都在，任何一步不对整体回退。试运行也在事务里读，最后回退（一条不写）。
 * SECOND_UNIQUE 里的表：写回前先处理库里占位的行（retire 是条数），写完把指着它们的引用改指过去（repoint 是行数）。
 * @param {{ backup: ReturnType<typeof loadBackup>, userId: string, target: string, client: { transaction: (fn: (tx: any) => Promise<unknown>) => Promise<unknown> },
 *   dryRun: boolean, only: string[] | null, say?: (s: string) => void }} args
 * KEEP_LIVE：保留库里现值的列不覆盖；settings 里 ai.* 的备份行不写（kept 是去掉的行数）。试运行另算上限触发器，超了写进 warnings。
 * @returns {Promise<{ report: { table: string, backup: number, current: number, insert: number, overwrite: number, extra: number, retire: number, repoint: number, kept: number }[],
 *   skipped: string[], warnings: string[] }>}
 */
export async function restore({ backup, userId, target, client, dryRun, only, say = () => {} }) {
  const project = backup.manifest.project ?? null;
  if (target !== 'local' && project !== target) {
    throw new RestoreError('wrong_project', `这份备份出自项目 ${project ?? '（没写）'}，目标是 ${target}：不同项目之间不恢复（0.29 续第 95 条②；演练用本机）`);
  }
  if (only && !only.every((n) => backup.tables.some((t) => t.name === n))) throw new RestoreError('bad_args', '--only 里有备份里没有的表');
  const picked = only ? backup.tables.filter((t) => only.includes(t.name)) : backup.tables.filter((t) => !DEFAULT_SKIP.includes(t.name));
  const skipped = only ? [] : backup.tables.filter((t) => DEFAULT_SKIP.includes(t.name)).map((t) => t.name);
  // settings 里 ai.* 的备份行一律不写（KEEP_LIVE.skipKeyPrefix）；后面的条数、占位、写回、核对都按去掉以后的行
  const tables = picked.map((t) => {
    const p = keepOf(t.name)?.skipKeyPrefix;
    const rows = p ? t.rows.filter((r) => !(typeof r.key === 'string' && r.key.startsWith(p))) : t.rows;
    return { ...t, rows, kept: t.rows.length - rows.length, backupRows: t.rows.length };
  });
  const report = [];
  const warnings = [];
  // 走到哪一步了：connect（还没连上）→ write（事务里）→ commit（fn 做完、等库提交）。报错按这个分（B7a 复审第 9 条）
  let phase = 'connect';
  try {
    await client.transaction(async (tx) => {
      phase = 'write';
      for (const t of tables) {
        const have = await tx.keys(t, userId);
        const mine = new Set(t.rows.map((r) => keyOf(r, t.key)));
        let overwrite = 0;
        for (const k of mine) if (have.has(k)) overwrite++;
        let extra = 0;
        for (const k of have) if (!mine.has(k)) extra++;
        const plan = await planOf(tx, t, userId);
        let repoint = 0;
        for (const ref of plan?.map.length ? plan.spec.refs : []) repoint += await tx.refCount(ref, userId, plan.map);
        report.push({ table: t.name, backup: t.backupRows, current: have.size, insert: mine.size - overwrite, overwrite, extra, retire: plan?.ids.length ?? 0, repoint, kept: t.kept });
      }
      if (dryRun) {
        warnings.push(...(await quotaWarnings(tx, tables, report, userId)));
        throw new DryRunDone();
      }
      for (const t of tables) {
        if (t.rows.length === 0) continue;
        const plan = await planOf(tx, t, userId);
        if (plan?.ids.length) {
          const n = await tx.resolve(t, plan.spec, userId, plan.ids);
          say(`  ${t.name}：库里有 ${n} 条和备份里的行是${plan.spec.label}、主键不同，先${plan.spec.resolve === 'delete' ? '删掉' : '软删'}（备份占先；事务还没提交）`);
        }
        const { cols: tableCols, identityAlways } = await tx.columns(t);
        const present = new Set(t.rows.flatMap((r) => Object.keys(r)));
        const cols = tableCols.filter((c) => present.has(c));
        if (!t.key.every((k) => cols.includes(k))) throw new RestoreError('bad_file', `${t.name} 的主键列在库里对不上`);
        const list = batches(t.rows);
        for (const [i, b] of list.entries()) {
          await tx.upsert(t, cols, identityAlways, b);
          say(`  ${t.name}：第 ${i + 1}/${list.length} 批（${b.length} 行）已写（事务还没提交）`);
        }
        const after = await tx.keys(t, userId);
        const missing = t.rows.filter((r) => !after.has(keyOf(r, t.key))).length;
        if (missing) throw new RestoreError('verify', `${t.name} 写完再读，备份里有 ${missing} 行库里还没有；整体回退，一条没写`);
        // 备份那条已写进去，再把指着占位那条的引用改指过去（外键要求新 id 先在）
        for (const ref of plan?.map.length ? plan.spec.refs : []) {
          const n = await tx.repoint(ref, userId, plan.map);
          say(`  ${t.name}：${ref.table}${ref.kind === 'pairs' ? ` 的 ${ref.keys.join('、')}` : `.${ref.col}`} 里指着被处理那条的 ${n} 行改指到备份里${plan.spec.label}的那条（事务还没提交）`);
        }
      }
      phase = 'commit';
    });
  } catch (e) {
    if (e instanceof DryRunDone) return { report, skipped, warnings };
    if (e instanceof RestoreError) throw e;
    // 库报的错（约束、类型）：原文可能带行内容，不往外打；只带 sqlstate 和约束名（名字是建表时起的，不含数据）
    const code = typeof e?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : '未知';
    if (phase === 'connect') {
      throw new RestoreError('db_connect', `连不上数据库或密码不对（${code}；看连接串里的主机、端口、密码），一条没写`);
    }
    if (phase === 'commit') {
      throw new RestoreError('commit_unknown', `提交那一步出错（${code}）：库里现在是恢复前还是恢复后不确定，先用同一份备份跑一次 --dry-run 核对条数，再决定要不要重跑`);
    }
    const constraint = typeof e?.constraint_name === 'string' && NAME.test(e.constraint_name) ? ` ${e.constraint_name}` : '';
    throw new RestoreError('db_write', `写库出错（${code}${constraint}），整个事务已回退，库里一条没变；改好后重跑本脚本`);
  }
  return { report, skipped, warnings };
}

/**
 * 试运行预先算上限触发器（B7a 复审第 11 条），超了的写成一句话：
 *   • row_quota（0001_core：插入前数这个人这张表的行，到 2 万就拒）：这个连接豁免（postgres 直连、没切角色）时不算；
 *   • todo_items_cap（每条待办看得见的子项 30 个，谁写都管）：库里的子项按 id 叠上备份的，数每条待办恢复后看得见的；
 *   • 媒体额度（media_quota_guard，和 row_quota 同样豁免）：不豁免又要插图片、附件时提醒一句（额度按字节算，这里不预估）。
 */
async function quotaWarnings(tx, tables, report, userId) {
  const out = [];
  const { exempt, rowQuota } = await tx.quotaContext();
  for (const r of report) {
    if (exempt || !rowQuota.includes(r.table)) continue;
    if (r.current + r.insert > ROW_QUOTA) out.push(`${r.table}：库里 ${r.current} 行加上备份新增的 ${r.insert} 行超过每人 ${ROW_QUOTA} 行（row_quota），正式执行会整体回退`);
  }
  if (!exempt && report.some((r) => (r.table === 'note_images' || r.table === 'note_files') && r.insert > 0)) {
    out.push('这个连接不豁免媒体额度（不是 postgres 直连）：新增的图片、附件行超出这个人的额度时正式执行会整体回退');
  }
  const items = tables.find((t) => t.name === 'todo_items');
  if (items && items.rows.length) {
    const vis = new Map((await tx.todoItems(userId)).map((x) => [x.id, x]));
    for (const r of items.rows) vis.set(String(r.id), { id: String(r.id), todo_id: String(r.todo_id), visible: (r.deleted_at === null || r.deleted_at === undefined) && r.undone !== true });
    const per = new Map();
    for (const x of vis.values()) if (x.visible) per.set(x.todo_id, (per.get(x.todo_id) ?? 0) + 1);
    const over = [...per.values()].filter((n) => n > TODO_ITEMS_CAP);
    if (over.length) out.push(`todo_items：恢复后有 ${over.length} 条待办看得见的子项超过 ${TODO_ITEMS_CAP} 个（最多的一条 ${Math.max(...over)} 个，todo_items_cap），正式执行会报 items_quota 整体回退`);
  }
  return out;
}
