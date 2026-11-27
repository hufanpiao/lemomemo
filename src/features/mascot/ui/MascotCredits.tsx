// 设置 › 关于 › 素材署名：随 App 分发的素材（CC BY 4.0）、Rive 运行库（MIT）、今天页天气的数据来源 Open-Meteo（CC BY 4.0）
import { safeHref } from '../../../../shared/logic/link.ts';
import { SettingsCard } from '../../../kit/components/Settings/Settings.tsx';
import { CC_BY_URL, CREDITS, RIVE_RUNTIME, WEATHER_DATA } from '../hooks/mascot-data.ts';
import { usePrivateCredit } from '../hooks/useMascotAdmin.ts';
import { useMascotT } from '../hooks/useMascotT.ts';
import s from './Mascot.module.css';

export default function MascotCredits({ title }: { title: string }) {
  const t = useMascotT();
  const priv = usePrivateCredit();
  return (
    <div data-testid="settings-credits">
      <SettingsCard title={title}>
        {CREDITS.map((c) => (
          <div key={c.url} className={s['credit']} data-testid="mascot-credit">
            <a href={safeHref(c.url)} target="_blank" rel="noreferrer noopener">{c.work}</a>
            <span className={s['creditMeta']}>{t('mascot.credits.by', { author: c.author })}</span>
            <a className={s['creditMeta']} href={safeHref(CC_BY_URL)} target="_blank" rel="noreferrer noopener">
              {t(c.changed ? 'mascot.credits.changed' : 'mascot.credits.same', {})}
            </a>
          </div>
        ))}
        {priv ? (
          <div className={s['credit']} data-testid="mascot-credit-private">
            <a href={safeHref(priv.url)} target="_blank" rel="noreferrer noopener">{priv.work}</a>
            <span className={s['creditMeta']}>{t('mascot.credits.by', { author: priv.author })}</span>
            {/* 许可证照桶里元数据写的，没写就不显示这一行 */}
            {priv.license?.url ? (
              <a className={s['creditMeta']} href={safeHref(priv.license.url)} target="_blank" rel="noreferrer noopener">{priv.license.name}</a>
            ) : priv.license ? (
              <span className={s['creditMeta']}>{priv.license.name}</span>
            ) : null}
            <span className={s['creditMeta']}>{t('mascot.credits.rights', {})}</span>
          </div>
        ) : null}
        <div className={s['credit']}>
          <a href={safeHref(RIVE_RUNTIME.url)} target="_blank" rel="noreferrer noopener">{RIVE_RUNTIME.work}</a>
          <span className={s['creditMeta']}>{t('mascot.credits.runtime', {})}</span>
        </div>
        <div className={s['credit']} data-testid="weather-credit">
          <a href={safeHref(WEATHER_DATA.url)} target="_blank" rel="noreferrer noopener">{WEATHER_DATA.work}</a>
          <span className={s['creditMeta']}>{t('mascot.credits.weather', {})}</span>
          <a className={s['creditMeta']} href={safeHref(CC_BY_URL)} target="_blank" rel="noreferrer noopener">{t('mascot.credits.same', {})}</a>
        </div>
      </SettingsCard>
    </div>
  );
}
