// exe 快速记录小窗口的入口 /app/desktop/quick-add.html（vite.quick-add.config.ts 单独打包；打进安装包时 stage-web.mjs 的
// pageCsp('quick-add') 给这页注入 meta CSP：只走 IPC，不连网络、不嵌 iframe、不许内联样式）。
// 只带输入框这点代码：语言按本机选过的（pv-locale）→ 设备语言；皮肤、深浅色跟这台设备上次用的（platform/look.ts 一引入就套上）。
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/skins/glass.css';
import './quick-add.css';
import { LOCALE_STORAGE_KEY, pickLocale, toUiLocale } from '../../shared/i18n/pick-locale.ts';
import { quickAddKo } from '../../shared/i18n/quick-add-ko.ts';
import { quickAddZh } from '../../shared/i18n/quick-add-zh.ts';
import { hideQuickAdd, QUICK_ADD_MAX_CHARS, submitQuickAdd } from '../platform/desktop-quick-add.ts';
import '../platform/look.ts';
import { wireQuickAdd } from './quick-add-form.ts';

function savedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

const lang = pickLocale(savedLocale(), navigator.languages);
const words = lang === 'ko' ? quickAddKo : quickAddZh;
document.documentElement.lang = toUiLocale(lang);

const input = document.getElementById('quick-input');
const hint = document.getElementById('quick-hint');
const status = document.getElementById('quick-status');
if (!(input instanceof HTMLInputElement) || !hint || !status) throw new Error('quick_add_dom_missing');

input.placeholder = words.placeholder;
input.setAttribute('aria-label', words.label);
hint.textContent = words.hint;

wireQuickAdd({
  win: window,
  input,
  status,
  texts: { failed: words.failed, full: words.full, tooLong: words.tooLong },
  api: { submit: (text) => submitQuickAdd(text), hide: () => hideQuickAdd() },
  maxChars: QUICK_ADD_MAX_CHARS,
});
