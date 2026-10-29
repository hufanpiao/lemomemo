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
  'feature.off': '이 기능은 아직 켜져 있지 않아요',
  'update.required': '동기화를 계속하려면 업데이트가 필요해요 · 기록한 내용은 이 기기에 그대로 있어요',
  'update.available': '레모 새 버전이 있어요',
  'update.reopen': '다시 열기',
  'update.tooNew.title': '이 기기의 데이터는 새 버전에서 저장됐어요. 앱을 업데이트해 주세요', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.tooNew.body': '지금 버전으로는 읽을 수 없어요. 업데이트하면 계속 쓸 수 있고, 기록한 내용은 이 기기에 그대로 있어요.', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.tooNew.update': '업데이트하기', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.tooNew.refresh': '새로고침', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.updating': '업데이트하는 중…', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.failed': '업데이트하지 못했어요 · 인터넷에 연결한 뒤 다시 시도해 주세요', // TODO(ko): 초안, 韩文审校待审（R-106）
  'update.stillOld': '이미 최신 버전이에요. 잠시 후 다시 시도해 주세요', // TODO(ko): 초안, 韩文审校待审（R-106）
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
} as const satisfies Record<SharedMsgKey, string>;
