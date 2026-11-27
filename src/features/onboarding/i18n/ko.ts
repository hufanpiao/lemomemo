// 功能 onboarding 的词典·韩文
// 出处：consent.privacy 照官网 site/ko/privacy.html 的韩文句；标“视觉稿”的照 皮肤视觉稿.html 的 PH.ainoteko、PH.privupdko、SENDV(1)；
// 视觉稿里没有的几行是自译，过了第一遍审校的标“已审”；以后新加的自译行先标 TODO(ko)，审过再换标记
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'consent.title': 'AI로 정리해 드릴까요?', // 视觉稿去掉“구글”（泛称）
  'consent.lead': '동의하면 레모가 AI 서비스(구글, OpenAI, Anthropic, DeepSeek 중 하나)로 녹음을 글로 바꾸고, 여러 개로 나누고, 메모를 분류해요.', // TODO(ko) 泛称，自译
  'consent.item.voice': '말로 기록', // 视觉稿
  'consent.item.voice.d': '녹음을 AI가 글로 바꾸고 나눠요', // 视觉稿
  'consent.item.note': '타이핑과 메모', // 视觉稿
  'consent.item.note.d': '글을 AI가 정리·분류해요', // 视觉稿
  'consent.item.media': '사진과 첨부파일', // 视觉稿
  'consent.item.media.d': '내용을 인식해요 (사진으로 찾기, 의미로 찾기)', // 视觉稿
  'consent.item.plus': '“＋”로 찾기·요약', // 视觉稿
  'consent.item.plus.d': '한 말과 요약할 기록 일부', // 视觉稿
  'consent.item.cal': '일정과 할 일', // 视觉稿
  'consent.item.cal.d': '제목·메모·장소 (의미로 찾기에 써요)', // 视觉稿
  'consent.item.vault': '비밀 메모', // 视觉稿
  'consent.item.vault.d': '이것도 AI로 가요 (동의하면 기본으로 켜지고, 설정에서 끌 수 있어요)', // 视觉稿；已审，视觉稿同步
  'consent.newTag': '신규', // 视觉稿；已审，视觉稿同步
  'consent.privacy': '다른 사용자는 내가 기록한 내용을 볼 수 없어요. 데이터는 서버에 저장되고, 운영자는 기술적으로 접근할 수 있어요. 글, 녹음, 사진, 첨부파일, 비밀 메모는 AI 서비스 업체가 처리하고, PPT를 미리 볼 때는 파일이 마이크로소프트로 가요. 자세한 내용은 개인정보 처리 안내에 있어요.', // 照官网 site/ko/privacy.html
  'consent.terms': 'AI 서비스 업체의 약관에 따라 이 내용은 해당 업체의 제품 개선에 쓰일 수 있고, 사람이 검토할 수도 있어요. 레모는 만 18세 이상만 쓸 수 있어요.', // TODO(ko) 泛称，自译
  'consent.send.label': '보내는 것:', // 视觉稿
  'consent.send.body': '글, 녹음, 찾을 때 한 말, 일정과 할 일의 제목·메모·장소(의미로 찾기에 써요), 사진 썸네일(신분증 사진 포함), 문서 이름과 앞 2000자, 비밀 메모 본문, 요약할 기록 일부, AI 도우미가 웹 검색할 때의 검색어.', // 视觉稿，另加联网搜索词
  'consent.send.msLabel': '마이크로소프트로 보내는 것:', // 视觉稿；已审，视觉稿同步
  'consent.send.msBody': 'PPT를 미리 볼 때 파일 전체(비밀 메모의 PPT도 복호화해서 보내요).', // 视觉稿
  'consent.itemsLabel': 'AI를 쓰는 곳', // REVIEW(ko) 清单上方的小字分组名
  'consent.check': '위 내용을 AI 서비스 업체가 처리하는 데 동의해요', // TODO(ko) 泛称，自译
  'consent.needCheck': '위의 동의에 체크해야 “동의하고 계속”을 누를 수 있어요', // 已审
  'consent.agree': '동의하고 계속', // 视觉稿
  'consent.decline': '동의하지 않고 쓰기', // 视觉稿（和中文“先不同意，直接用”对过，意思一致）
  'consent.declineNote': '동의하지 않아도 쓸 수 있어요: AI로 보내지 않고 기기 규칙으로 정리하고, 음성은 잠시 쉬고 키보드로 기록해요. 나중에 설정 › 음성과 AI에서 켤 수 있어요', // 视觉稿
  'consent.privacyLink': '개인정보 처리 안내', // 视觉稿、官网
  'consent.termsLink': '이용약관', // 视觉稿、官网
  'consent.busy': '잠시만요…', // 已审
  'consent.slow': '인터넷이 좀 느려서 아직 저장하고 있어요…', // 已审；网络统一成 인터넷
  'consent.continue': '계속 쓰기', // 已审
  'consent.err.offline': '인터넷에 연결되어 있지 않아 아직 저장하지 못했어요. 연결되면 다시 한번 눌러 주세요.', // 已审
  'consent.err.version': '개인정보 처리 안내가 방금 바뀌었어요. 다시 한번 눌러 주세요.', // 已审
  'consent.err.unreachable': '지금 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요', // REVIEW(ko)：新句
  'consent.err.tryLater': '서버가 바빠요. 잠시 뒤 다시 눌러 주세요.', // 已审
  'consent.err.unknown': '저장하지 못했어요. 다시 한번 눌러 주세요.', // 已审
  'consent.err.unsure': '인터넷이 너무 느려서 저장됐는지 확인하지 못했어요. 다시 한번 눌러 주세요(여러 번 눌러도 괜찮아요).', // 已审
  'consent.err.noPolicy': '지금은 선택을 저장할 수 없어서 우선 AI는 쓰지 않을게요. 다음에 앱을 열 때 다시 물어볼게요.', // 已审
  // 视觉稿 PH.privupdko；稿里没画“不同意”那行小字，declineNote 是自译
  'consent.update.title': '개인정보 처리 안내가 바뀌었어요', // 视觉稿
  'consent.update.lead': '이번부터 AI는 구글, OpenAI, Anthropic, DeepSeek 중 한 곳이 처리할 수 있고, AI 도우미가 웹 검색을 할 때는 검색어가 DeepSeek, Brave, Naver 중 몇 곳으로 동시에 가요(안 될 때는 Tavily). 확인한 뒤 계속해 주세요', // REVIEW(ko) 自译
  'consent.update.item.media.d': 'AI가 내용을 인식해요 (사진으로 찾기, 의미로 찾기)', // 视觉稿去掉“구글”
  'consent.update.item.plus.d': '한 말과 요약할 기록 일부가 AI로 가요', // 视觉稿去掉“구글”
  'consent.update.item.cal.d': '제목·메모·장소가 AI로 가요 (의미로 찾기)', // 视觉稿去掉“구글”
  'consent.update.item.ppt': 'PPT 미리보기', // 视觉稿
  'consent.update.item.ppt.d': '파일이 마이크로소프트로 가요 (비밀 메모의 PPT 포함)', // 视觉稿
  'consent.update.itemsLabel': '외부 서비스로 가는 것', // TODO(ko) 自译
  'consent.update.check': '바뀐 내용에 동의해요', // 视觉稿
  'consent.update.declineNote': '동의하지 않으면 AI 기능은 우선 꺼져요. 기기 규칙으로 정리하고 키워드로만 찾아요. 나중에 설정 › 음성과 AI에서 켤 수 있어요', // 已审；自译（视觉稿没画这行）
} as const satisfies Record<keyof typeof zh, string>;
