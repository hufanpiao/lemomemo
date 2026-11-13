// vault 函数的总入口（架构 5.5、第 6 节 vault 行；B5 任务单 S2～S5、S8）：纯逻辑，依赖全由 index.ts 注入，Vitest 直接测。
// 顺序：方法 → 读请求体（≤ 128 KB）→ 鉴权（requireActiveUser）→ 每人每分钟 60 次（vault-min:<uid>:<UTC 分钟>）→ 解析 → 分发。
// • status、setup、unlock、reset、webauthn_options、unlock_webauthn 不要令牌，各自开事务（哪些要令牌只由下面两个 switch 定，不另列常量）；
//   status 不要钥匙（钥匙没配好时照常回），其余动作先判一次三把钥匙都在，经 Ctx.keys 往下传；
// • 其余一律验 x-vault-token（_shared/vault-token.ts 的 vaultTokenChecker：签名、user_id、过期、12 小时封顶，再比库里的 pin_epoch），在同一个 fn_vault 事务里验完就做；
//   change_pin、webauthn_register 要改 vault 行：验令牌时就 for update 读这一行、交给动作复用（整块评审第 13 条）；
//   import、export 要碰 R2，令牌单独开一个短事务验，搬家自己再开事务（move.ts）；
// • 成功一律续期：重签一张 10 分钟的令牌放进响应（change_pin 用加 1 以后的 pin_epoch），令牌里“最早解锁时刻”沿用验过的那张，
//   不要令牌的解锁类动作（setup、unlock、reset、unlock_webauthn）记成现在；离最早解锁满 12 小时就不再往后续（主持人代定，整块评审第 22 条）；
//   {renew} 什么都不做、只为续期（编辑久了、传图前）；响应一律 no-store；
// • 推送（锁定、改密码、重设、绑定）由各动作经 notifyLater 攒在 Ctx.pushes，要删的图片对象攒在 Ctx.drop（永久删除、删图，整块评审第 2 条），
//   处理函数正常返回（事务已提交）后才发推送、尽力删对象（删失败记 image_drop_failed，留给 storage-sweep），抛错就整批丢；
// • 出错：数据不合格 400 bad_request、超行数 413 too_large，钥匙或 R2 没配好、数据库和 R2 不通一律 503 try_later（只记错误码）。
// 不打印请求体、密码、令牌、明文；日志只经 deps.log（_shared/fn-log.ts）。
import { readJsonCapped } from '../_shared/body.ts';
import { json, NO_STORE } from '../_shared/http.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { VAULT_IMAGE_BUCKET } from '../_shared/vault-images.ts';
import { signVaultToken, VAULT_TOKEN_HEADER, vaultTokenChecker } from '../_shared/vault-token.ts';
import { type Base, classifyDbError, type Ctx, type Deps, err, fullKeys, type Out, out, StoreDataError, type VaultReq, type VaultRow, type VaultTx } from './common.ts';
import { exportNote, importNote } from './move.ts';
import { list, purge, remove, save, undelete } from './notes.ts';
import { changePin, reset, setup, status, unlock } from './pin.ts';
import { listCredentials, options, register, removeCredential, unlockWebauthn } from './webauthn.ts';

export const VAULT_MAX_BODY = 128 * 1024;
export const VAULT_RATE_PER_MIN = 60;

type Res = Out | Response;

/** 不要令牌的动作（status 另在 handle 里，不要钥匙） */
function openAction(c: Ctx, r: VaultReq): Promise<Res> | null {
  switch (r.action) {
    case 'setup': return setup(c, r);
    case 'unlock': return unlock(c, r);
    case 'reset': return reset(c, r);
    case 'webauthn_options': return options(c, r);
    case 'unlock_webauthn': return unlockWebauthn(c, r);
    default: return null;
  }
}

/** 验过的令牌：当前 pin_epoch、最早解锁时刻；row 是这次读到的 vault 行（lock 时是 for update 读的） */
interface Tok { epoch: number; firstAt: number; row: VaultRow }

/** 要改 vault 行的动作：验令牌时就加锁读（整块评审第 13 条） */
const LOCKS_VAULT: ReadonlySet<VaultReq['action']> = new Set(['change_pin', 'webauthn_register']);

/** 要令牌、在验令牌的同一个事务里做的动作 */
function tokenAction(c: Ctx, t: VaultTx, r: VaultReq, tok: Tok): Promise<Res> {
  switch (r.action) {
    case 'change_pin': return changePin(c, t, r, tok.row);
    case 'webauthn_register': return register(c, t, r, tok.row);
    case 'list_credentials': return listCredentials(t);
    case 'renew': return Promise.resolve(out({}, null));
    case 'remove_credential': return removeCredential(t, r);
    case 'list': return list(c, t);
    case 'save': return save(c, t, r);
    case 'delete': return remove(c, t, r);
    case 'undelete': return undelete(t, r);
    case 'purge': return purge(c, t, r);
    default: return Promise.resolve(err(400, 'bad_request'));
  }
}

/** 验令牌：过了回 Tok，没过回 401 */
async function checkToken(c: Ctx, t: VaultTx, lock: boolean): Promise<Tok | Response> {
  const got: { row: VaultRow | null } = { row: null };
  const check = vaultTokenChecker(c.keys.tokenSecret, c.deps.now, async () => {
    got.row = await t.vault(lock);
    return got.row?.pin_epoch ?? null;
  });
  const v = await check(c.userId, c.req.headers.get(VAULT_TOKEN_HEADER));
  if (v.verdict !== 'ok' || v.epoch === undefined || v.firstAt === undefined || !got.row) return err(401, v.verdict === 'ok' ? 'vault_locked' : v.verdict);
  return { epoch: v.epoch, firstAt: v.firstAt, row: got.row };
}

/** 要令牌的动作成功了：没给新 epoch 的沿用当前的，最早解锁时刻沿用令牌里的 */
const renewed = (res: Res, tok: Tok): Res => (res instanceof Response ? res : { ...res, epoch: res.epoch ?? tok.epoch, firstAt: tok.firstAt });

async function dispatch(c: Ctx, r: VaultReq): Promise<Res> {
  const opened = openAction(c, r);
  if (opened) return opened;
  if (r.action === 'import' || r.action === 'export') {
    const tok = await c.deps.tx(c.userId, (t) => checkToken(c, t, false));
    if (tok instanceof Response) return tok;
    return renewed(await (r.action === 'import' ? importNote(c, r, tok.epoch) : exportNote(c, r, tok.epoch)), tok);
  }
  return c.deps.tx(c.userId, async (t) => {
    const tok = await checkToken(c, t, LOCKS_VAULT.has(r.action));
    if (tok instanceof Response) return tok;
    return renewed(await tokenAction(c, t, r, tok), tok);
  });
}

const plain = (o: Out): Response => json(200, { ok: true, ...o.body }, NO_STORE);

async function respond(c: Ctx, o: Out): Promise<Response> {
  if (o.epoch === null) return plain(o);
  const now = c.deps.now();
  const { token, expiresAt } = await signVaultToken(c.keys.tokenSecret, c.userId, o.epoch, now, o.firstAt ?? now);
  return json(200, { ok: true, ...o.body, vault_token: token, expires_at: expiresAt }, NO_STORE);
}

function failure(deps: Deps, raw: unknown): Response {
  const e = classifyDbError(raw);
  if (e instanceof StoreDataError) return e.kind === 'quota' ? err(413, 'too_large') : err(400, 'bad_request');
  deps.log(e instanceof Error && e.message === 'misconfigured' ? 'misconfigured' : 'db_error');
  return err(503, 'try_later');
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const raw = await readJsonCapped(req, VAULT_MAX_BODY);
  if (raw === 'too_large') return err(413, 'too_large');
  try {
    const auth = await deps.authenticate(req);
    if (!auth.ok) return auth.response;
    const base: Base = { req, userId: auth.user.userId, jwt: auth.user.jwt, deps };
    if (!(await deps.takeRate(utcMinuteKey('vault-min', base.userId, deps.now()), VAULT_RATE_PER_MIN, 60))) return err(429, 'rate_limited');
    const r = deps.parse(raw);
    if (!r) return err(400, 'bad_request');
    if (r.action === 'status') return plain(await status(base));
    const keys = fullKeys(deps.keys);
    if (!keys) throw new Error('misconfigured');
    const c: Ctx = { ...base, keys, pushes: [], drop: [] };
    const res = await dispatch(c, r);
    // 走到这里各事务都已提交（pin_wrong、webauthn_failed 这类拒绝也是提交了的：失败次数、删掉的挑战要算数）
    for (const event of c.pushes) deps.background(deps.notify(c.userId, event).catch(() => deps.log(`push_failed:${event}`)));
    if (c.drop.length > 0) {
      const r2 = deps.r2;
      if (r2) deps.background(r2.deleteMany(VAULT_IMAGE_BUCKET, c.drop).catch(() => deps.log('image_drop_failed')));
      else deps.log('image_drop_failed');
    }
    return res instanceof Response ? res : await respond(c, res);
  } catch (e) {
    return failure(deps, e);
  }
}
