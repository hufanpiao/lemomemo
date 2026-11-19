// 隐私记解锁后的首页（负责人 11-19“隐私记这个页面太空了”“解锁后用乙”；方案 柠檬记APP-本机资料/设计方案/2026-11-19_隐私记改善/方案.html 乙）：
// • 分类两列宫格：每格分类色小方块、名字、“N 条 · 最近一条的日期”；点一格进 #/vault/c/<分类 id> 的列表（随手记那一份列表，一开始筛这一类）
// • 宫格下面“最近”一行，右边“全部 N ›”进 #/vault/c/all；再下面最新记的 3 条（按记下的时间，不按排序方式），点开进编辑页
// • 一条都没有：只写一句来源给的空态（同列表那一句；底部输入行、“＋”照旧）
// • 只在手机排法里画（随手记列表的 home 参数）；电脑版左栏本来就是分类，照旧
// • 宫格最后一格“＋ 新分类”（负责人 11-19 选“做‘＋ 新分类’”；方案乙虚线格）：点了弹窗起名字（最多 12 个字），建好进这一类的列表 #/vault/c/<id>
//   （空的也留着这一类，底部输入行记的进这一类）；同名的不再建、直接进那一类。分类随手记、隐私记共用（notes 的 data/category-new.ts）
//   一条记录都没有时照旧只写空态，不出宫格
// • 格里的小图标（负责人 11-19 选“按分类名配图标”）：只用方案乙里的三个——健康 ♥、证件 ▤、账号 ✱，按名字里的词配；对不上的只画色块
// 运行日志：vault home pick=<all|cat>（只记点了哪一种，不记分类名）
import { useEffect, useState, type CSSProperties } from 'react';
import { navigate } from '../../../app/router.ts';
import { Dialog, DialogClose } from '../../../kit/components/Dialog.tsx';
import dialog from '../../../kit/components/Dialog.module.css';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import type { NoteItem, NotesHomeApi } from '../../notes/index.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { tileGlyph } from '../hooks/tile-glyph-data.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import styles from './Vault.module.css';

/** 每个分类最新一条（按记下的时间） */
function latestByCat(items: readonly NoteItem[]): Map<string, NoteItem> {
  const m = new Map<string, NoteItem>();
  for (const it of items) {
    if (it.categoryId === null) continue;
    const had = m.get(it.categoryId);
    if (!had || it.createdAt > had.createdAt) m.set(it.categoryId, it);
  }
  return m;
}

export function VaultHome({ api }: { api: NotesHomeApi }) {
  const t = useVaultT();
  const [ask, setAsk] = useState(false);
  const latest = latestByCat(api.items);
  const recent = [...api.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  const pick = (cid: string | null): void => {
    rlog(`vault home pick=${cid === null ? 'all' : 'cat'}`);
    void navigate('vault', 'c', cid ?? 'all');
  };
  // 新分类建好要进的那一类：等起名弹窗关掉、它的层退掉（页面不再锁滚动）以后再换页。
  // 锁着滚动直接换页，文档在整页过渡里从“不能滚”变成“能滚”，webkit 整页崩（同 kit/hooks/layers.ts keepScroll 那条，11-19 e2e 复现）
  const [go, setGo] = useState<string | null>(null);
  useEffect(() => {
    if (ask || go === null) return;
    setGo(null);
    rlog('vault home pick=cat');
    void navigate('vault', 'c', go);
  }, [ask, go]);
  if (api.total === 0) {
    return (
      <p className={styles.empty} data-testid="vault-home-empty">
        {api.empty}
      </p>
    );
  }
  return (
    <div className={styles.home} data-testid="vault-home">
        <ul className={styles.grid} aria-label={t('vault.home.cats', {})}>
          {api.counts.map((c) => {
            const last = latest.get(c.id);
            const sub = last ? t('vault.home.tile', { n: c.count, day: api.day(last) }) : t('vault.home.tileNoDay', { n: c.count });
            return (
              <li key={c.id}>
                <button type="button" className={styles.tile} onClick={() => pick(c.id)} aria-label={t('vault.home.tileLabel', { name: c.name, sub })} data-testid={`vault-home-cat-${c.id}`}>
                  <span className={styles.tileDot} style={c.color ? ({ '--dot': c.color } as CSSProperties) : undefined} aria-hidden="true">
                    {tileGlyph(c.name)}
                  </span>
                  <span className={styles.tileName}>{c.name}</span>
                  <span className={styles.tileSub}>
                    <NumIn text={sub} num={String(c.count)} />
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button type="button" className={`${styles.tile} ${styles.tileAdd}`} onClick={() => setAsk(true)} data-testid="vault-home-newcat">
              {t('vault.home.newCat', {})}
            </button>
          </li>
        </ul>
      <NewCategory open={ask} onClose={() => setAsk(false)} create={api.newCategory} max={api.nameMax} onDone={setGo} />
      <div className={styles.homeRow}>
        <h2 className={styles.homeLabel}>{t('vault.home.recent', {})}</h2>
        <button type="button" className={styles.allLink} onClick={() => pick(null)} data-testid="vault-home-all">
          {t('vault.home.all', { n: api.total })}
          <span aria-hidden="true"> ›</span>
        </button>
      </div>
      <ul className={styles.recentList}>
        {recent.map((it) => (
          <li key={it.id}>
            <button type="button" className={styles.recent} onClick={() => api.open(it.id)} data-testid={`vault-home-note-${it.id}`}>
              <span className={styles.recentHead}>
                <span className={styles.recentTitle}>{it.title}</span>
                <span className={styles.recentDay}>{api.day(it)}</span>
                {api.mark(it)}
              </span>
              {it.summary ? <span className={styles.recentSum}>{it.summary}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** “＋ 新分类”的起名弹窗：名字去首尾空白、最多 12 个字；建好（或同名已有）回分类 id，没建上留在弹窗里写一句 */
function NewCategory({ open, onClose, create, max, onDone }: { open: boolean; onClose(): void; create: NotesHomeApi['newCategory']; max: number; onDone(id: string): void }) {
  const t = useVaultT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = (): void => {
    setName('');
    setFailed(false);
    onClose();
  };
  const ok = async (): Promise<void> => {
    if (busy || name.trim() === '') return;
    setBusy(true);
    const r = await create(name);
    setBusy(false);
    if (r.result !== 'ok') {
      setFailed(r.result !== 'empty' && r.result !== 'silent');
      return;
    }
    close();
    onDone(r.id);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())} title={t('vault.newCat.title', {})}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ok();
        }}
      >
        <input
          className={form.input}
          value={name}
          maxLength={max}
          onChange={(e) => {
            setName(e.target.value);
            setFailed(false);
          }}
          placeholder={t('vault.newCat.placeholder', { n: max })}
          aria-label={t('vault.newCat.title', {})}
          enterKeyHint="done"
          data-testid="vault-newcat-name"
        />
        {failed ? (
          <p className={styles.notice} role="alert" data-testid="vault-newcat-fail">
            {t('vault.newCat.fail', {})}
          </p>
        ) : null}
        <div className={dialog.actions}>
          <DialogClose asChild>
            <FormButton size="compact" type="button" data-testid="vault-newcat-cancel">
              {t('vault.cancel', {})}
            </FormButton>
          </DialogClose>
          <FormButton size="compact" variant="primary" type="submit" disabled={busy || name.trim() === ''} data-testid="vault-newcat-ok">
            {t('vault.newCat.ok', {})}
          </FormButton>
        </div>
      </form>
    </Dialog>
  );
}
