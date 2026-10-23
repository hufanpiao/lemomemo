// 职责：下载能力的适配器（把页面生成的文件交给用户保存），界面只调 App.platform.download.save({filename, data})。
//       claude.ai 版用 window.claude.use("downloads") 的 save()：会先弹确认，用户同意才保存；拒绝或不可用时 reject，不重试。
//       错误码统一成：declined（用户拒绝）、unavailable（这里不能下载）、rate_limited（已有一个在等确认）、
//       too_large（太大）、format（格式不允许）、failed（其他）。测试页用 tests/mock/mock-download.js 的模拟实现。
//       用哪个实现由 app.js 一处配置（App.BUILD.download，缺省 "claude"）。以后独立服务器版加 "browser"（<a download>）。
// 依赖：platform/index.js
App.platform = App.platform || {};
App.platform.downloads = App.platform.downloads || {};   // 下载适配器工厂：{"claude": fn, "mock": fn}

const MAP = {
  declined:"declined", rate_limited:"rate_limited", too_large:"too_large",
  rejected_extension:"format", extension_not_enabled:"format",
  unavailable:"unavailable", not_granted:"unavailable", capability_disabled:"unavailable", capability_removed:"unavailable",
};
const downloadError = (code, cause) => { const e = new Error("下载：" + code); e.code = code; e.cause = cause; return e; };
App.platform.downloadError = downloadError;

App.platform.downloads["claude"] = function createClaudeDownloads(){
  let cap;   // undefined＝还没取过；null＝这里不能下载
  return {
    async save(req){
      if (cap === undefined) cap = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
      if (!cap) throw downloadError("unavailable");
      try { return await cap.save({filename:req.filename, data:req.data}); }
      catch(e){ throw downloadError(MAP[e && e.code] || (e && e.code ? "failed" : "unavailable"), e); }
    },
  };
};

let impl = null;
App.platform.download = {
  use(name){ const f = App.platform.downloads[name] || App.platform.downloads["claude"]; impl = f(); },
  save(req){ if (!impl) App.platform.download.use("claude"); return impl.save(req); },
};
