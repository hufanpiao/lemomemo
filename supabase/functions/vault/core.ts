// vault 函数的总入口（架构 5.5、第 6 节 vault 行；B5 任务单 S2～S5、S8）：纯逻辑，依赖全由 index.ts 注入，Vitest 直接测。
// 顺序：方法 → 读请求体（≤ 128 KB）→ 鉴权（requireActiveUser）→ 每人每分钟 60 次（vault-min:<uid>:<UTC 分钟>）→ 解析 → 分发。
// • VAULT_OPEN_ACTIONS（status、setup、unlock、reset、webauthn_options、unlock_webauthn）不要令牌，各自开事务；
// • 其余一律验 x-vault-token（_shared/vault-token.ts：签名、user_id、过期，再比库里的 pin_epoch），在同一个 fn_vault 事务里验完就做；
//   import、export 要碰 R2，令牌单独开一个短事务验，搬家自己再开事务（move.ts）；
// • 成功一律续期：重签一张 10 分钟的令牌放进响应（change_pin 用加 1 以后的 pin_epoch）；响应一律 no-store；
// • 出错：数据不合格 400 bad_request、超行数 413 too_large，钥匙或 R2 没配好、数据库和 R2 不通一律 503 try_later（只记错误码）。
// 不打印请求体、密码、令牌、明文；日志只经 deps.log（_shared/fn-log.ts）。
import { readJsonCapped } from '../_shared/body.ts';
import { json, NO_STORE } from '../_shared/http.ts';
import { signVaultToken, verifyVaultToken } from '../_shared/vault-token.ts';
import { classifyDbError, type Ctx, type Deps, err, keysOf, minuteKey, type Out, StoreDataError, type VaultReq, type VaultTx } from './common.ts';
import { exportNote, importNote } from './move.ts';
import { list, purge, remove, save, undelete } from './notes.ts';
import { changePin, reset, setup, status, unlock } from './pin.ts';
import { listCredentials, options, register, removeCredential, unlockWebauthn } from './webauthn.ts';

export const VAULT_MAX_BODY = 128 * 1024;
export const VAULT_RATE_PER_MIN = 60;
export const TOKEN_HEADER = 'x-vault-token';

type Res = Out | Response;

/** 不要令牌的动作 */
function openAction(c: Ctx, r: VaultReq): Promise<Res> | null {
  switch (r.action) {
    case 'status': return status(c);
    case 'setup': return setup(c, r);
    case 'unlock': return unlock(c, r);
    case 'reset': return reset(c, r);
    case 'webauthn_options': return options(c, r);
    case 'unlock_webauthn': return unlockWebauthn(c, r);
    default: return null;
  }
}

/** 要令牌、在验令牌的同一个事务里做的动作 */
function tokenAction(c: Ctx, t: VaultTx, r: VaultReq): Promise<Res> {
  switch (r.action) {
    case 'change_pin': return changePin(c, t, r);
    case 'webauthn_register': return register(c, t, r);
    case 'list_credentials': return listCredentials(t);
    case 'remove_credential': return removeCredential(t, r);
    case 'list': return list(c, t);
    case 'save': return save(c, t, r);
    case 'delete': return remove(c, t, r);
    case 'undelete': return undelete(t, r);
    case 'purge': return purge(t, r);
    default: return Promise.resolve(err(400, 'bad_request'));
  }
}

/** 验令牌：过了回当前 pin_epoch，没过回 401 */
async function checkToken(c: Ctx, t: VaultTx, secret: Uint8Array<ArrayBuffer>): Promise<number | Response> {
  const v = await verifyVaultToken(secret, c.userId, c.req.headers.get(TOKEN_HEADER), c.deps.now(), async () => (await t.vault(false))?.pin_epoch ?? null);
  return v.verdict === 'ok' && v.epoch !== undefined ? v.epoch : err(401, v.verdict === 'ok' ? 'vault_locked' : v.verdict);
}

async function dispatch(c: Ctx, r: VaultReq): Promise<Res> {
  const opened = openAction(c, r);
  if (opened) return opened;
  const k = keysOf(c);
  if (!k) throw new Error('misconfigured');
  if (r.action === 'import' || r.action === 'export') {
    const epoch = await c.deps.tx(c.userId, (t) => checkToken(c, t, k.tokenSecret));
    if (epoch instanceof Response) return epoch;
    return r.action === 'import' ? importNote(c, r, epoch) : exportNote(c, r, epoch);
  }
  return c.deps.tx(c.userId, async (t) => {
    const epoch = await checkToken(c, t, k.tokenSecret);
    if (epoch instanceof Response) return epoch;
    const res = await tokenAction(c, t, r);
    return res instanceof Response ? res : { body: res.body, epoch: res.epoch ?? epoch };
  });
}

async function respond(c: Ctx, o: Out): Promise<Response> {
  if (o.epoch === null) return json(200, { ok: true, ...o.body }, NO_STORE);
  const k = keysOf(c);
  if (!k) throw new Error('misconfigured');
  const { token, expiresAt } = await signVaultToken(k.tokenSecret, c.userId, o.epoch, c.deps.now());
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
    const c: Ctx = { req, userId: auth.user.userId, jwt: auth.user.jwt, deps };
    if (!(await deps.takeRate(minuteKey('vault-min', c.userId, deps.now()), VAULT_RATE_PER_MIN, 60))) return err(429, 'rate_limited');
    const r = deps.parse(raw);
    if (!r) return err(400, 'bad_request');
    if (r.action !== 'status' && !keysOf(c)) throw new Error('misconfigured');
    const res = await dispatch(c, r);
    return res instanceof Response ? res : await respond(c, res);
  } catch (e) {
    return failure(deps, e);
  }
}
