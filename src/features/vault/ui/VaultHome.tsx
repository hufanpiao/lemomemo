// 隐私记解锁后的首页（负责人 11-19“隐私记这个页面太空了”“解锁后用乙”；方案 柠檬记APP-本机资料/设计方案/2026-11-19_隐私记改善/方案.html 乙）：
// • 分类两列宫格：每格分类色小方块、名字、“N 条 · 最近一条的日期”；点一格进 #/vault/c/<分类 id> 的列表（随手记那一份列表，一开始筛这一类）
// • 宫格下面“最近”一行，右边“全部 N ›”进 #/vault/c/all；再下面最新记的 3 条（按记下的时间，不按排序方式），点开进编辑页
// • 一条都没有：写一句来源给的空态，下面照样出宫格和“＋ 新分类”（第三方实测 11-19 问题 4：原来只有一句空态，新用户没法先建分类），不出“最近”
// • 只在手机排法里画（随手记列表的 home 参数）；电脑版左栏本来就是分类，照旧
// • 宫格最后一格“＋ 新分类”（负责人 11-19 选“做‘＋ 新分类’”；方案乙虚线格）：点了弹窗起名字（最多 12 个字），建好进这一类的列表 #/vault/c/<id>
//   （空的分类也一直有格、写 0 条，底部输入行记的进这一类）；同名的不再建、直接进那一类。隐私记自己一套分类（categories.vault）
// • 长按一格（电脑右键）出改名、删除（负责人 11-19“长按分类格可以改名、删除，删分类时里面的记录不删，变回没分类”）
// • 两个弹窗由随手记列表挂一份（notes 的 ui/CategoryDialogs.tsx），这里经 api.addCategory、api.editCategory 打开
// • 格里的小图标（负责人 11-19 选“按分类名配图标”）：只用方案乙里的三个——健康 ♥、证件 ▤、账号 ✱，按名字里的词配；对不上的只画色块
// • “最近”三条长按拖到某一格上松手，归进那一类（负责人 11-19“里面的记录可以拖进分类里面”“两种都要”“只能拖没分类的”）：
//   kit 的 SortDrag（sort: false，只拖进、不换位），认不认、写入由列表页给的 api.into 管（同列表拖到分类胶囊那一份）
// 运行日志：vault home pick=<all|cat>、hold=cat（只记点了哪一种，不记分类名）
import type { CSSProperties } from 'react';
import { navigate } from '../../../app/router.ts';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { SortBox, sortRowClass, useSortDrag } from '../../../kit/components/SortDrag.tsx';
import { fx } from '../../../platform/fx-api.ts';
import { useLongPress } from '../../../kit/hooks/useLongPress.ts';
import type { CategoryCount, NoteItem, NotesHomeApi } from '../../notes/index.ts';
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

  const latest = latestByCat(api.items);
  const recent = [...api.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  const sd = useSortDrag({ tag: 'vault-home', axis: 'y', sort: false, onDrop: () => undefined, log: rlog, fx, into: api.into });
  const pick = (cid: string | null): void => {
    rlog(`vault home pick=${cid === null ? 'all' : 'cat'}`);
    void navigate('vault', 'c', cid ?? 'all');
  };
  return (
    <div className={styles.home} data-testid="vault-home">
      {api.total === 0 ? (
        <p className={styles.homeEmpty} data-testid="vault-home-empty">
          {api.empty}
        </p>
      ) : null}
        <ul className={styles.grid} aria-label={t('vault.home.cats', {})}>
          {api.counts.map((c) => (
            <Tile key={c.id} c={c} last={latest.get(c.id)} day={api.day} pick={pick} edit={api.editCategory} />
          ))}
          <li>
            <button type="button" className={`${styles.tile} ${styles.tileAdd}`} onClick={api.addCategory} data-testid="vault-home-newcat">
              {t('vault.home.newCat', {})}
            </button>
          </li>
        </ul>
      {api.total === 0 ? null : (
        <>
      <div className={styles.homeRow}>
        <h2 className={styles.homeLabel}>{t('vault.home.recent', {})}</h2>
        <button type="button" className={styles.allLink} onClick={() => pick(null)} data-testid="vault-home-all">
          {t('vault.home.all', { n: api.total })}
          <span aria-hidden="true"> ›</span>
        </button>
      </div>
      <SortBox sd={sd}>
      <ul className={styles.recentList}>
        {recent.map((it) => (
          <li
            key={it.id}
            className={sortRowClass}
            data-sort-id={it.id}
            data-sort-off={api.into.ok(it.id) ? undefined : ''}
            data-sort-held={sd.held === it.id ? '' : undefined}
          >
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
      </SortBox>
        </>
      )}
    </div>
  );
}

/** 一格分类：点了进这一类；长按（电脑右键）出改名、删除（负责人 11-19“长按分类格可以改名、删除”） */
function Tile({ c, last, day, pick, edit }: { c: CategoryCount; last: NoteItem | undefined; day: NotesHomeApi['day']; pick(id: string): void; edit(c: CategoryCount): void }) {
  const t = useVaultT();
  const hold = useLongPress(() => {
    rlog('vault home hold=cat');
    edit(c);
  });
  const sub = last ? t('vault.home.tile', { n: c.count, day: day(last) }) : t('vault.home.tileNoDay', { n: c.count });
  return (
    <li>
      <button
        type="button"
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onPointerLeave={hold.onPointerLeave}
        onContextMenu={hold.onContextMenu}
        onClickCapture={hold.onClickCapture}
        data-long-press={hold['data-long-press']}
        className={styles.tile} onClick={() => pick(c.id)} data-drop-into={c.id} aria-label={t('vault.home.tileLabel', { name: c.name, sub })} data-testid={`vault-home-cat-${c.id}`}>
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
}
