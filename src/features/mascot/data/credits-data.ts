// 素材署名（设置 › 关于 › 素材署名）：只列真正随 App 分发的素材，外加 Rive 运行库和天气数据来源。CC BY 4.0 要写作者、原链接、是否有改动
// • id 对到目录（catalog.ts）的哪一只，peek 是输入框小人；官网页脚按 SITE_MASCOT_IDS 过滤，不另记“只在 App”
import type { MascotId } from './catalog.ts';

export interface Credit {
  id: MascotId | 'peek';
  work: string;
  author: string;
  url: string;
  changed: boolean;
}

const page = (slug: string): string => `https://rive.app/marketplace/${slug}/`;

export const CREDITS: readonly Credit[] = [
  { id: '15', work: 'A Tiny Grain, A Big AI Mind', author: '王天维', url: page('28565-54011-a-tiny-grain-a-big-ai-mind'), changed: true },
  { id: '3', work: 'Cat following the mouse', author: 'pedroalpera', url: page('3920-8202-cat-following-the-mouse'), changed: true },
  { id: '7', work: 'Orb', author: 'Andabrow', url: page('29221-55360-orb'), changed: false },
  { id: '13', work: 'Meeples', author: 'Patgrivet', url: page('28694-54264-meeples'), changed: true },
  { id: '18', work: 'Interactive character follow', author: 'alinazari', url: page('28334-53514-interactive-character-follow'), changed: true },
  { id: '19', work: 'Experimental Bob', author: 'mbmfaa', url: page('12002-22871-experimental-bob'), changed: true },
  { id: '20', work: 'Cat Robot', author: 'Lala', url: page('6925-13315-cat-robot'), changed: true },
  { id: '22', work: 'Interactive cute red monster', author: 'ElmerVergara', url: page('28393-53674-interactive-cute-red-monster'), changed: true },
  { id: '23', work: 'Aldo', author: 'Patgrivet', url: page('27606-52145-aldo'), changed: true },
  { id: 'peek', work: 'Interactive chat experience', author: 'musaadanur', url: page('28721-54393-interactive-chat-experience'), changed: true },
];

export const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';
export const RIVE_RUNTIME = { work: 'Rive Web Runtime (@rive-app/canvas)', url: 'https://github.com/rive-app/rive-wasm' } as const;
/** 今天页天气的数据来源（CC BY 4.0 要署名；负责人 11-26 定放在这一页，不放天气半屏里）。只在 App 里，官网不列 */
export const WEATHER_DATA = { work: 'Open-Meteo.com', url: 'https://open-meteo.com/' } as const;
