// 功能 onboarding 的词典·韩文（架构 2.4）
// 出处：consent.privacy 照官网 site/ko/privacy.html 的 R-115 韩文句；标“视觉稿”的照 皮肤视觉稿.html 的 PH.ainoteko、SENDV(1)（R-240）；
// 视觉稿里没有的几行是自译，标 TODO(ko) 待审校（R-106），审过一行删一行的标记
// satisfies Record<keyof typeof zh, string>：少一个键、多一个键都编译不过
import type { zh } from './zh.ts';

export const ko = {
  'consent.title': '구글 AI로 정리해 드릴까요?', // 视觉稿
  'consent.lead': '동의하면 레모가 구글 Gemini로 녹음을 글로 바꾸고, 여러 개로 나누고, 메모를 분류해요.', // 视觉稿
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
  'consent.item.vault.d': 'AI로 가요 (동의하면 기본으로 켜짐, 설정에서 끌 수 있어요)', // 视觉稿
  'consent.newTag': '새로', // 视觉稿
  'consent.privacy': '다른 사용자는 내가 기록한 내용을 볼 수 없어요. 데이터는 서버에 저장되고, 운영자는 기술적으로 접근할 수 있어요. 글, 녹음, 사진, 첨부파일, 비밀 메모는 구글 AI가 처리하고, PPT를 미리 볼 때는 파일이 마이크로소프트로 가요. 자세한 내용은 개인정보 처리 안내에 있어요.', // 照官网 site/ko/privacy.html（R-115）
  'consent.terms': '구글 무료 버전 약관에 따라 이 내용은 구글 제품 개선에 쓰일 수 있고, 사람이 검토할 수도 있어요. 레모는 만 18세 이상만 쓸 수 있어요.', // 视觉稿（两句拼起来）
  'consent.send.label': '보내는 것:', // 视觉稿
  'consent.send.body': '글, 녹음, 찾을 때 한 말, 일정과 할 일의 제목·메모·장소(의미로 찾기에 써요), 사진 썸네일(신분증 사진 포함), 문서 이름과 앞 2000자, 비밀 메모 본문, 요약할 기록 일부.', // 视觉稿
  'consent.send.msLabel': '마이크로소프트:', // 视觉稿
  'consent.send.msBody': 'PPT를 미리 볼 때 파일 전체(비밀 메모의 PPT도 복호화해서 보내요).', // 视觉稿
  'consent.check': '위 내용을 구글 AI가 처리하는 데 동의해요', // 视觉稿
  'consent.needCheck': '위의 동의에 체크해야 “동의하고 계속”을 누를 수 있어요', // TODO(ko): 自译，待审校
  'consent.agree': '동의하고 계속', // 视觉稿
  'consent.decline': '동의하지 않고 쓰기', // 视觉稿（和 R-240 中文“先不同意，直接用”对过，意思一致）
  'consent.declineNote': '동의하지 않아도 쓸 수 있어요: AI로 보내지 않고 기기 규칙으로 정리하고, 녹음은 휴대폰 자체 인식을 써요. 나중에 설정 › 음성과 AI에서 켤 수 있어요', // 视觉稿
  'consent.privacyLink': '개인정보 처리 안내', // 视觉稿、官网
  'consent.termsLink': '이용약관', // 视觉稿、官网
  'consent.busy': '잠시만요…', // TODO(ko): 自译，待审校
  'consent.slow': '네트워크가 느려서 아직 저장하고 있어요…', // TODO(ko): 自译，待审校
  'consent.continue': '계속 쓰기', // TODO(ko): 自译，待审校
  'consent.err.offline': '네트워크에 연결되지 않아 아직 저장하지 못했어요. 연결한 뒤 다시 눌러 주세요.', // TODO(ko): 自译，待审校
  'consent.err.version': '개인정보 처리 안내가 방금 바뀌었어요. 다시 한번 눌러 주세요.', // TODO(ko): 自译，待审校
  'consent.err.tryLater': '서버가 바빠요. 잠시 뒤 다시 눌러 주세요.', // TODO(ko): 自译，待审校
  'consent.err.unknown': '저장하지 못했어요. 다시 한번 눌러 주세요.', // TODO(ko): 自译，待审校
  'consent.err.unsure': '네트워크가 너무 느려서 저장됐는지 확인하지 못했어요. 다시 한번 눌러 주세요 (여러 번 눌러도 괜찮아요).', // TODO(ko): 自译，待审校
  'consent.err.noPolicy': '지금은 선택을 저장할 수 없어서 AI는 쓰지 않을게요. 다음에 열 때 다시 물어볼게요.', // TODO(ko): 自译，待审校
} as const satisfies Record<keyof typeof zh, string>;
