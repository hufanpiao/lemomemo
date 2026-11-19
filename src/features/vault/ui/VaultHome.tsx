// 隐私记解锁后的首页（负责人 11-19“隐私记这个页面太空了”“解锁后用乙”；方案 柠檬记APP-本机资料/设计方案/2026-11-19_隐私记改善/方案.html 乙）：
// • 分类两列宫格：每格分类色小方块、名字、“N 条 · 最近一条的日期”；点一格进 #/vault/c/<分类 id> 的列表（随手记那一份列表，一开始筛这一类）
// • 宫格下面“最近”一行，右边“全部 N ›”进 #/vault/c/all；再下面最新记的 3 条（按记下的时间，不按排序方式），点开进编辑页
// • 一条都没有：只写一句来源给的空态（同列表那一句；底部输入行、“＋”照旧）
// • 只在手机排法里画（随手记列表的 home 参数）；电脑版左栏本来就是分类，照旧
// • 方案里的“＋ 新分类”那一格没做：隐私记没有新建分类的入口（分类跟着记录走）
// • 格里的小图标（负责人 11-19 选“按分类名配图标”）：只用方案乙里的三个——健康 ♥、证件 ▤、账号 ✱，按名字里的词配；对不上的只画色块
// 运行日志：vault home pick=<all|cat>（只记点了哪一种，不记分类名）
import type { CSSProperties } from 'react';
import { navigate } from '../../../app/router.ts';
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
  const latest = latestByCat(api.items);
  const recent = [...api.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  const pick = (cid: string | null): void => {
    rlog(`vault home pick=${cid === null ? 'all' : 'cat'}`);
    void navigate('vault', 'c', cid ?? 'all');
  };
  if (api.total === 0) {
    return (
      <p className={styles.empty} data-testid="vault-home-empty">
        {api.empty}
      </p>
    );
  }
  return (
    <div className={styles.home} data-testid="vault-home">
      {api.counts.length ? (
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
        </ul>
      ) : null}
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
