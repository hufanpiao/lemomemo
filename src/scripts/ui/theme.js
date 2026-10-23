// 职责：深色 / 浅色切换（ADR-008）。抬头右上角的圆形按钮弹出黑色胶囊三选一（跟随系统 / 浅色 / 深色），浮层盖在内容上；
//       选完立即生效、停 300ms 后收起；点外面或按 Esc 关闭，焦点回到按钮；方向键在三项间移动。
//       两个维度：<html data-theme="light|dark">（跟随系统时不设）和 <html data-skin="bento">；偏好存 pv-theme、pv-skin。
//       切换时给 <html> 临时加 .theme-anim，让颜色过渡 200ms（减少动效时不过渡）。
// 依赖：core/const.js、platform/prefs.js、ui/dom.js
App.ui = App.ui || {};

const C = App.core.C;
const prefs = App.platform.prefs;
const {$} = App.ui.dom;

const NAMES = {system:"跟随系统", light:"浅色", dark:"深色"};
const ICONS = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
};
let mode = "system", closeTimer = null, animTimer = null;
const root = () => document.documentElement;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const valid = (v, list, dflt) => list.includes(v) ? v : dflt;

function apply(m, animate){
  mode = valid(m, C.THEMES, "system");
  if (animate && !reduced()){
    root().classList.add("theme-anim");
    clearTimeout(animTimer); animTimer = setTimeout(() => root().classList.remove("theme-anim"), C.THEME_FADE_MS + 50);
  }
  if (mode === "system") root().removeAttribute("data-theme"); else root().setAttribute("data-theme", mode);
  const btn = $("theme-btn");
  if (btn){ btn.innerHTML = ICONS[mode]; btn.setAttribute("aria-label", "外观：" + NAMES[mode]); }
  document.querySelectorAll("#theme-pick [role=radio]").forEach(r => {
    const on = r.dataset.mode === mode;
    r.setAttribute("aria-checked", on ? "true" : "false");
    r.tabIndex = on ? 0 : -1;
  });
}
const isOpen = () => !$("theme-pick").hidden;
function open(){
  clearTimeout(closeTimer);
  const pick = $("theme-pick");
  pick.hidden = false; pick.classList.remove("on");
  $("theme-btn").setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => { pick.classList.add("on"); (pick.querySelector("[aria-checked=true]") || pick.querySelector("[role=radio]")).focus(); });
}
function close(focusBtn){
  clearTimeout(closeTimer);
  const pick = $("theme-pick");
  if (pick.hidden) return;
  pick.classList.remove("on");
  $("theme-btn").setAttribute("aria-expanded", "false");
  closeTimer = setTimeout(() => { pick.hidden = true; }, reduced() ? 0 : C.THEME_CLOSE_MS);
  if (focusBtn) $("theme-btn").focus();
}
function choose(m){
  apply(m, true);
  prefs.set(prefs.KEYS.theme, mode);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => close(true), C.THEME_HOLD_MS);
}
function onKey(e){
  if (!isOpen()) return;
  if (e.key === "Escape"){ e.preventDefault(); close(true); return; }
  const radios = [...document.querySelectorAll("#theme-pick [role=radio]")];
  const i = radios.indexOf(document.activeElement);
  if (i < 0) return;
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (step){ e.preventDefault(); radios[(i + step + radios.length) % radios.length].focus(); }
}

function init(){
  root().setAttribute("data-skin", valid(prefs.get(prefs.KEYS.skin, "bento"), C.SKINS, "bento"));
  apply(prefs.get(prefs.KEYS.theme, "system"), false);
  $("theme-btn").onclick = e => { e.stopPropagation(); isOpen() ? close(true) : open(); };
  document.querySelectorAll("#theme-pick [role=radio]").forEach(r => { r.onclick = e => { e.stopPropagation(); choose(r.dataset.mode); }; });
  document.addEventListener("click", e => { if (isOpen() && !$("theme-pick").contains(e.target)) close(true); });
  document.addEventListener("keydown", onKey);
}

App.ui.theme = {init, apply, open, close, current: () => mode};
