// 职责：模拟下载适配器 "mock"（测试页用）：不真的弹保存框，把文件记进 globalThis.plannerDownloads（最后一个也放在
//       globalThis.plannerLastDownload），返回 {status:"saved"}。预先设 globalThis.plannerDownloadFail = "declined" 等可模拟失败。
// 依赖：platform/download.js（注册表 App.platform.downloads、downloadError）。由 build.py 拼进 dist/test.html 的脚本包（在 app.js 之前）。
App.platform = App.platform || {};
App.platform.downloads = App.platform.downloads || {};

App.platform.downloads["mock"] = function createMockDownloads(){
  const g = globalThis;
  return {
    async save(req){
      if (g.plannerDownloadFail) throw App.platform.downloadError(g.plannerDownloadFail);
      if (!req || typeof req.filename !== "string" || !req.data) throw App.platform.downloadError("failed");
      const file = {filename:req.filename, data:req.data, size: typeof req.data === "string" ? req.data.length : 0};
      (g.plannerDownloads = g.plannerDownloads || []).push(file);
      g.plannerLastDownload = file;
      return {status:"saved"};
    },
  };
};
