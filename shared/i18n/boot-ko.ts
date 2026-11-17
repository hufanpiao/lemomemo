// 公共词典·韩文的“启动兜底”一段（同 boot-zh.ts：App 名、退出屏、出错屏、升级整屏提示，ko.ts 展开引用；审校标记照原样跟着词条走）
import type { bootZh } from './boot-zh.ts';

export const bootKo = {
  'app.name': '레모', // R-106 B1 第一遍已审（10-31）
  'update.tooNew.title': '이 기기의 데이터는 새 버전에서 저장됐어요. 앱을 업데이트해 주세요', // R-106 B1 第一遍已审（10-31），按审校意见 K-07 改过：去掉叠用的“더 최신”，整屏标题短一截
  'update.tooNew.body': '지금 쓰는 버전에서는 이 데이터를 열 수 없어요. 업데이트하면 이어서 쓸 수 있고, 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.update': '업데이트하기', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.refresh': '새로고침', // R-106 B1 第一遍已审（10-29）
  'update.updating': '업데이트 중…', // R-106 B1 第一遍已审（10-29）
  'update.failedReopen': '업데이트하지 못했어요 · 인터넷에 연결한 뒤 다시 시도하고, 그래도 안 되면 레모를 완전히 닫았다가 다시 열어 주세요', // REVIEW(ko) B2-UI-b W6
  'update.stillOld': '이미 최신 버전이에요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.blocked.title': '열려 있는 다른 레모 창이나 탭을 닫아 주세요', // R-106 B1 第一遍已审（10-30）；“창이나 탭”负责人 10-30 定（明早清单第 25 条）；升级本机库被别的标签页挡住的整屏提示（TC-B1-48）
  'update.blocked.body': '다른 창이나 탭에서 아직 이전 버전을 쓰고 있어요. 그 창이나 탭을 닫으면 이 화면이 자동으로 이어서 열려요. 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-31），按审校意见 K-06 改过（接手清单 COPY-1030-sync ③）：补宾语“그 창이나 탭을”、主语“이 화면이”；“창이나 탭”负责人 10-30 定（明早清单第 25 条）；同上
  'app.crashed.title': '앗, 멈췄어요', // R-106 B1 第一遍已审（10-30）；App 顶层出错的整屏兜底（K6-sugg3 ⑥）
  'app.crashed.refresh': '새로고침', // R-106 B1 第一遍已审（10-30）；和 update.tooNew.refresh 统一成 새로고침
  'update.stalled': '새 버전이 아직 준비되지 않았어요 · 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-31）；同 zh：查到新版本但 30 秒内没接管（BANNER-sugg ⑤，10-30）
  'exit.incomplete.title': '로그아웃이 끝나지 않았어요', // REVIEW(ko)；同 zh：exe 里退出时本机会话没删掉（A-1）
  'exit.incomplete.body': '이 컴퓨터의 로그인 정보가 지워지지 않았어요. “다시 시도”를 눌러 한 번 더 지워 주세요. 지워지기 전에는 로그인된 화면으로 돌아가지 않아요.', // REVIEW(ko)
  'exit.incomplete.retry': '다시 시도', // REVIEW(ko)
  'exit.incomplete.busy': '지우는 중…', // REVIEW(ko)
  'exit.incomplete.failed': '아직 지우지 못했어요. 잠시 후 다시 시도하거나 레모를 다시 열어 주세요', // REVIEW(ko)
  'exit.unavailable.title': '이 컴퓨터의 로그인 정보를 읽지 못했어요', // REVIEW(ko)；同 zh：installDesktopSession 失败（代码审查建议 4）
  'exit.unavailable.body': '레모를 다시 열어 주세요. 그래도 안 되면 컴퓨터를 다시 시작한 뒤 시도해 주세요.', // REVIEW(ko)
  'exit.unavailable.reopen': '다시 열기', // REVIEW(ko)
} satisfies Record<keyof typeof bootZh, string>;
