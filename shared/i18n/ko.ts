// 公共词典·韩文（初稿，待韩文翻译和审校，R-106）
// satisfies Record<MsgKey, string>：少一个键、多一个键都编译不过（架构 2.4）
import type { SharedMsgKey } from './i18n.ts';

export const ko = {
  'app.name': '레모',
  'common.ok': '확인',
  'common.cancel': '취소',
  'common.retry': '다시 시도',
  'common.close': '닫기',
  'error.unknown': '문제가 생겼어요. 잠시 후 다시 시도해 주세요',
  'error.offline': '지금 인터넷에 연결되어 있지 않아요',
  'feature.off': '이 기능은 아직 사용할 수 없어요', // R-106 B1 第一遍已审（10-29）
  'update.required': '동기화를 계속하려면 업데이트가 필요해요 · 기록한 내용은 이 기기에 그대로 있어요',
  'update.available': '레모 새 버전이 있어요',
  'update.reopen': '다시 열기',
  'update.tooNew.title': '이 기기의 데이터는 더 최신 버전의 앱에서 저장됐어요. 앱을 업데이트해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.body': '지금 쓰는 버전에서는 이 데이터를 열 수 없어요. 업데이트하면 이어서 쓸 수 있고, 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.update': '업데이트하기', // R-106 B1 第一遍已审（10-29）
  'update.tooNew.refresh': '새로고침', // R-106 B1 第一遍已审（10-29）
  'update.updating': '업데이트 중…', // R-106 B1 第一遍已审（10-29）
  'update.failed': '업데이트하지 못했어요 · 인터넷에 연결한 뒤 다시 시도해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.stillOld': '이미 최신 버전이에요. 잠시 후 다시 시도해 주세요', // R-106 B1 第一遍已审（10-29）
  'update.update': '업데이트', // R-106 B1 第一遍已审（10-30）；426 横幅的按钮（0.27 第 1 点“更新”）
  'update.queued': '변경 사항 {n}개는 업데이트한 뒤에 동기화돼요 · 내용은 이 기기에 그대로 있어요', // R-106 B1 第一遍已审（10-30），按审校意见改过；426 时排队的条数（0.27 第 1 点）
  'update.newVersion': '새 버전이 있어요', // R-106 B1 第一遍已审（10-30）；SW 有新版本的横幅（8.1“有新版本 · 重新打开”），按钮沿用 update.reopen
  'update.blocked.title': '열려 있는 다른 레모 창이나 탭을 닫아 주세요', // R-106 B1 第一遍已审（10-30）；“창이나 탭”负责人 10-30 定（明早清单第 25 条）；升级本机库被别的标签页挡住的整屏提示（TC-B1-48）
  'update.blocked.body': '다른 창이나 탭에서 아직 이전 버전을 쓰고 있어요. 닫으면 여기서 자동으로 이어서 열려요. 기록한 내용은 이 기기에 그대로 있어요.', // R-106 B1 第一遍已审（10-30）；“창이나 탭”负责人 10-30 定（明早清单第 25 条），“그 창을 닫으면”随之改成“닫으면”；同上
  'app.crashed.title': '앗, 멈췄어요', // R-106 B1 第一遍已审（10-30）；App 顶层出错的整屏兜底（K6-sugg3 ⑥）
  'app.crashed.refresh': '새로고침', // R-106 B1 第一遍已审（10-30）；和 update.tooNew.refresh 统一成 새로고침
  'remind.push.event': '{time} {title}',
  'fmt.monthDay': '{m}월 {d}일',
  'fmt.monthDayWeek': '{m}월 {d}일 ({w})',
  'fmt.wd.0': '일',
  'fmt.wd.1': '월',
  'fmt.wd.2': '화',
  'fmt.wd.3': '수',
  'fmt.wd.4': '목',
  'fmt.wd.5': '금',
  'fmt.wd.6': '토',
  'update.syncPaused': '동기화가 잠시 멈췄어요. 잠시 후 다시 열어 주세요', // REVIEW(ko)；同 zh：探测说账号正常但 5 分钟内已重新载入过，同步暂停（10-30）
  'update.stalled': '새 버전이 아직 준비되지 않았어요 · 잠시 후 다시 시도해 주세요', // REVIEW(ko)；同 zh：查到新版本但 30 秒内没接管（BANNER-sugg ⑤，10-30）
} as const satisfies Record<SharedMsgKey, string>;
