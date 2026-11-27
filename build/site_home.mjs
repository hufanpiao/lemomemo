// 官网首页（中韩各一页）的正文。由 build/site_pages.mjs 的 renderPages 调用，<head> 和语言切换链接从那里传进来（不反过来 import）。
// 首页正文和样机每一屏画面的唯一源头，直接改这里（改完跑 node build/site_pages.mjs 重新生成页面）。
// 一页一种语言：t(中文, 韩文) 取页面上的一段字、x(中文, 韩文) 取属性值和不带字体的片段，链接写 /${l}/…。
// 样式是 site/index.css，脚本是入口 /index.js 和 HOME_MODULES。
// 页面不内联脚本和样式（官网 CSP）。吉祥物的 .riv、Rive 运行库和 wasm 用 [data-riv]、[data-rive] 上的同源地址，构建时换成 /s/ 下带哈希的名字。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASCOTS, PEEK, SITE_MASCOT_IDS } from '../src/features/mascot/data/catalog.ts';
import { CC_BY_URL, CREDITS, RIVE_RUNTIME } from '../src/features/mascot/data/credits-data.ts';
import { ko as MK } from '../src/features/mascot/i18n/ko.ts';
import { zh as MZ } from '../src/features/mascot/i18n/zh.ts';
import { solarTermIn, toLunarIn } from '../shared/logic/anniv/lunar.ts';
import { LUNAR_CN, TERMS_CN } from '../shared/logic/anniv/lunar-data.ts';
import { SOLAR_TERM_NAMES, ZH_DAY_NAMES, ZH_MONTH_NAMES } from '../shared/logic/anniv/lunar-names-data.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 864e5;

/** 节假日：src/public/holidays（中文页 cn、韩文页 kr）里放假的日子；连着放的只在第一天写名字，后面几天名字为空（格子照样标成节假日） */
function holidays(country, lang) {
  const days = [2026, 2027].flatMap((y) => JSON.parse(readFileSync(join(ROOT, `src/public/holidays/${country}/${y}.json`), 'utf8')).days).filter((d) => d.kind === 'off');
  const out = {};
  days.forEach((d, i) => {
    const p = days[i - 1], cont = p && p.name[lang] === d.name[lang] && Date.parse(d.date) - Date.parse(p.date) === DAY;
    out[d.date] = cont ? '' : d.name[lang];
  });
  return out;
}
const HZ = holidays('cn', 'zh'), HK = holidays('kr', 'ko');
// 月历上的示例日程：日期 → [颜色, 中文, 韩文]；纪念日那天格子里带一颗心
const MEV = (() => {
  const E = (c, zh, ko) => [c, zh, ko], WK = E('c1', '产品周会', '제품 주간 회의');
  return { '2026-11-03': [WK], '2026-11-06': [E('c3', '朋友婚礼', '친구 결혼식')], '2026-11-10': [WK], '2026-11-17': [WK], '2026-11-19': [E('c2', '体检', '건강검진')],
    '2026-11-24': [WK, E('c1', '牙医复诊', '치과 재진료'), E('c1', '和小林吃饭', '수진이랑 저녁')], '2026-11-25': [E('c1', '和小金开会', '김 대리랑 회의')], '2026-11-28': [E('c2', '看展', '전시회 보기')],
    '2026-12-01': [WK], '2026-12-08': [WK], '2026-12-15': [WK], '2026-12-18': [E('c1', '公司年会', '회사 송년회')], '2026-12-22': [WK], '2026-12-24': [E('c3', '圣诞聚餐', '크리스마스 저녁')], '2026-12-29': [WK], '2026-12-31': [E('c2', '跨年', '새해맞이')] };
})();
const MANV = new Set(['2026-11-27', '2026-12-03']);
const HEART = '<svg class="hrt" viewBox="0 0 10 9" aria-hidden="true"><path d="M5 8.6 1 4.7A2.3 2.3 0 0 1 5 1.6a2.3 2.3 0 0 1 4 3.1Z"/></svg>';
/** 格子里的农历字：交节那天写节气，初一写月名，其余写日名（和 site_pages.mjs 演示页一样用 shared/logic/anniv 的 toLunarIn、solarTermIn） */
function lunar(iso) {
  const d = toLunarIn(LUNAR_CN, iso);
  if (!d) throw new Error(`农历表里没有 ${iso}`);
  const term = solarTermIn(TERMS_CN, iso);
  return term != null ? SOLAR_TERM_NAMES['zh-CN'][term] : d.day === 1 ? ZH_MONTH_NAMES[d.month - 1] : ZH_DAY_NAMES[d.day - 1];
}
/** 月历一个月的 42 格（周日开头，6×7）：中文页写农历和中国节假日，韩文页只写韩国节假日。演示页的 monthGrid 是 5～6 行、另一套类名，样子不同，不共用 */
function monthCells(l, y, m) {
  const t = textOf(l), hol = l === 'ko' ? HK : HZ;
  const first = Date.UTC(y, m - 1, 1), start = first - new Date(first).getUTCDay() * DAY;
  let h = '';
  for (let i = 0; i < 42; i++) {
    const ms = start + i * DAY, dd = new Date(ms), d = dd.toISOString().slice(0, 10), inM = dd.getUTCMonth() === m - 1;
    const zl = HZ[d] ? `<span class="hn">${HZ[d]}</span>` : lunar(d);
    const kl = HK[d] ? `<span class="hn">${HK[d]}</span>` : '';
    const ev = MEV[d] || [];
    const cls = ['mc', i % 7 === 0 || i % 7 === 6 ? 'we' : '', inM ? '' : 'out', d === '2026-11-24' ? 'td sel' : '', d in hol ? 'hol' : ''].filter(Boolean).join(' ');
    h += `<span class="${cls}"><b>${dd.getUTCDate()}</b><em>${t(zl, kl)}${MANV.has(d) ? HEART : ''}</em>`
      + ev.slice(0, 2).map(([c, a, b]) => `<i class="mk ${c}">${t(a, b)}</i>`).join('')
      + (ev.length > 2 ? `<small>+${ev.length - 2}</small>` : '') + '</span>';
  }
  return h;
}

/**
 * 页面上的一段字：中文页直接写字；韩文页包一层 <span lang="ko">，韩文字体只上在这段字上，
 * 行框照旧按外层元素的正文字体排（11-26 量过：整段元素直接换韩文字体，每行矮 1～2px，整页矮 42px，和样稿对不上）。
 * 属性值（aria-label 这类）不能用它，用 x()
 */
const textOf = (l) => (zh, ko) => (l === 'ko' ? `<span lang="ko">${ko}</span>` : zh);

const META = {
  zh: { title: '柠檬记 — 说一句就记下', desc: '柠檬记：说一句话就记下日程、待办和随手记，中文、韩文都行；到点准时提醒，iPhone 主屏幕、网页和 Windows 都能用。', ogTitle: '柠檬记 — 说一句就记下', ogDesc: '说一句话就记下日程、待办和随手记，中文、韩文都行。' },
  ko: { title: '레모 — 말하면 바로 기록', desc: '레모: 말 한마디로 일정, 할 일, 메모를 기록해요. 한국어도 중국어도 돼요. 제때 알림을 받고 iPhone 홈 화면, 웹, Windows에서 쓸 수 있어요.', ogTitle: '레모 — 말하면 바로 기록', ogDesc: '말 한마디로 일정, 할 일, 메모를 기록해요. 한국어도 중국어도 돼요.' },
};

/** 吉祥物：catalog.ts 的 7 只 + 输入框小人 PEEK（#2 不在那张表里）。data-def 照 catalog.ts 的画板、状态机、裁切，另加首页自己的三条：
 *  米粒热身 2.6 秒（第一次画某种效果很贵，见 index-rive.js）、小黑猫每帧把脸摆在 catalog 的 look.rest（睁眼）、输入框小人载好 400ms 后探头 */
const HOME_RIVE = { '15': { warm: 2600 }, '3': { face: true }, peek: { online: 400 } };
function rivDef(id, d) {
  const h = HOME_RIVE[id] || {};
  return {
    size: d.size, crop: d.crop, ab: d.artboard, sm: d.sm, pad: d.pad, novm: d.novm, init: d.init,
    warm: h.warm, online: h.online, face: h.face && d.look && d.look.node ? [d.look.node, ...d.look.rest] : undefined,
  };
}
const RIVE_TAGS = '<i hidden data-rive data-js="/rive.js" data-wasm="/rive.wasm"></i>\n' + [['peek', PEEK], ...SITE_MASCOT_IDS.map((id) => [id, MASCOTS[id]])]
  .map(([id, d]) => `<i hidden data-riv="${id}" data-src="/mascot-${id}.riv" data-def="${JSON.stringify(rivDef(id, d)).replace(/"/g, '&quot;')}"></i>`).join('\n');

/** 首页的脚本：入口是 /index.js（ES 模块），下面这些是它直接、间接 import 的，页面头上 modulepreload，免得一层层等 */
export const HOME_MODULES = ['index-kit.js', 'index-draw.js', 'index-gl.js', 'index-rive.js', 'index-outro.js', 'index-fx.js'];

const ext = (href, text) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
/** 页尾素材署名：和 App 设置 › 关于 › 素材署名同一份数据（CC BY 4.0 写作者、原链接、有没有改动；另列 Rive 运行库的 MIT）。t 是页面的取字函数（textOf） */
export function credits(t) {
  // 词条和 App 同一份（features/mascot/i18n）；只列官网放了的（SITE_MASCOT_IDS 和输入框小人）
  const w = (k, author = '') => t(MZ[k].replace('{author}', author), MK[k].replace('{author}', author));
  const onSite = (c) => c.id === 'peek' || SITE_MASCOT_IDS.includes(c.id);
  const items = CREDITS.filter(onSite).map((c) => `<i>${ext(c.url, c.work)} · ${w('mascot.credits.by', c.author)} · ${ext(CC_BY_URL, w(c.changed ? 'mascot.credits.changed' : 'mascot.credits.same'))}</i>`);
  items.push(`<i>${ext(RIVE_RUNTIME.url, RIVE_RUNTIME.work)} · ${w('mascot.credits.runtime')}</i>`);
  // 11-26 负责人：“素材署名是不是可以折叠起来”→ 选“折叠成一行，点开展开”。原生 <details>：没脚本也能开，键盘能操作，不加动画；
  // 展开后的署名一字不差（CC BY 要写全）
  return `<details class="fcred"><summary>${t('素材署名', '소재 출처')} ›</summary><p>${items.join('；')}</p></details>`;
}

/**
 * 四组的大标题、左上角小标签和每一项的说明：画面上那一份由脚本按滚动一条条显示（visibility 跟着进度切），读屏读不全，
 * 所以标成 aria-hidden，另在 #film 开头放一份只给读屏的 .sr-film（同一张表生成，减少动态效果时也是这一份）。CAPS 的顺序就是 ITEMS 的顺序
 */
const GT = [
  [`<span class="l">AI 帮你记，</span><span class="l">也帮你找</span>`, `<span class="l">AI가 적어 주고,</span><span class="l">찾아 줘요</span>`],
  [`<span class="l">日程和提醒，</span><span class="l">都替你记着</span>`, `<span class="l">일정과 알림,</span><span class="l">다 챙겨 둬요</span>`],
  [`<span class="l">待办和随手记，</span><span class="l">分得清清楚楚</span>`, `<span class="l">할 일과 메모,</span><span class="l">깔끔하게 나눠요</span>`],
  [`<span class="l">按你的喜好，</span><span class="l">换个样子</span>`, `<span class="l">내 취향대로</span><span class="l">바꿔 보세요</span>`],
];
const GLAB = [
  [`AI 帮你记，也帮你找`, `AI가 적어 주고, 찾아 줘요`],
  [`日程和提醒，都替你记着`, `일정과 알림, 다 챙겨 둬요`],
  [`待办和随手记，分得清清楚楚`, `할 일과 메모, 깔끔하게 나눠요`],
  [`按你的喜好，换个样子`, `내 취향대로 바꿔 보세요`],
];
const CAPS = [
  [0, `点一下+，打一句，AI 帮你整理`, `+를 한 번 누르고 쓰면 AI가 정리해요`, `打一句“今天六点前把发票寄给会计”，AI 认出日期和提醒，记成今天的待办。`, `“오늘 6시까지 세무사에게 영수증 보내기”라고 쓰면 AI가 날짜와 알림을 알아채서 오늘 할 일로 넣어 줘요.`],
  [0, `长按+说一句，AI 记成日程`, `+를 길게 누르고 말하면 AI가 일정으로`, `按住+说“明天下午三点和小金开会”，松手就记成明天的日程。中文、韩文混着说也行。`, `+를 누른 채 “내일 오후 세 시에 김 대리랑 회의”라고 말하고 손을 떼면 내일 일정이 돼요. 한국어, 중국어를 섞어 말해도 돼요.`],
  [0, `AI 总结这周的日程`, `이번 주 일정을 AI가 요약해요`, `打一句“总结一下这周的日程”，AI 理成一段话，每句都标着依据。总结只在这里看，不会存进你的记录。`, `“이번 주 일정 정리해 줘”라고 쓰면 AI가 한 단락으로 정리하고 문장마다 근거를 달아요. 요약은 화면에만 보이고 기록으로 저장되지 않아요.`],
  [0, `问一句，所有记录一起找`, `한 마디로 모든 기록을 찾아요`, `问一句，日程、待办、纪念日、随手记和附件一起找；字对不上，按意思也能找到。`, `한 마디 입력하면 일정, 할 일, 기념일, 메모, 첨부파일을 함께 찾아요. 단어가 달라도 뜻으로 찾아요.`],
  [0, `AI 联网搜索`, `AI 웹 검색`, `问 AI 助手，需要的时候它会上网查；回答上方写着查了几个网页，点来源就能打开。`, `AI 도우미에게 물으면 필요할 때 웹을 찾아봐요. 몇 곳을 찾았는지 답 위에 보이고, 출처를 누르면 열려요.`],
  [0, `AI 助手可以更换`, `AI 도우미를 바꿔요`, `用柠檬记提供的 AI，或用自己的密钥选 Gemini、Claude、OpenAI、DeepSeek；换了 AI，它记住的事还在。`, `레모가 제공하는 AI를 쓰거나 내 키로 Gemini, Claude, OpenAI, DeepSeek 중에서 골라요. 바꿔도 기억한 내용은 그대로예요.`],
  [1, `周历往前翻，过去的都在`, `주간 달력은 지난 주까지 다 보여요`, `一周七天排开，往前翻，过去的日程和待办都还在。`, `일주일을 펼쳐 놓고 이전 주로 넘기면 지난 일정과 할 일이 그대로 있어요.`],
  [1, `切到月历，一个月一眼看完`, `월간 달력으로 한 달을 한눈에`, `每天的日程是格子里的彩色小条，节气、农历、纪念日也写在格子里。`, `날마다 일정이 칸 안에 색깔 막대로 보이고, 기념일과 공휴일도 함께 표시돼요.`],
  [1, `纪念日、生日，年年提醒`, `기념일과 생일은 해마다 알려 줘요`, `阴历生日每年自动换算；当天、前一天、提前几天，提醒可以选好几个，不会漏掉。`, `음력 생일도 해마다 양력으로 바꿔 주고, 당일·하루 전·며칠 전 알림을 여러 개 골라 둘 수 있어요.`],
  [1, `填上生日，看每日运势`, `생일을 넣으면 매일 운세를 봐요`, `按八字看每天的工作、感情、财运、健康，还有幸运色和幸运数字。仅供娱乐。`, `사주로 매일 일, 연애, 금전, 건강 운과 행운의 색, 행운의 숫자를 봐요. 재미로 보는 운세예요.`],
  [2, `待办分轻重缓急`, `할 일은 중요도별로`, `高、中、低三档，换成高的自动排到前面；做完一勾就划掉，左滑删除。`, `높음, 보통, 낮음 세 단계예요. 높음으로 바꾸면 위로 올라가고, 끝내면 체크, 왼쪽으로 밀면 삭제돼요.`],
  [2, `大事拆成小步骤`, `큰 일은 작은 단계로`, `一条待办下面加子待办，卡片上看进度；全部勾完，这条待办自动完成。`, `할 일 아래에 하위 할 일을 추가하고 카드에서 진행도를 봐요. 다 체크하면 할 일이 저절로 완료돼요.`],
  [2, `随手记灵感，AI 帮你分类`, `떠오른 생각은 AI가 분류해요`, `想到什么先记一句，可以配张照片当封面，AI 从你已有的分类里挑一个贴上；电脑上还能加附件。`, `떠오른 걸 한 줄 적고 사진을 표지로 붙여요. AI가 내 분류 중에서 골라 붙이고, PC에서는 첨부파일도 넣을 수 있어요.`],
  [2, `隐私记，锁住你的隐私`, `비밀 메모는 따로 잠가요`, `隐私记单独上锁，输 4 位密码或用 Face ID 才能打开，离开一会儿自动锁上；里面也能放照片。`, `비밀 메모는 따로 잠기고, 4자리 비밀번호나 Face ID로만 열려요. 잠시 떠나면 다시 잠기고, 안에 사진도 넣을 수 있어요.`],
  [3, `边缘一划，切页、进设置`, `가장자리를 밀어 탭 이동, 설정 열기`, `从屏幕左边缘往右划，切到下一个页签；从右边缘往左划，直接进设置。`, `왼쪽 가장자리에서 오른쪽으로 밀면 다음 탭으로, 오른쪽 가장자리에서 왼쪽으로 밀면 바로 설정이 열려요.`],
  [3, `AI 助手换个样子`, `AI 도우미 모습도 골라요`, `设置 › 吉祥物里有 7 个会动的角色，点哪个换哪个，今天页“现在”卡上的也跟着换。`, `설정 › 마스코트에 움직이는 캐릭터가 7가지 있어요. 고르는 대로 오늘 화면 ‘지금’ 카드에도 같이 바뀌어요.`],
  [3, `字体 4 种随你换`, `글꼴 4가지 중에서 골라요`, `系统字体、细线黑、悠哉体、文楷，选中哪种，才把哪种下载到这台设备上。`, `시스템 글꼴, 가는 고딕, 유자이체, 원카이. 고른 글꼴만 지금 쓰는 기기에 내려받아요.`],
  [3, `头像自己定`, `프로필 사진은 내 마음대로`, `上传一张照片，挪一挪、缩放一下就好；只有你自己看得到，各台设备同步显示。`, `사진을 올리고 위치와 크기만 맞추면 돼요. 나만 볼 수 있고, 모든 기기에 똑같이 보여요.`],
  [3, `中文、韩文一键切换`, `중국어, 한국어 바로 전환`, `设置里改界面语言，提醒和邮件也会改用这种语言；这个网页右上角也能切。`, `설정에서 앱 언어를 바꾸면 알림과 메일도 이 언어로 보내 드려요. 이 페이지도 오른쪽 위에서 바꿀 수 있어요.`],
];

/** 一个首页。k 是 site_pages.mjs 传进来的共用件：{ head, langSw } */
export function homePage(l, k) {
  const x = (zh, ko) => (l === 'ko' ? ko : zh);
  const t = textOf(l);
  const { ic } = k;
  const langSw = k.langSw(l, '');
  /** 键盘（中文页拼音全键盘，韩文页两벌식） */
  const KZ = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'], KK = ['ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ', 'ㅁㄴㅇㄹㅎㅗㅓㅏㅣ', 'ㅋㅌㅊㅍㅠㅜㅡ'];
  const key = (i, r) => `<span>${t(KZ[r][i], KK[r][i])}</span>`;
  const kbRow = (r) => Array.from(KZ[r], (_, i) => key(i, r)).join('');
  const KB = `<p class="kb-r">${kbRow(0)}</p><p class="kb-r r2">${kbRow(1)}</p><p class="kb-r"><span class="w">⇧</span>${kbRow(2)}<span class="w">⌫</span></p>`
    + `<p class="kb-r r4"><span class="w">123</span><span class="sp">${t(`空格`, `스페이스`)}</span><span class="rt"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6v6H6M10 8l-4 4 4 4"/></svg></span></p>`;

  /** “今天”页的上半段：日期、“现在”卡（今天、语音、总结、运势四屏都一样） */
  const TODAY_HD = `          <div class="ap-hd"><div><p class="ap-t">${t(`11月24日 周二`, `11월 24일 화요일`)}</p><span class="ap-bar"></span></div><span class="ap-me">${ic('me')}</span></div>
          <div class="nc"><div class="nc-top"><span class="pill">${t(`进行中`, `진행 중`)}</span><span class="nc-now">${t(`现在 10:20`, `지금 10:20`)}</span></div><p class="nc-t">${t(`产品周会`, `제품 주간 회의`)}</p><div class="trk"><i></i><b></b></div><div class="nc-ts"><span>10:00</span><span>11:00</span><span>12:00</span></div><span class="ms mi mi-15"></span></div>`;
  /** “今天”页“没赶上”那一组 */
  const TODAY_LATE = `          <div class="sl red"><span>${t(`! 没赶上`, `! 놓친 일`)}</span><b>1</b></div>
          <div class="lt"><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`交季度报告`, `분기 보고서 제출`)}</span><small class="red">${t(`逾 1 天`, `1일 지남`)}</small></span><span class="pp">${ic('clock')}${t(`推迟`, `미루기`)}</span></div></div>`;
  /** “今天”页“今天的安排”：4 项（打字那一屏多一项新记的，单写） */
  const TODAY_LIST = `          <div class="sl"><span>${t(`今天的安排`, `오늘 일정`)}</span><b>4</b></div>
          <div class="lc"><div class="rw"><span class="tm">14:00</span><span class="tx"><span class="tt">${t(`牙医复诊`, `치과 재진료`)}</span></span></div><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`订周末的火车票`, `주말 기차표 예매`)}</span><small>${t(`今天截止`, `오늘 마감`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`给妈妈打电话`, `엄마한테 전화하기`)}</span><small>${t(`20:00 提醒`, `20:00 알림`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw"><span class="tm">19:30</span><span class="tx"><span class="tt">${t(`和小林吃饭`, `수진이랑 저녁`)}</span></span></div></div>`;
  /** 打字条（点＋打字和打字总结两屏共用，ty 是打进去的那句；照 features/plus/ui/TypeBar、PlusFields） */
  const tbar = (ty) => `<div class="tbar"><p class="tb-f"><span class="ph0">${t(`想记什么，回车记下`, `기록할 내용을 입력하고 엔터`)}</span><span class="ty">${ty}</span></p><p class="tb-say">${t(`正在识别…`, `인식하는 중…`)}</p><div class="pf"><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg><span class="sw"><span class="a">${t(`分类`, `분류`)}</span><span class="b">${t(`工作`, `일`)}</span></span></span><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg><span class="sw"><span class="a">${t(`日期`, `날짜`)}</span><span class="b">${t(`11/24 今天 18:00`, `11/24 오늘 18:00`)}</span></span></span><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 21h4"/></svg>${t(`提醒`, `알림`)}</span></div><p class="pf-n"><span class="sw"><span class="a">${t(`试着打：明天下午3点 工作 开会 提醒我`, `이렇게 입력해 보세요: 내일 오후 3시 업무 회의 알림 설정해 줘`)}</span><span class="b">${t(`浅黄 = 从这句话里认出来的，点一下能改`, `연노랑 = 이 문장에서 알아낸 것, 눌러서 바꿀 수 있어요`)}</span></span></p><div class="tb-tools"><span class="ib"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></span><span class="ib"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg></span><span class="tb-save">${t(`记下`, `기록`)}</span></div><span class="pk" aria-hidden="true"><span class="pk-rv mi mi-peek"></span></span></div>`;

  /** 每一屏的内容（b = true：静止的一屏，给边缘划动和多端那一节用） */
  const SCR = {};
  // ⓪ 今天页：点一下＋打字 → AI 识别 → 记成今天的待办（照 features/plus/ui/TypeBar、PlusFields）
  SCR.type = (b) => `${TODAY_HD}
${TODAY_LATE}
          <div class="sl"><span>${t(`今天的安排`, `오늘 일정`)}</span><b class="cnt5"><span class="sw"><i class="a">4</i><i class="b">5</i></span></b></div>
          <div class="lc"><div class="rw"><span class="tm">14:00</span><span class="tx"><span class="tt">${t(`牙医复诊`, `치과 재진료`)}</span></span></div><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`订周末的火车票`, `주말 기차표 예매`)}</span><small>${t(`今天截止`, `오늘 마감`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw rw-todo rw-new"><i class="flash"></i><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`把发票寄给会计`, `세무사에게 영수증 보내기`)}</span><small>${t(`18:00 提醒`, `18:00 알림`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`给妈妈打电话`, `엄마한테 전화하기`)}</span><small>${t(`20:00 提醒`, `20:00 알림`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw"><span class="tm">19:30</span><span class="tx"><span class="tt">${t(`和小林吃饭`, `수진이랑 저녁`)}</span></span></div></div>
${b ? '' : `          <div class="toast"><span>${t(`已记下：把发票寄给会计`, `기록했어요: 세무사에게 영수증 보내기`)}</span><b>${t(`撤销`, `되돌리기`)}</b></div>
          <div class="tb-mist"></div>
          <div class="kbd">${KB}</div>
          ${tbar(t(`今天六点前把发票寄给会计`, `오늘 6시까지 세무사에게 영수증 보내기`))}`}`;
  // ① 今天页：按住＋说一句 → 记成明天的日程
  SCR.voice = (b) => `${TODAY_HD}
${TODAY_LATE}
${TODAY_LIST}
${b ? '' : `          <div class="sl nx"><span>${t(`明天 11月25日`, `내일 11월 25일`)}</span><b>1</b></div>
          <div class="lc nx"><div class="rw"><i class="flash"></i><span class="tm">15:00</span><span class="tx"><span class="tt">${t(`和小金开会`, `김 대리랑 회의`)}</span></span></div></div>
          <div class="toast"><span>${t(`已记下：和小金开会`, `기록했어요: 김 대리랑 회의`)}</span><b>${t(`撤销`, `되돌리기`)}</b><b>${t(`修改`, `수정`)}</b></div>
          <div class="dim"></div>
          <div class="sheet rec"><span class="grab"></span>
            <p class="rec-st"><i class="rdot"></i><span class="s1">${t(`正在录音`, `녹음 중`)}</span><span class="s2">${t(`正在整理…`, `정리하는 중…`)}</span></p>
            <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <p class="rec-m">${t(`说完松手，AI 帮你整理`, `다 말하고 손을 떼면 AI가 정리해요`)}</p>
            <div class="heard"><small>${t(`听到的字`, `들은 내용`)}</small><p><span class="ty">${t(`明天下午三点和小金开会`, `내일 오후 세 시에 김 대리랑 회의`)}</span></p></div>
            <p class="rec-s">${t(`中文、韩文混着说都行 · 最长 60 秒`, `중국어, 한국어 섞어서 말해도 돼요 · 최대 60초`)}</p>
          </div>`}`;
  // ⓪b 今天页：点＋打“总结一下这周的日程” → 本机判断是总结 → 结果层整屏打开、AI 总结（照 features/plus/data/type-flow.ts、shared/logic/parse/intent.ts、smart-search/ui/AssistPanel.tsx）
  SCR.sum = (b) => `${TODAY_HD}
${TODAY_LATE}
${TODAY_LIST}
${b ? '' : `          <div class="tb-mist"></div>
          <div class="kbd">${KB}</div>
          ${tbar(t(`总结一下这周的日程`, `이번 주 일정 정리해 줘`))}`}
          <div class="as"><div class="as-top"><span class="as-x">✕ ${t(`关闭`, `닫기`)}</span><b>${t(`查找结果`, `찾은 결과`)}</b><span></span></div><p class="as-said">“${t(`总结一下这周的日程`, `이번 주 일정 정리해 줘`)}”</p><div class="as-und"><span>${t(`理解成：<b>11月23日 周一–11月29日 周日的日程</b>`, `이렇게 이해했어요: <b>11월 23일 (월)–11월 29일 (일) 일정</b>`)}</span><span class="as-ed">${t(`改`, `바꾸기`)}</span></div><section class="as-sum"><div class="as-sh">${t(`AI 总结 · 只显示，不保存`, `AI 요약 · 보여 주기만 하고 저장하지 않아요`)}</div><p class="as-w">${t(`正在总结…`, `요약하는 중…`)}</p><p class="as-tx">${t(`这周一共 5 个日程，集中在周二和周三。周二最满：上午 10 点产品周会<sup>1</sup>、下午 2 点牙医复诊<sup>2</sup>、晚上 7 点半和小林吃饭<sup>3</sup>；周三下午 3 点和小金开会<sup>4</sup>；周六去看展<sup>5</sup>，其余几天都空着。`, `이번 주 일정은 5개이고 화요일과 수요일에 몰려 있어요. 화요일엔 오전 10시 제품 주간 회의<sup>1</sup>, 오후 2시 치과 재진료<sup>2</sup>, 저녁 7시 반 수진이랑 저녁<sup>3</sup>이 있고, 수요일 오후 3시엔 김 대리랑 회의<sup>4</sup>, 토요일엔 전시회 보기<sup>5</sup>가 있어요.`)}</p><div class="as-bb"><span>${t(`依据：5 条记录`, `근거: 기록 5개`)}</span><span>${t(`收起`, `접기`)} ▴</span></div></section><div class="as-days"><p class="as-gh">${t(`11月24日 周二`, `11월 24일 (화)`)}</p><ul class="as-ul"><li class="as-row"><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`产品周会`, `제품 주간 회의`)}</b><small>${t(`11月24日 周二 10:00`, `11월 24일 (화) 10:00`)}</small></span></li><li class="as-row"><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`牙医复诊`, `치과 재진료`)}</b><small>${t(`11月24日 周二 14:00`, `11월 24일 (화) 14:00`)}</small></span></li><li class="as-row"><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`和小林吃饭`, `수진이랑 저녁`)}</b><small>${t(`11月24日 周二 19:30`, `11월 24일 (화) 19:30`)}</small></span></li></ul><p class="as-gh">${t(`11月25日 周三`, `11월 25일 (수)`)}</p><ul class="as-ul"><li class="as-row"><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`和小金开会`, `김 대리랑 회의`)}</b><small>${t(`11月25日 周三 15:00`, `11월 25일 (수) 15:00`)}</small></span></li></ul><p class="as-gh">${t(`11月28日 周六`, `11월 28일 (토)`)}</p><ul class="as-ul"><li class="as-row"><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`看展`, `전시회 보기`)}</b><small>${t(`11月28日 周六`, `11월 28일 (토)`)}</small></span></li></ul></div><ul class="as-basis"><li class="as-row"><span class="as-num">1</span><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`产品周会`, `제품 주간 회의`)}</b><small>${t(`11月24日 周二 10:00`, `11월 24일 (화) 10:00`)}</small></span></li><li class="as-row"><span class="as-num">2</span><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`牙医复诊`, `치과 재진료`)}</b><small>${t(`11月24日 周二 14:00`, `11월 24일 (화) 14:00`)}</small></span></li><li class="as-row"><span class="as-num">3</span><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`和小林吃饭`, `수진이랑 저녁`)}</b><small>${t(`11月24日 周二 19:30`, `11월 24일 (화) 19:30`)}</small></span></li><li class="as-row"><span class="as-num">4</span><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`和小金开会`, `김 대리랑 회의`)}</b><small>${t(`11月25日 周三 15:00`, `11월 25일 (수) 15:00`)}</small></span></li><li class="as-row"><span class="as-num">5</span><span class="as-lead"><i class="as-bar"></i></span><span class="as-t"><b>${t(`看展`, `전시회 보기`)}</b><small>${t(`11月28日 周六`, `11월 28일 (토)`)}</small></span></li></ul><div class="as-acts"><span class="as-act">${t(`改成记下`, `기록으로 바꾸기`)}</span></div><p class="as-use">${t(`这次用了 1 次 AI`, `이번에 AI 1회 사용`)}</p></div>`;
  // ② 查找：问一句，全站一起找
  SCR.find = () => `          <p class="fd-hd"><b>${t(`查找`, `찾기`)}</b><span>${t(`取消`, `취소`)}</span></p>
          <div class="fd-in"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l4.5 4.5"/></svg><span class="ph0">${t(`想找什么`, `무엇을 찾을까요`)}</span><span class="ty">${t(`小林的生日是哪天`, `수진 생일이 언제지`)}</span></div>
          <p class="fd-hint">${t(`打一句话，日程、待办、纪念日、随手记和附件一起找`, `한 마디 입력하면 일정, 할 일, 기념일, 메모, 첨부파일을 함께 찾아요`)}</p>
          <p class="fd-wait">${t(`正在按意思找…`, `의미로 찾는 중…`)}</p>
          <div class="fd-res">
            <div class="chips"><span class="on">${t(`全部 4`, `전체 4`)}</span><span>${t(`日程`, `일정`)}</span><span>${t(`待办`, `할 일`)}</span><span>${t(`纪念日`, `기념일`)}</span><span>${t(`随手记`, `메모`)}</span><span>${t(`图片`, `사진`)}</span></div>
            <p class="fd-ai"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.9 5.2 5.1 1.8-5.1 1.9-1.9 5.1-1.8-5.1-5.2-1.9 5.2-1.8zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>${t(`理解成：小林 生日`, `이렇게 이해했어요: 수진 생일`)}</p>
            <div class="fd-g"><p class="fd-gh"><b>${t(`最相关 1`, `가장 관련 있음 1`)}</b><small>${t(`关键词和意思都对上`, `키워드와 의미 모두 일치`)}</small></p>
              <div class="lc"><div class="rw fr1"><span class="kd p">${t(`纪念日`, `기념일`)}</span><span class="tx"><span class="tt">${t(`小林 生日`, `수진 생일`)}</span><small>${t(`下一次 11月27日`, `다음 11월 27일`)}</small></span></div></div></div>
            <div class="fd-g"><p class="fd-gh"><b>${t(`关键词找到 2`, `키워드로 찾음 2`)}</b></p>
              <div class="lc"><div class="rw"><span class="kd">${t(`日程`, `일정`)}</span><span class="tx"><span class="tt">${t(`和小林吃饭`, `수진이랑 저녁`)}</span><small>${t(`今天 19:30`, `오늘 19:30`)}</small></span></div><div class="rw"><span class="kd b">${t(`待办`, `할 일`)}</span><span class="tx"><span class="tt">${t(`还小林的书`, `수진이 책 돌려주기`)}</span><small>${t(`周五截止`, `금요일 마감`)}</small></span></div></div></div>
            <div class="fd-g"><p class="fd-gh"><b>${t(`意思相近 1`, `의미가 비슷함 1`)}</b></p>
              <div class="lc"><div class="rw"><span class="kd n">${t(`随手记`, `메모`)}</span><span class="tx"><span class="tt">${t(`小林说喜欢那本旧书的封面`, `수진이가 그 헌책 표지가 좋대`)}</span></span></div></div></div>
          </div>`;
  // ③ AI 助手：联网查
  SCR.chat = () => `          <div class="ch-hd"><b>${t(`AI 助手`, `AI 도우미`)}</b><span class="x"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></span></div>
          <p class="bub me">${t(`这周末首尔有什么展可以看？`, `이번 주말 서울에서 볼 만한 전시 있어?`)}</p>
          <p class="thk"><i></i><i></i><i></i></p>
          <div class="ans">
            <p class="meta"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z"/></svg>${t(`联网查了 3 个网页 · 用了你的日程`, `웹페이지 3곳을 찾아봤어요 · 내 일정 사용`)}</p>
            <p class="bub ai">${t(`周六你已经记了“看展”。这周末开着的展找到几个，点下面的网页看详情。`, `토요일에 이미 ‘전시회 보기’를 기록해 두셨어요. 이번 주말에 열리는 전시를 몇 곳 찾았어요. 아래 웹페이지에서 자세히 보세요.`)}</p>
            <p class="src"><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z"/></svg>${t(`网页`, `웹페이지`)} 1</span><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z"/></svg>${t(`网页`, `웹페이지`)} 2</span><span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z"/></svg>${t(`网页`, `웹페이지`)} 3</span></p>
          </div>
          <div class="ch-in"><span class="ph0">${t(`问点什么，或者按住说`, `물어보거나 누르고 말하세요`)}</span><span class="ty">${t(`这周末首尔有什么展可以看？`, `이번 주말 서울에서 볼 만한 전시 있어?`)}</span><span class="send">${ic('up')}</span><span class="pk" aria-hidden="true"><span class="pk-rv mi mi-peek"></span></span></div>`;
  // ④ 设置 › 我的 AI：换服务商
  SCR.aip = () => `          <p class="st-nav">${ic('left')}${t(`设置`, `설정`)}</p>
          <p class="st-t">${t(`我的 AI`, `내 AI`)}</p>
          <p class="st-sec">${t(`用哪个`, `어떤 걸 쓸까요`)}</p>
          <div class="card opts"><div class="opt o1"><i class="rd"></i><span>${t(`用柠檬记提供的 AI`, `레모가 제공하는 AI 쓰기`)}</span></div><div class="opt o2"><i class="rd"></i><span>${t(`用我自己的密钥`, `내 키 쓰기`)}</span></div></div>
          <div class="ownbox"><p class="st-sec">${t(`服务商`, `서비스`)}</p>
            <div class="provs"><span class="pv pv-g"><b>Gemini</b><small>${t(`谷歌`, `구글`)}</small></span><span class="pv pv-c"><b>Claude</b><small>Anthropic</small></span><span class="pv pv-o"><b>OpenAI</b><small>OpenAI</small></span><span class="pv pv-d"><b>DeepSeek</b><small>${t(`深度求索`, `딥시크`)}</small></span></div></div>
          <div class="card mem"><b>${t(`长期记忆不受影响`, `장기 기억은 그대로예요`)}</b><p>${t(`AI 记住的事存在柠檬记里，换不换 AI 都在。`, `AI가 기억한 내용은 레모에 저장돼서, AI를 바꿔도 그대로 있어요.`)}</p></div>`;
  // ⑤ 日历 › 周：往前翻
  SCR.week = () => `          <div class="cal-hd"><p class="ap-t">${t(`11月`, `11월`)}</p><span class="seg"><span class="on">${t(`周`, `주`)}</span><span>${t(`月`, `월`)}</span><span>${t(`纪念日`, `기념일`)}</span></span></div>
          <div class="wk-bar"><span class="arr prev">${ic('left')}</span><span class="wk-chip"><span class="r r0">${t(`11月22日–28日`, `11월 22일–28일`)}</span><span class="r r1">${t(`11月15日–21日`, `11월 15일–21일`)}</span><span class="r r2">${t(`11月8日–14日`, `11월 8일–14일`)}</span></span><span class="arr">${ic('right')}</span></div>
          <p class="wk-sub"><span class="r0">${t(`本周 6 项`, `이번 주 6개`)}</span><span class="wk-today">${t(`回到今天`, `오늘로 돌아가기`)}</span></p>
          <div class="wk-days">
            <div class="wk w0">
              <div class="dr we"><p class="dl"><small>${t(`周日`, `일`)}</small><b>22</b><em>${x(`<span>小雪</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周一`, `월`)}</small><b>23</b><em>${x(`<span>十五</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr td"><p class="dl"><small>${t(`周二`, `화`)}</small><b>24</b><em>${x(`<span>十六</span>`, '')}</em></p><div class="dc"><span class="ev"><i>10:00</i>${t(`产品周会`, `제품 주간 회의`)}</span><span class="ev"><i>14:00</i>${t(`牙医复诊`, `치과 재진료`)}</span><span class="ev"><i>19:30</i>${t(`和小林吃饭`, `수진이랑 저녁`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周三`, `수`)}</small><b>25</b><em>${x(`<span>十七</span>`, '')}</em></p><div class="dc"><span class="ev"><i>15:00</i>${t(`和小金开会`, `김 대리랑 회의`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周四`, `목`)}</small><b>26</b><em>${x(`<span>十八</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周五`, `금`)}</small><b>27</b><em>${x(`<span>十九</span>`, '')}</em></p><div class="dc"><span class="ev p">${t(`小林 生日`, `수진 생일`)}</span></div></div>
              <div class="dr we"><p class="dl"><small>${t(`周六`, `토`)}</small><b>28</b><em>${x(`<span>二十</span>`, '')}</em></p><div class="dc"><span class="ev b">${t(`看展`, `전시회 보기`)}</span></div></div>
            </div>
            <div class="wk w1">
              <div class="dr we"><p class="dl"><small>${t(`周日`, `일`)}</small><b>15</b><em>${x(`<span>初七</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周一`, `월`)}</small><b>16</b><em>${x(`<span>初八</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周二`, `화`)}</small><b>17</b><em>${x(`<span>初九</span>`, '')}</em></p><div class="dc"><span class="ev"><i>10:00</i>${t(`产品周会`, `제품 주간 회의`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周三`, `수`)}</small><b>18</b><em>${x(`<span>初十</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周四`, `목`)}</small><b>19</b><em>${x(`<span>十一</span>`, '')}</em></p><div class="dc"><span class="ev b">${t(`体检`, `건강검진`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周五`, `금`)}</small><b>20</b><em>${x(`<span>十二</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr we"><p class="dl"><small>${t(`周六`, `토`)}</small><b>21</b><em>${x(`<span>十三</span>`, '')}</em></p><div class="dc"></div></div>
            </div>
            <div class="wk w2">
              <div class="dr we"><p class="dl"><small>${t(`周日`, `일`)}</small><b>8</b><em>${x(`<span>三十</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周一`, `월`)}</small><b>9</b><em>${x(`<span>十月</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周二`, `화`)}</small><b>10</b><em>${x(`<span>初二</span>`, '')}</em></p><div class="dc"><span class="ev"><i>10:00</i>${t(`产品周会`, `제품 주간 회의`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周三`, `수`)}</small><b>11</b><em>${x(`<span>初三</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周四`, `목`)}</small><b>12</b><em>${x(`<span>初四</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周五`, `금`)}</small><b>13</b><em>${x(`<span>初五</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr we"><p class="dl"><small>${t(`周六`, `토`)}</small><b>14</b><em>${x(`<span>初六</span>`, '')}</em></p><div class="dc"></div></div>
            </div>
          </div>`;
  // ⑤b 日历：点“月”从周历换成月历，再翻到下个月（照 features/calendar/ui/CalendarPage、CalNav、MonthGrid、DayList）
  SCR.month = () => `          <div class="ap-hd"><div><p class="ap-t"><span class="mt0">${t(`11月`, `11월`)}</span><span class="mt1">${t(`12月`, `12월`)}</span><i class="chev"></i></p><span class="ap-bar"></span><p class="ap-sub"><span class="ms0">${t(`11月22日–28日 · 本周 6 项`, `11월 22일–28일 · 이번 주 6개`)}</span><span class="ms1">${t(`2026年 · 本月 11 项`, `2026년 · 이번 달 11개`)}</span><span class="ms2">${t(`2026年 · 本月 9 项`, `2026년 · 이번 달 9개`)}</span></p></div><span class="ap-me">${ic('me')}</span></div>
          <div class="cn"><span class="seg"><span class="cn-w on">${t(`周`, `주`)}</span><span class="cn-m">${t(`月`, `월`)}</span><span>${t(`纪念日`, `기념일`)}</span></span><span class="cn-r"><span class="nb">‹</span><span class="tdy">${t(`今天`, `오늘`)}</span><span class="nb cn-n">›</span></span></div>
          <div class="mo-b">
            <div class="mw">
              <div class="dr we"><p class="dl"><small>${t(`周日`, `일`)}</small><b>22</b><em>${x(`<span>小雪</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周一`, `월`)}</small><b>23</b><em>${x(`<span>十五</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr td"><p class="dl"><small>${t(`周二`, `화`)}</small><b>24</b><em>${x(`<span>十六</span>`, '')}</em></p><div class="dc"><span class="ev"><i>10:00</i>${t(`产品周会`, `제품 주간 회의`)}</span><span class="ev"><i>14:00</i>${t(`牙医复诊`, `치과 재진료`)}</span><span class="ev"><i>19:30</i>${t(`和小林吃饭`, `수진이랑 저녁`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周三`, `수`)}</small><b>25</b><em>${x(`<span>十七</span>`, '')}</em></p><div class="dc"><span class="ev"><i>15:00</i>${t(`和小金开会`, `김 대리랑 회의`)}</span></div></div>
              <div class="dr"><p class="dl"><small>${t(`周四`, `목`)}</small><b>26</b><em>${x(`<span>十八</span>`, '')}</em></p><div class="dc"></div></div>
              <div class="dr"><p class="dl"><small>${t(`周五`, `금`)}</small><b>27</b><em>${x(`<span>十九</span>`, '')}</em></p><div class="dc"><span class="ev p">${t(`小林 生日`, `수진 생일`)}</span></div></div>
              <div class="dr we"><p class="dl"><small>${t(`周六`, `토`)}</small><b>28</b><em>${x(`<span>二十</span>`, '')}</em></p><div class="dc"><span class="ev b">${t(`看展`, `전시회 보기`)}</span></div></div>
            </div>
            <div class="mgr"><p class="mwd"><span>${t(`日`, `일`)}</span><span>${t(`一`, `월`)}</span><span>${t(`二`, `화`)}</span><span>${t(`三`, `수`)}</span><span>${t(`四`, `목`)}</span><span>${t(`五`, `금`)}</span><span>${t(`六`, `토`)}</span></p><div class="mgs"><div class="mg mg0">${monthCells(l, 2026, 11)}</div><div class="mg mg1">${monthCells(l, 2026, 12)}</div></div>
              <p class="dlh"><span>${t(`11月24日 周二`, `11월 24일 화요일`)}</span><b>${t(`3 项`, `3건`)}</b></p>
              <div class="lc"><div class="rw"><span class="tm">10:00</span><span class="tx"><span class="tt">${t(`产品周会`, `제품 주간 회의`)}</span></span></div><div class="rw"><span class="tm">14:00</span><span class="tx"><span class="tt">${t(`牙医复诊`, `치과 재진료`)}</span></span></div><div class="rw"><span class="tm">19:30</span><span class="tx"><span class="tt">${t(`和小林吃饭`, `수진이랑 저녁`)}</span></span></div></div></div>
          </div>`;
  // ⑥ 日历 › 纪念日：新建一个阴历生日，选提醒
  SCR.anv = (b) => `          <div class="cal-hd"><p class="ap-t">${t(`纪念日`, `기념일`)}</p><span class="seg"><span>${t(`周`, `주`)}</span><span>${t(`月`, `월`)}</span><span class="on">${t(`纪念日`, `기념일`)}</span></span></div>
          <div class="chips"><span class="on">${t(`全部 2`, `전체 2`)}</span><span>${t(`生日 1`, `생일 1`)}</span><span>${t(`纪念日 1`, `기념일 1`)}</span><span>${t(`倒数日 0`, `디데이 0`)}</span></div>
          <div class="av-top"><small>${t(`最近的一个 · 生日`, `가장 가까운 날 · 생일`)}</small><p><b>3</b><span>${t(`天后`, `일 후`)}</span></p><em>${t(`小林 生日`, `수진 생일`)}</em></div>
          <div class="sl"><span>${t(`全部`, `전체`)}</span><b>2</b></div>
          <div class="lc"><div class="rw"><span class="avd"></span><span class="tx"><span class="tt">${t(`小林 生日`, `수진 생일`)}</span><small>${t(`阴历十月十九 · 今年 11月27日`, `음력 10월 19일 · 올해 11월 27일`)}</small></span><span class="av-n">${t(`还有 3 天`, `3일 남음`)}</span></div><div class="rw"><span class="avd b"></span><span class="tx"><span class="tt">${t(`结婚纪念日`, `결혼기념일`)}</span><small>${t(`阳历 · 今年 12月3日`, `양력 · 올해 12월 3일`)}</small></span><span class="av-n">${t(`还有 9 天`, `9일 남음`)}</span></div></div>
${b ? '' : `          <div class="dim"></div>
          <div class="sheet anf"><span class="grab"></span>
            <p class="sh-hd"><span>${t(`取消`, `취소`)}</span><b>${t(`新建纪念日`, `새 기념일`)}</b><span></span></p>
            <div class="fm"><span class="fl">${t(`类型`, `종류`)}</span><span class="seg"><span class="on">${t(`生日`, `생일`)}</span><span>${t(`纪念日`, `기념일`)}</span><span>${t(`倒数日`, `디데이`)}</span></span></div>
            <div class="fm"><span class="fl">${t(`名字`, `이름`)}</span><span class="fv"><span class="ph0">${t(`例如 妈妈生日`, `예: 엄마 생신`)}</span><span class="ty">${t(`妈妈生日`, `엄마 생신`)}</span></span></div>
            <div class="fm"><span class="fl">${t(`阳历还是阴历`, `양력 / 음력`)}</span><span class="seg sl2"><span class="a on">${t(`阳历`, `양력`)}</span><span class="b">${t(`阴历`, `음력`)}</span></span></div>
            <div class="fm"><span class="fl">${t(`日期`, `날짜`)}</span><span class="fv"><span class="d-sol">${t(`4月25日`, `4월 25일`)}</span><span class="d-lun">${t(`阴历三月初九`, `음력 3월 9일`)}</span></span></div>
            <div class="fm col"><span class="fl">${t(`提醒`, `알림`)}</span><span class="chips"><span class="on">${t(`当天`, `당일`)}</span><span class="on">${t(`前一天`, `하루 전`)}</span><span class="r3">${t(`提前 3 天`, `3일 전`)}</span></span></div>
          </div>`}`;
  // ⑦ 今天页 › 今日小运：填生日 → 每日运势
  SCR.fort = (b) => `${TODAY_HD}
          <div class="ft-tile"><b>${t(`今日小运`, `오늘의 운`)}</b><p class="ft-e">${t(`想按八字看每天的运势？`, `사주로 매일 운세를 볼까요?`)}</p><span class="bt">${t(`填生日`, `생일 입력`)}</span></div>
${TODAY_LIST}
${b ? '' : `          <div class="dim"></div>
          <div class="sheet bday"><span class="grab"></span>
            <p class="sh-hd"><span>${t(`取消`, `취소`)}</span><b>${t(`你的生日`, `생일`)}</b><span class="ok">${t(`确定`, `확인`)}</span></p>
            <div class="pk"><p><span>${t(`年`, `년`)}</span><b>1992</b></p><p><span>${t(`月`, `월`)}</span><b>6</b></p><p><span>${t(`日`, `일`)}</span><b>18</b></p><p><span>${t(`时`, `시`)}</span><b class="u">${t(`不知道`, `모름`)}</b></p></div>
            <p class="pk-n">${t(`生日会同步到你的账号，可随时清除 · 仅供娱乐`, `생일은 내 계정에 동기화되며 언제든 지울 수 있어요 · 재미로 보는 운세`)}</p>
          </div>
          <div class="sheet fort">
            <p class="fo-hd"><b>${t(`大树 · 11月24日`, `큰 나무 · 11월 24일`)}</b><span class="x"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></span></p>
            <p class="fo-me">${t(`你的本色是大树：稳当，愿意往上长`, `나의 본성은 큰 나무: 든든하고 위로 자라요`)}</p>
            <p class="stars big s4"><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></p>
            <p class="fo-tip">${t(`踏实做事会有回报，适合收尾。`, `꾸준히 한 만큼 돌아와요. 마무리하기 좋아요.`)}</p>
            <div class="fo-cats">
              <p><b>${t(`工作`, `일`)}</b><span class="stars s4"><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span><span>${t(`适合整理和收尾`, `정리하고 마무리하기 좋아요`)}</span></p>
              <p><b>${t(`感情`, `연애`)}</b><span class="stars s3"><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span><span>${t(`适合约个饭`, `밥 약속 잡기 좋은 날`)}</span></p>
              <p><b>${t(`财运`, `금전`)}</b><span class="stars s3"><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span><span>${t(`适合记记账`, `가계부 정리하기 좋아요`)}</span></p>
              <p><b>${t(`健康`, `건강`)}</b><span class="stars s4"><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg><svg class="st" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span><span>${t(`记得多喝水`, `물 자주 마시기`)}</span></p>
            </div>
            <div class="fo-luck"><p><small>${t(`幸运色`, `행운의 색`)}</small><b><i class="sw0"></i>${t(`森林绿`, `포레스트 그린`)}</b></p><p><small>${t(`幸运数字`, `행운의 숫자`)}</small><b>3</b></p></div>
            <span class="fo-edit">${t(`改生日`, `생일 바꾸기`)}</span>
            <p class="fo-day">${t(`今天是你的收获日 · 仅供娱乐，图个好心情`, `오늘은 나의 수확의 날 · 재미로 보는 운세예요`)}</p>
          </div>`}`;
  // ⑧ 待办：点 H/M/L 换档、左滑露出删除、勾一条
  SCR.todo = () => `          <div class="ap-hd"><div><p class="ap-t">${t(`待办`, `할 일`)}</p><span class="ap-bar"></span><p class="ap-sub">${t(`11月24日 周二 · `, `11월 24일 화요일 · `)}<span class="cnt1"><span class="sw"><i class="a">1</i><i class="b">2</i></span></span>${t(` / 6 完成`, ` / 6 완료`)}</p></div><span class="ap-me">${ic('me')}</span></div>
          <div class="chips"><span class="on">${t(`全部`, `전체`)} <b>6</b></span><span>${t(`工作`, `일`)} <b>2</b></span><span>${t(`生活`, `생활`)} <b>4</b></span></div>
          <div class="sl red"><span>${t(`! 过期`, `! 기한 지남`)}</span><b>1</b></div>
          <div class="lt"><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`交季度报告`, `분기 보고서 제출`)}</span><small class="red">${t(`逾 1 天`, `1일 지남`)}</small></span><span class="hml"><span class="on">H</span><span>M</span><span>L</span></span></div></div>
          <div class="sl"><span>${t(`今天`, `오늘`)}</span><b>2</b></div>
          <div class="lc lc-today"><div class="rw rw-todo r-mom"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`给妈妈打电话`, `엄마한테 전화하기`)}</span><small>${t(`20:00 提醒`, `20:00 알림`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw rw-todo r-train"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`订周末的火车票`, `주말 기차표 예매`)}</span><small>${t(`今天截止`, `오늘 마감`)}</small></span><span class="hml"><span class="h">H</span><span class="on">M</span><span>L</span></span></div></div>
          <div class="sl"><span>${t(`以后`, `나중에`)}</span><b>2</b></div>
          <div class="lc"><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`整理冬天的衣服`, `겨울옷 정리`)}</span><small>${t(`这周`, `이번 주`)}</small></span><span class="hml"><span>H</span><span>M</span><span class="on">L</span></span></div><div class="swp r-book"><span class="sw-del">${t(`删除`, `삭제`)}</span><div class="rw rw-todo sw-face"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`还小林的书`, `수진이 책 돌려주기`)}</span><small>${t(`周五`, `금요일`)}</small></span><span class="hml"><span>H</span><span>M</span><span class="on">L</span></span></div></div></div>
          <div class="sl"><span>${t(`已完成`, `완료`)}</span><b>1</b></div>
          <div class="lc"><div class="rw rw-todo"><span class="ck done"></span><span class="tx strike"><span class="dt"></span><span class="tt">${t(`买猫粮`, `고양이 사료 사기`)}</span></span></div></div>`;
  // ⑨ 待办：拆成小步骤 → 勾完自动完成
  SCR.sub = (b) => `          <div class="ap-hd"><div><p class="ap-t">${t(`待办`, `할 일`)}</p><span class="ap-bar"></span><p class="ap-sub">${t(`11月24日 周二 · `, `11월 24일 화요일 · `)}<span class="cnt4"><span class="sw"><i class="a">1</i><i class="b">2</i></span></span>${t(` / 6 完成`, ` / 6 완료`)}</p></div><span class="ap-me">${ic('me')}</span></div>
          <div class="sl"><span>${t(`今天`, `오늘`)}</span><b>2</b></div>
          <div class="lc"><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`订周末的火车票`, `주말 기차표 예매`)}</span><small>${t(`今天截止`, `오늘 마감`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div><div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`给妈妈打电话`, `엄마한테 전화하기`)}</span><small>${t(`20:00 提醒`, `20:00 알림`)}</small></span><span class="hml"><span>H</span><span class="on">M</span><span>L</span></span></div></div>
          <div class="sl"><span>${t(`以后`, `나중에`)}</span><b>2</b></div>
          <div class="lc"><div class="rw rw-todo r-wint"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`整理冬天的衣服`, `겨울옷 정리`)}</span><small>${t(`这周`, `이번 주`)}</small></span><span class="prog"><span class="sw2"><span class="p0">1/2</span><span class="p1">1/3</span><span class="p2">2/3</span><span class="p3">3/3</span></span></span><span class="hml"><span>H</span><span>M</span><span class="on">L</span></span></div>
            <div class="subs"><p class="sbr dn sb1"><span class="ck done"></span><span class="tt">${t(`大衣送去干洗`, `코트 드라이클리닝 맡기기`)}</span></p><p class="sbr sb2"><span class="ck"></span><span class="tt">${t(`毛衣叠好收进柜子`, `스웨터 개서 옷장에 넣기`)}</span></p><p class="sbr sb3"><span class="ck"></span><span class="tt">${t(`买两个收纳箱`, `수납함 두 개 사기`)}</span></p></div>
            <div class="rw rw-todo"><span class="ck"></span><span class="tx"><span class="dt"></span><span class="tt">${t(`还小林的书`, `수진이 책 돌려주기`)}</span><small>${t(`周五`, `금요일`)}</small></span><span class="hml"><span>H</span><span>M</span><span class="on">L</span></span></div></div>
${b ? '' : `          <div class="toast"><span>${t(`全部完成，已完成这条待办`, `모두 완료해서 할 일을 완료했어요`)}</span></div>
          <div class="dim"></div>
          <div class="sheet ed"><span class="grab"></span>
            <p class="ed-t">${t(`整理冬天的衣服`, `겨울옷 정리`)}</p>
            <div class="ed-row"><span>${t(`优先级`, `우선순위`)}</span><span class="seg"><span>${t(`高`, `높음`)}</span><span>${t(`中`, `보통`)}</span><span class="on">${t(`低`, `낮음`)}</span></span></div>
            <p class="ed-sec">${t(`子任务`, `하위 할 일`)}</p>
            <p class="sbr dn"><span class="ck done"></span><span class="tt">${t(`大衣送去干洗`, `코트 드라이클리닝 맡기기`)}</span></p>
            <p class="sbr"><span class="ck"></span><span class="tt">${t(`毛衣叠好收进柜子`, `스웨터 개서 옷장에 넣기`)}</span></p>
            <p class="sbr ed-s3"><span class="ck"></span><span class="ty">${t(`买两个收纳箱`, `수납함 두 개 사기`)}</span></p>
            <span class="ed-add">${ic('plus')}${t(`拆成小步骤`, `작은 단계로 나누기`)}</span>
          </div>`}`;
  // ⑩ 随手记：记一句，AI 贴上分类
  /** 随手记那一屏的几块（隐私节手机里随手记那一层用 hd、chips、vrow、nts、inp；alt = 记完以后的条数） */
  const NOTE = {
    hd: (alt) => `          <div class="ap-hd"><div><p class="ap-t">${t(`随手记`, `메모`)}</p><span class="ap-bar"></span><p class="ap-sub">${t(`11月24日 周二 · 共 `, `11월 24일 화요일 · 모두 `)}<span class="cnt2"><span class="sw"><i class="a">4</i><i class="b">5</i></span></span>${t(` 条`, `개`)}</p></div><span class="ap-me">${ic('me')}</span></div>`.replace('class="cnt2"', alt ? 'class="cnt2 alt"' : 'class="cnt2"'),
    chips: (alt) => `          <div class="chips"><span class="on">${t(`全部`, `전체`)} <b class="cnt3"><span class="sw"><i class="a">4</i><i class="b">5</i></span></b></span><span><i class="cat-dot"></i>${t(`地方`, `장소`)}</span><span><i class="cat-dot c1"></i>${t(`购物`, `쇼핑`)}</span><span><i class="cat-dot c2"></i>${t(`灵感`, `아이디어`)}</span><span><i class="cat-dot c3"></i>${t(`健康`, `건강`)}</span><span><i class="cat-dot c4"></i>${t(`朋友`, `친구`)}</span></div>`.replace('class="cnt3"', alt ? 'class="cnt3 alt"' : 'class="cnt3"'),
    vrow: `          <div class="vrow"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M6 10.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z"/></svg><b>${t(`隐私记`, `비밀 메모`)}</b><small>${t(`已上锁 · 输入密码解锁 ›`, `잠김 · 비밀번호로 열기 ›`)}</small></div>`,
    nts: `          <div class="nts"><div class="col1"><div class="nt pic new"><span class="nt-cv cv-bake"></span><p>${t(`楼下新开的面包店，周末去试试`, `아래층 새 빵집, 주말에 가 보기`)}</p><span class="nt-ft tag"><span class="cat">${t(`地方`, `장소`)}</span><span class="aib">AI</span></span></div><div class="nt"><p>${t(`新项目的名字可以叫“晴天”`, `새 프로젝트 이름은 ‘맑음’ 어때`)}</p><span class="nt-ft"><span class="cat c2">${t(`灵感`, `아이디어`)}</span></span></div><div class="nt"><p>${t(`小林说喜欢那本旧书的封面`, `수진이가 그 헌책 표지가 좋대`)}</p><span class="nt-ft"><span class="cat c4">${t(`朋友`, `친구`)}</span></span></div></div>
            <div><div class="nt pic"><span class="nt-cv cv-cafe"><b>+1</b></span><p>${t(`周末想去的咖啡馆：河边那家，带上电脑`, `주말에 갈 카페: 강변에 있는 곳, 노트북 챙기기`)}</p><span class="nt-ft"><span class="cat">${t(`地方`, `장소`)}</span></span></div><div class="nt"><p>${t(`体检报告周四出，记得去拿`, `건강검진 결과 목요일에 나옴, 받으러 가기`)}</p><span class="nt-ft"><span class="cat c3">${t(`健康`, `건강`)}</span></span></div></div></div>`,
    inp: `          <div class="nt-in"><span class="nt-f"><span class="ph0">${t(`想到什么，记一句…`, `떠오른 걸 한 줄 적기…`)}</span><span class="ty">${t(`楼下新开的面包店，周末去试试`, `아래층 새 빵집, 주말에 가 보기`)}</span></span><span class="nt-img"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l5-4.5 4 3.5 2.5-2 3.5 3"/></svg></span><span class="nt-add">${t(`记下`, `적기`)}</span></div>`,
  };
  SCR.note = (b) => `${NOTE.hd()}
${NOTE.chips()}
${NOTE.vrow}
${NOTE.nts}
${b ? '' : `          <div class="nt-pend"><span class="nt-pi cv-bake"><b>×</b></span></div>`}
${NOTE.inp}
${b ? '' : `          <div class="dim"></div>
          <div class="sheet pk-s"><span class="grab"></span><p class="sh-hd"><span>${t(`取消`, `취소`)}</span><b>${t(`照片`, `사진`)}</b><span></span></p><div class="pk-g"><i class="cv-book"></i><i class="cv-p1"></i><i class="cv-cafe"></i><i class="cv-bake pk-on"></i><i class="cv-p2"></i><i class="photo"></i><i class="cv-p3"></i><i class="cv-p4"></i><i class="cv-p2"></i></div></div>`}`;
  // ⑪ 隐私记：输入密码解锁
  SCR.vault = () => `          <p class="vt-nav"><span>${ic('left')}${t(`随手记`, `메모`)}</span><b><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M6 10.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z"/></svg>${t(`隐私记`, `비밀 메모`)}</b><span></span></p>
          <div class="vt-lk"><span class="vt-big"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M6 10.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z"/></svg></span><b>${t(`隐私记已上锁`, `비밀 메모가 잠겨 있어요`)}</b><span>${t(`里面有 3 条`, `3개가 들어 있어요`)}</span><span class="vbtn vb1">${t(`输入密码`, `비밀번호 입력`)}</span><span class="vbtn vb2"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1 3.6 1 5 0"/></svg>${t(`用 Face ID 解锁`, `Face ID로 잠금 해제`)}</span></div>
          <div class="vt-pin"><b>${t(`输入隐私记密码`, `비밀 메모 비밀번호를 입력하세요`)}</b><p class="pdots"><i></i><i></i><i></i><i></i></p><div class="kp"><span class="k1">1</span><span class="k2">2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span class="k9">9</span><span class="e"></span><span>0</span><span class="e"></span></div></div>
          <div class="vt-open"><div class="nt pic"><span class="nt-cv cv-book"></span><p>${t(`给小林的生日礼物：那本旧书的新版`, `수진 생일 선물: 그 헌책의 새 판`)}</p></div><div class="nt"><p>${t(`下个月的旅行预算`, `다음 달 여행 예산`)}</p></div><div class="nt"><p>${t(`想对自己说的话`, `나에게 하고 싶은 말`)}</p></div></div>`;
  // ⑯ 四个主页面：左边缘往右划切下一个页签，右边缘往左划进设置（照 src/app/tab-swipe.ts、motion/blur-swap.ts、motion/page-swap.ts）
  SCR.swipe = () => `          <div class="sp sp0 s-voice">${SCR.voice(true)}</div><div class="sp sp1 s-week">${SCR.week(true)}</div><div class="sp sp2 s-todo">${SCR.todo(true)}</div><div class="sp sp3 s-note">${SCR.note(true)}</div>
          <div class="sp sp-set"><p class="st-nav">${ic('left')}${t(`今天`, `오늘`)}</p><p class="st-t">${t(`设置`, `설정`)}</p><p class="st-sec">${t(`常用`, `기본 설정`)}</p><div class="card"><div class="row"><span>${t(`皮肤`, `테마`)}</span><span class="v">${t(`柠檬黄`, `레몬 옐로`)}</span>${ic('right')}</div><div class="row"><span>${t(`界面语言`, `앱 언어`)}</span><span class="v">${t(`中文`, `한국어`)}</span>${ic('right')}</div><div class="row"><span>${t(`字体`, `글꼴`)}</span><span class="v">${t(`系统字体（默认）`, `시스템 글꼴(기본)`)}</span>${ic('right')}</div><div class="row"><span>${t(`提醒与通知`, `알림`)}</span>${ic('right')}</div></div></div>
          <i class="edge-l"></i><i class="edge-r"></i>`;
  // ⑮ 设置 › 吉祥物：7 个轮流点一遍（照 features/mascot/ui/MascotSettings、MascotPreview）
  SCR.masc = () => `          <p class="st-nav">${ic('left')}${t(`设置`, `설정`)}</p>
          <p class="st-t">${t(`吉祥物`, `마스코트`)}</p>
          <div class="mpv"><span class="mq">${SITE_MASCOT_IDS.map((id) => `<i class="mx mi mi-${id}"></i>`).join('')}</span></div>
          <div class="card mopt"><div class="frow mo0"><span class="fn">${t(`米粒`, `쌀알`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo1"><span class="fn">${t(`小黑猫`, `검은 고양이`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo2"><span class="fn">${t(`光球`, `빛 구슬`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo3"><span class="fn">${t(`Meeples 一家`, `Meeples 가족`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo4"><span class="fn">${t(`跟随小人`, `따라보는 친구`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo5"><span class="fn">${t(`Bob`, `Bob`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow mo6"><span class="fn">${t(`猫机器人`, `로봇 고양이`)}</span><span class="chk">${ic('todo')}</span></div></div>`;
  // ⑫ 设置 › 字体
  SCR.font = () => `          <p class="st-nav">${ic('left')}${t(`设置`, `설정`)}</p>
          <p class="st-t">${t(`字体`, `글꼴`)}</p>
          <div class="card fprev"><p>${t(`说一句就记下`, `말 한마디면 기록 끝`)}</p><p>${t(`明天下午三点和小金开会`, `내일 오후 세 시에 김 대리랑 회의`)}</p></div>
          <div class="card mt-12"><div class="frow f0"><span class="fn">${t(`系统字体（默认）`, `시스템 글꼴(기본)`)}</span><span class="chk">${ic('todo')}</span></div><div class="frow f1"><span class="fn">${t(`细线黑`, `가는 고딕`)}</span><small>${t(`下载中 60%`, `내려받는 중 60%`)}</small><span class="chk">${ic('todo')}</span></div><div class="frow f2"><span class="fn">${t(`悠哉体`, `유자이체`)}</span><small>${t(`下载中 60%`, `내려받는 중 60%`)}</small><span class="chk">${ic('todo')}</span></div><div class="frow f3"><span class="fn">${t(`文楷`, `원카이`)}</span><small>${t(`下载中 60%`, `내려받는 중 60%`)}</small><span class="chk">${ic('todo')}</span></div></div>
          <p class="st-note">${t(`选中才下载，下载好之前先用系统字体；每台设备各下各的。`, `고를 때만 내려받고, 다 받기 전에는 시스템 글꼴을 써요. 기기마다 따로 받아요.`)}</p>`;
  // ⑬ 设置 › 账号：更换头像
  SCR.av = (b) => `          <p class="st-nav">${ic('left')}${t(`设置`, `설정`)}</p>
          <p class="st-t">${t(`账号`, `계정`)}</p>
          <div class="card avc"><span class="avt">${ic('me')}<i class="photo"></i></span><p class="avl">${t(`头像`, `프로필 사진`)}</p><div class="avb"><span class="b1">${t(`更换头像`, `사진 바꾸기`)}</span><span class="b2">${t(`去掉头像`, `사진 지우기`)}</span></div><p class="st-note">${t(`只有你自己看得到，各台设备同步显示`, `나만 볼 수 있어요. 바꾸면 모든 기기에 표시돼요`)}</p></div>
${b ? '' : `          <div class="dim"></div>
          <div class="sheet crop">
            <p class="sh-hd"><span>${t(`取消`, `취소`)}</span><b>${t(`挪一挪、缩放一下`, `위치와 크기 맞추기`)}</b><span class="ok">${t(`用这张`, `이 사진으로`)}</span></p>
            <div class="cr-box"><div class="cr-img"><i class="photo"></i></div><span class="cr-ring"></span></div>
            <div class="cr-sl"><span>${t(`缩放`, `크기`)}</span><span class="trk2"><b class="kn"></b></span></div>
          </div>`}`;
  // ⑭ 设置首页：界面语言 中文 ⇄ 한국어（两份文字直接写）
  SCR.lang = () => `          <div class="lay L-zh" lang="zh-Hans"><p class="st-nav">${ic('left')}今天</p><p class="st-t">设置</p><p class="st-sec">常用</p><div class="card"><div class="row"><span>皮肤</span><span class="v">柠檬黄</span>${ic('right')}</div><div class="row r-lang"><span>界面语言</span><span class="v">中文</span>${ic('right')}</div><div class="row"><span>字体</span><span class="v">系统字体（默认）</span>${ic('right')}</div><div class="row"><span>提醒与通知</span>${ic('right')}</div></div><p class="st-note">提醒和邮件也会改用这种语言。</p></div>
          <div class="lay L-ko" lang="ko"><p class="st-nav">${ic('left')}오늘</p><p class="st-t">설정</p><p class="st-sec">기본 설정</p><div class="card"><div class="row"><span>테마</span><span class="v">레몬 옐로</span>${ic('right')}</div><div class="row r-lang"><span>앱 언어</span><span class="v">한국어</span>${ic('right')}</div><div class="row"><span>글꼴</span><span class="v">시스템 글꼴(기본)</span>${ic('right')}</div><div class="row"><span>알림</span>${ic('right')}</div></div><p class="st-note">알림과 메일도 이 언어로 보내 드려요.</p></div>
          <div class="lpick"><p class="op op-zh" lang="zh-Hans">中文${ic('todo')}</p><p class="op op-ko" lang="ko">한국어${ic('todo')}</p></div>`;
  /** 样机里的每一屏：[名字, 类名, 底栏第几个亮（-1 = 不显示底栏）]，顺序就是页面上的顺序 */
  const PG = [
    ['type', 'pg s-type', '0'],
    ['voice', 'pg s-voice cv', '0'],
    ['sum', 'pg s-sum cv', '0'],
    ['find', 'pg s-find cv', '-1'],
    ['chat', 'pg s-chat cv', '-1'],
    ['aip', 'pg s-aip cv', '-1'],
    ['week', 'pg s-week cv', '1'],
    ['month', 'pg s-month cv', '1'],
    ['anv', 'pg s-anv cv', '1'],
    ['fort', 'pg s-fort cv', '0'],
    ['todo', 'pg s-todo cv', '2'],
    ['sub', 'pg s-sub cv', '2'],
    ['note', 'pg s-note cv', '3'],
    ['vault', 'pg s-vault cv', '-1'],
    ['swipe', 'pg s-swipe cv', '0'],
    ['masc', 'pg s-masc cv', '-1'],
    ['font', 'pg s-font cv', '-1'],
    ['av', 'pg s-av cv', '-1'],
    ['lang', 'pg s-lang cv', '-1'],
  ];
  // 多端那一节（页面模板里 .dvs）：手机放演示手机的“今天”；网页版、Windows 窗口是演示页网页版“今天”“随手记”的真截图
  // site/home/dev-web-*.webp、dev-win-*.webp（第十轮，负责人 11-26 选“两个窗口都换成真界面”），按页面语言各用一套
  /** 一屏的外层 div */
  const pg = (n) => { const [, c, t] = PG.find((q) => q[0] === n); return `        <div class="${c}" data-s="${n}" data-tab="${t}">\n${SCR[n]()}\n        </div>`; };
  /** 底栏四个页签的图标和字、“＋”的图标 */
  const TABS = [
    `${ic('today')}<span>${t(`今天`, `오늘`)}</span>`,
    `${ic('cal')}<span>${t(`日历`, `캘린더`)}</span>`,
    `${ic('todo')}<span>${t(`待办`, `할 일`)}</span>`,
    `${ic('notes')}<span>${t(`随手记`, `메모`)}</span>`,
  ];
  const FAB = `${ic('plus')}`;
  /** 一台样机：cls 是外层类名，inner 是中间那几屏（底栏第一个亮，和真 App 进来时一样） */
  const phone = (cls, inner) => `      <div class="${cls}"><span class="ph-k k-act"></span><span class="ph-k k-vu"></span><span class="ph-k k-vd"></span><span class="ph-k k-pw"></span><div class="ph-bz"><div class="scr">
        <div class="sb"><span>10:20</span><svg class="sb-ic" viewBox="0 0 76 13"><rect x="0" y="8.6" width="3.2" height="4.4" rx="1"/><rect x="4.6" y="6.2" width="3.2" height="6.8" rx="1"/><rect x="9.2" y="3.6" width="3.2" height="9.4" rx="1"/><rect x="13.8" y="1" width="3.2" height="12" rx="1"/><path class="sb-wifi" d="M23.2 4.9a10.4 10.4 0 0 1 13.6 0M25.8 7.8a6.6 6.6 0 0 1 8.4 0"/><circle cx="30" cy="11" r="1.8"/><rect class="sb-bat" x="45.5" y=".5" width="25" height="12" rx="3.8"/><rect x="47.5" y="2.5" width="17.5" height="8" rx="2"/><path class="sb-cap" d="M72 4.4v4.2c.9-.3 1.5-1.1 1.5-2.1s-.6-1.8-1.5-2.1z"/></svg></div>
        <span class="di"></span>
${inner}
        <div class="tb"><span class="drop"></span>${TABS.map((t, i) => `<span${i === 0 ? ' class="on"' : ''}>${t}</span>`).join('')}</div>
        <span class="fab">${FAB}</span>
        <span class="fg"><i class="fg-d"></i><i class="fg-r"></i><i class="fg-h"></i><i class="fg-h"></i></span>
        <span class="hi"></span>
      </div></div></div>`;
  /** 隐私节的手机：隐私记解锁那一屏（照 src/features/vault/ui 的 Unlock.tsx、Pin.tsx、VaultPage.tsx；文案照 vault/i18n），底下一层是记完的随手记 */
  const VSAFE = `  <div class="pg s-vs" data-s="vsafe" data-tab="3">
    <div class="vs-n s-note added tagon">${NOTE.hd(true)}${NOTE.chips(true)}${NOTE.vrow}${NOTE.nts}${NOTE.inp}</div>
    <div class="vs-v">
      <div class="vs-list">
        <p class="vs-top"><span class="vs-back">${ic('left')}${t(`随手记`, `메모`)}</span><b class="vs-h"><svg class="vs-lk" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z"/></svg>${t(`隐私记`, `비밀 메모`)}</b><span class="vs-end"><span class="vs-chip">${t(`立即锁上`, `지금 잠그기`)}</span></span></p>
        <p class="vs-hint"><svg class="vs-ol" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg><span>${t(`已解锁 · 离开 1 分钟自动锁上 · 这里记的只进隐私记`, `잠금 해제됨 · 떠나고 1분 뒤 자동 잠금 · 여기서 적은 건 비밀 메모에만 들어가요`)}</span></p>
        <div class="nts"><div><div class="nt pic"><span class="nt-cv cv-book"></span><p>${t(`给小林的生日礼物：那本旧书的新版`, `수진 생일 선물: 그 헌책의 새 판`)}</p></div></div><div><div class="nt"><p>${t(`下个月的旅行预算`, `다음 달 여행 예산`)}</p></div><div class="nt"><p>${t(`想对自己说的话`, `나에게 하고 싶은 말`)}</p></div></div></div>
      </div>
      <div class="vs-lock">
        <p class="vs-top"><span class="vs-back">${ic('left')}${t(`随手记`, `메모`)}</span><b class="vs-h"><svg class="vs-lk" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z"/></svg>${t(`隐私记`, `비밀 메모`)}</b><span></span></p>
        <div class="vs-body"><span class="vs-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><rect x="5" y="10.5" width="14" height="10" rx="2.5"/></svg></span><b>${t(`隐私记已上锁`, `비밀 메모가 잠겨 있어요`)}</b><span class="vs-sub">${t(`里面有 3 条`, `3개가 들어 있어요`)}</span>
          <span class="vs-btns"><span class="vs-b1">${t(`输入密码`, `비밀번호 입력`)}</span><span class="vs-b2">${t(`用 Face ID 解锁`, `Face ID로 잠금 해제`)}</span></span></div>
      </div>
    </div>
    <div class="vs-pin">
      <p class="vs-top"><span class="vs-back">${ic('left')}${t(`随手记`, `메모`)}</span><span></span><span class="vs-end">${t(`取消`, `취소`)}</span></p>
      <div class="vs-pinb"><svg class="vs-lkbig" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z"/></svg><b>${t(`输入隐私记密码`, `비밀 메모 비밀번호를 입력하세요`)}</b><span class="vs-sub">${t(`里面有 3 条`, `3개가 들어 있어요`)}</span>
        <p class="vs-dots"><i></i><i></i><i></i><i></i></p><p class="vs-err"></p>
        <div class="vs-pad"><span class="vs-k1">1</span><span class="vs-k2">2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span class="vs-k9">9</span><span class="gap"></span><span>0</span><span class="del">⌫</span></div>
        <p class="vs-foot">${t(`忘记密码？用登录邮箱重设`, `비밀번호를 잊으셨나요? 로그인 이메일로 다시 정하기`)}</p></div>
    </div>
  </div>`;

  return `${k.head(l, { ...META[l], path: '', home: true })}
<body>
<main>
<section class="film" id="film" aria-label="${x('柠檬记能做什么', '레모로 할 수 있는 일')}">
  <div class="sr-film">${GLAB.map(([zh, ko], g) => `<section><h2>${t(zh, ko)}</h2>${CAPS.filter((c) => c[0] === g).map(([, h, hk, p, pk]) => `<h3>${t(h, hk)}</h3><p>${t(p, pk)}</p>`).join('')}</section>`).join('')}</div>
  <div class="pin">
    <div class="bg"></div>
    <span class="xb" aria-hidden="true"></span>
    <span class="xw" aria-hidden="true"></span>
    <span class="xp" aria-hidden="true"></span>
    <span class="glow"></span>
    <canvas class="pc" aria-hidden="true"></canvas>
    <div class="frame">
      <header class="hero">
        <div class="nav">
          <a class="logo" href="/${l}/"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>${t(`柠檬记`, `레모`)}</a>
          <nav class="links" aria-label="${x('页内', '페이지 안')}"><a href="#dev">${t(`多端`, `여러 기기`)}</a><a href="#safe">${t(`隐私`, `개인정보`)}</a><a href="#faq">${t(`常见问题`, `자주 묻는 질문`)}</a><a href="/${l}/demo">${t(`演示`, `데모`)}</a></nav>
          <nav class="lsw" aria-label="${x('语言', '언어')}">${langSw}</nav>
        </div>
        <div class="hero-tx">
          <h1>${t(`<span class="l">说一句</span><span class="l">就记下</span>`, `<span class="l">말 한마디면</span><span class="l">기록 끝</span>`)}</h1>
          <div class="hero-foot">
            <p class="lede">${t(`中韩双语的日程、待办和随手记。说一句或打一句，AI 帮你记好，到点提醒你。`, `한국어·중국어로 쓰는 일정·할 일·메모 앱. 말하거나 적으면 AI가 정리하고 제때 알려 줘요.`)}</p>
            <p class="alt-t">${t(`<span lang="ko">말 한마디면 기록 끝</span>`, `<span lang="zh-Hans">说一句就记下</span>`)}</p>
            <p class="cta"><a class="btn btn-k" href="/${l}/demo">${t(`免注册，看演示`, `가입 없이 데모 보기`)}</a><a class="btn btn-w" href="/app/">${t(`有邀请码？开始使用`, `초대 코드가 있으면 시작하기`)}</a></p>
            <p class="cta-note"><a href="#faq-invite" class="to-inv">${t(`没有邀请码？看看怎么拿到`, `초대 코드가 없나요? 받는 방법 보기`)}</a></p>
          </div>
        </div>
      </header>

${GT.map(([zh, ko], g) => `      <h2 class="gt" data-g="${g}" aria-hidden="true">${t(zh, ko)}</h2>`).join('\n')}
${GLAB.map(([zh, ko], g) => `      <p class="glab" data-g="${g}" aria-hidden="true">${t(zh, ko)}</p>`).join('\n')}

${CAPS.map(([g, h, hk, p, pk]) => `      <div class="cap" data-g="${g}" aria-hidden="true"><div class="cap-tx"><h3>${t(h, hk)}</h3><p>${t(p, pk)}</p></div></div>`).join('\n')}
    </div>

    <div class="rig-box" aria-hidden="true">
${phone('ph rig', PG.map(([n]) => pg(n)).join('\n\n'))}
    </div>
  </div>
</section>
<div class="static"></div>

<section class="sec dev" id="dev" aria-labelledby="dev-h">
  <div class="sec-bg"></div>
  <h2 id="dev-h" class="rv">${t(`手机、网页、电脑，<br>同一份记录`, `휴대폰, 웹, PC,<br>같은 기록`)}</h2>
  <div class="dvs rv">
    <div class="dvw dv-ph" aria-hidden="true">${phone('ph nox', pg('type'))}</div>
    <div class="dvw dv-web"><p class="dvw-bar" aria-hidden="true"><i></i><i></i><i></i><span>lemomemo.com/app</span></p><img class="dvw-im" src="/home/dev-web-${l}.webp" width="1120" height="700" alt="${x('网页版的“今天”页：今天的日程、待办、本周概览，右边常开 AI 助手', '웹 버전 ‘오늘’ 화면: 오늘 일정, 할 일, 이번 주 요약, 오른쪽엔 AI 도우미')}" decoding="async"></div>
    <div class="dvw dv-win"><p class="dvw-tt" aria-hidden="true"><span class="mark"><i></i><i></i><i></i></span>${t(`柠檬记`, `레모`)}<svg viewBox="0 0 40 12" aria-hidden="true"><path d="M2 6h8"/><rect x="16" y="1.5" width="8" height="8" rx=".5"/><path d="M31 1.5l7.5 8M38.5 1.5L31 9.5"/></svg></p><img class="dvw-im" src="/home/dev-win-${l}.webp" width="900" height="563" alt="${x('Windows 版的“随手记”页：按分类整理的随手记，右边常开 AI 助手', 'Windows 버전 ‘메모’ 화면: 분류별 메모, 오른쪽엔 AI 도우미')}" decoding="async"></div>
  </div>
  <ul class="devs">
    <li class="rv"><b>${t(`iPhone`, `iPhone`)}</b><span>${t(`添加到主屏幕，能说话记录、能收提醒。`, `홈 화면에 추가하면 말로 기록하고 알림도 받을 수 있어요.`)}</span></li>
    <li class="rv d1"><b>${t(`网页版`, `웹 버전`)}</b><span>${t(`宽屏一眼看全，右边常开 AI 助手。`, `넓은 화면에 한눈에, 오른쪽엔 늘 AI 도우미.`)}</span></li>
    <li class="rv d2"><b>${t(`Windows 版`, `Windows 버전`)}</b><span>${t(`装在电脑上，只能打字记录。`, `PC에 설치해서 타자로 기록해요.`)}</span></li>
  </ul>
</section>

<section class="sec safe" id="safe" aria-labelledby="safe-h">
  <div class="sec-bg"></div>
  <div><h2 id="safe-h" class="rv">${t(`别人看不到<br>你记的`, `다른 사람은<br>내 기록을<br>못 봐요`)}</h2>
    <ul class="safe-l rv d1">
      <li><b class="safe-t">${t(`其他用户看不到你记的东西`, `다른 사용자는 내 기록을 볼 수 없어요`)}</b><small class="safe-s">${t(`数据存在服务器上，运营者在技术上能访问`, `데이터는 서버에 저장되고, 운영자는 기술적으로 접근할 수 있어요`)}</small></li>
      <li class="i"><b class="safe-t">${t(`AI 整理时，内容会交给 AI 服务商`, `AI가 정리하면 내용이 AI 업체로 가요`)}</b><small class="safe-s">${t(`文字、录音、图片、附件和隐私记都会交过去；默认由柠檬记提供，也可以换成你自己的密钥`, `글, 녹음, 사진, 첨부파일, 비밀 메모가 모두 전달돼요. 기본은 레모가 제공하고, 내 키로 바꿀 수도 있어요`)}</small></li>
      <li><b class="safe-t">${t(`隐私记另外上锁`, `비밀 메모는 따로 잠가요`)}</b><small class="safe-s">${t(`要密码或 Face ID 才能打开`, `비밀번호나 Face ID가 있어야 열려요`)}</small></li>
    </ul>
    <a class="btn btn-k btn-s rv d2" href="/${l}/privacy">${t(`读隐私说明`, `개인정보 처리 안내 읽기`)}</a></div>
  <div class="safe-art rv d1" aria-hidden="true"><div class="st-ph safe-ph">${phone('ph', VSAFE)}</div></div>
</section>

<section class="sec faq" id="faq" aria-labelledby="faq-h">
  <div class="sec-bg"></div>
  <h2 id="faq-h" class="rv">${t(`常见问题`, `자주 묻는 질문`)}</h2>
  <div class="qa">
    <details class="rv" id="faq-invite"><summary>${t(`怎么拿到邀请码？`, `초대 코드는 어떻게 받나요?`)}</summary><p>${t(`柠檬记目前只接受邀请，邀请码请向柠檬记的负责人要一个。`, `레모는 현재 초대로만 가입할 수 있어요. 초대 코드는 레모 운영자에게 요청해 주세요.`)}</p></details>
    <details class="rv d1"><summary>${t(`现在免费吗？`, `지금 무료인가요?`)}</summary><p>${t(`目前免费使用。`, `지금은 무료로 쓸 수 있어요.`)}</p></details>
    <details class="rv d2"><summary>${t(`iPhone 怎么装到主屏幕？`, `iPhone 홈 화면에 어떻게 추가하나요?`)}</summary><p>${t(`先点“有邀请码？开始使用”进入柠檬记，<strong>在那一页</strong>用 Safari 的“添加到主屏幕”。主屏幕上显示的名字是“Lemo”。在这个首页上直接添加只会得到一个书签，收不到提醒。`, `먼저 “초대 코드가 있으면 시작하기”를 눌러 레모로 들어간 뒤, <strong>그 페이지에서</strong> Safari의 “홈 화면에 추가”를 사용하세요. 홈 화면에는 “Lemo”로 표시돼요. 이 첫 페이지에서 바로 추가하면 북마크만 생기고 알림을 받을 수 없어요.`)}</p></details>
    <details class="rv d4"><summary>${t(`电脑上能用吗？`, `PC에서도 쓸 수 있나요?`)}</summary><p>${t(`网页版直接打开就能用；也可以<a href="/desktop/">下载 Windows 版</a>（安装包的 SHA-256 随版本公布在下载页）。电脑版只能打字记录，不支持语音。`, `웹 버전은 바로 열어서 쓰면 되고, <a href="/desktop/">Windows 버전을 다운로드</a>해도 돼요(설치 파일의 SHA-256은 버전마다 다운로드 페이지에 공개해요). PC 앱은 타자 입력만 되고 음성은 지원하지 않아요.`)}</p></details>
    <details class="rv d4"><summary>${t(`不用了，能把数据导出、删干净吗？`, `그만 쓸 때 데이터를 내보내고 깨끗이 지울 수 있나요?`)}</summary><p>${t(`能。设置 › 数据 › 导出全部数据，日程、待办、随手记这些文字会存成一个备份文件（照片和附件本身不在里面）。设置 › 账号 › 注销账号：账号先停用 7 天，这期间可以恢复；满 7 天后，记录、照片、附件和服务器上的备份全部删除，不能再找回。`, `네. 설정 › 데이터 › 모든 데이터 내보내기를 누르면 일정, 할 일, 메모 같은 글 기록이 백업 파일 하나로 저장돼요(사진과 첨부파일 자체는 들어가지 않아요). 설정 › 계정 › 회원 탈퇴를 하면 계정이 7일 동안 멈추고, 그동안은 되돌릴 수 있어요. 7일이 지나면 기록, 사진, 첨부파일과 서버 백업이 모두 지워지고 되살릴 수 없어요.`)}</p></details>
    <details class="rv d4"><summary>${t(`在中国大陆能用吗？`, `중국 본토에서도 쓸 수 있나요?`)}</summary><p>${t(`登录验证码发到你的邮箱。`, `로그인 인증 코드는 내 이메일로 보내요.`)}</p></details>
    <details class="rv d4"><summary>${t(`演示里的内容是真的吗？`, `데모 내용은 진짜인가요?`)}</summary><p>${t(`都是编的示例。看演示不用注册，演示里点的、记的都不会保存，刷新就回到原样。`, `모두 지어낸 예시예요. 데모는 가입 없이 볼 수 있고, 데모에서 누르거나 기록한 건 저장되지 않아서 새로고침하면 처음으로 돌아가요.`)}</p></details>
  </div>
</section>

<section class="outro" id="start" aria-labelledby="close-h">
  <div class="opin">
    <div class="close">
      <div class="close-card rv">
        <h2 id="close-h">${t(`说一句<br>就记下`, `말 한마디면<br>기록 끝`)}</h2>
        <p class="cta"><a class="btn btn-k" href="/${l}/demo">${t(`免注册，看演示`, `가입 없이 데모 보기`)}</a><a class="btn btn-w btn-o" href="/app/">${t(`有邀请码？开始使用`, `초대 코드가 있으면 시작하기`)}</a></p>
        <p class="cta-note"><a href="#faq-invite" class="to-inv">${t(`没有邀请码？看看怎么拿到`, `초대 코드가 없나요? 받는 방법 보기`)}</a></p>
      </div>
    </div>
    <p class="ow" aria-hidden="true">${t(`<span class="l">说一句</span><span class="l">就记下</span>`, `<span class="l">말 한마디면</span><span class="l">기록 끝</span>`)}</p>
    <canvas class="cover" aria-hidden="true"></canvas>
  </div>
</section>
</main>
<footer class="foot">
  <a class="logo" href="/${l}/"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>${t(`柠檬记`, `레모`)}</a>
  <nav aria-label="${x('页脚', '바닥글')}"><a href="/${l}/privacy">${t(`隐私说明`, `개인정보 처리 안내`)}</a><a href="/${l}/terms">${t(`使用条款`, `이용약관`)}</a><a href="/desktop/">${t(`下载 Windows 版`, `Windows 버전 다운로드`)}</a></nav>
  <nav class="flang" aria-label="${x('语言', '언어')}">${langSw}</nav>
  <p class="fname">${t(`柠檬记的韩文名叫“레모”，装到主屏幕后显示为“Lemo”，都是同一个 App。`, `레모의 중국어 이름은 ‘柠檬记’이고, 홈 화면에 추가하면 ‘Lemo’로 표시돼요. 모두 같은 앱이에요.`)}</p>
  ${credits(t)}
</footer>
${RIVE_TAGS}
<a class="dock" href="/${l}/demo" aria-label="${x('看演示', '데모 보기')}">${t(`看演示`, `데모 보기`)}</a>
<nav class="rail" aria-label="${x('四组功能', '기능 네 묶음')}"><span class="rail-f"></span><button type="button" aria-label="${x('第 1 组：AI 帮你记，也帮你找', '1번째 묶음: AI가 적어 주고, 찾아 줘요')}"></button><button type="button" aria-label="${x('第 2 组：日程和提醒，都替你记着', '2번째 묶음: 일정과 알림, 다 챙겨 둬요')}"></button><button type="button" aria-label="${x('第 3 组：待办和随手记，分得清清楚楚', '3번째 묶음: 할 일과 메모, 깔끔하게 나눠요')}"></button><button type="button" aria-label="${x('第 4 组：按你的喜好，换个样子', '4번째 묶음: 내 취향대로 바꿔 보세요')}"></button></nav>
</body>
</html>
`;
}
