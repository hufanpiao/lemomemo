// 功能 onboarding 的词典·中文：告知与同意页（视觉稿 皮肤视觉稿.html 的 PH.ainote、PH.privupd、SENDV）
// consent.privacy 必须和官网隐私说明那一句一字不差（官网、登录页、告知页、隐私说明都用这一句），测试逐字比对官网隐私说明
export const zh = {
  // AI 服务商可以换（谷歌、OpenAI、Anthropic、DeepSeek），同意页不写死谷歌
  'consent.title': '要不要让 AI 帮你整理？',
  'consent.lead': '同意后，柠檬记交给 AI 服务商（谷歌、OpenAI、Anthropic 或 DeepSeek）把录音转成文字、拆成几条、给随手记分类。',
  // 视觉稿 PH.ainote 的六行清单；“新”标签不加粗
  'consent.item.voice': '说话记事',
  'consent.item.voice.d': '录音交给 AI 转成文字并拆分',
  'consent.item.note': '打字和随手记',
  'consent.item.note.d': '文字交给 AI 整理、分类',
  'consent.item.media': '图片和附件',
  'consent.item.media.d': '识别内容，用来按图片、按意思找',
  'consent.item.plus': '用“＋”查找、总结',
  'consent.item.plus.d': '说的话和被总结的记录片段',
  'consent.item.cal': '日程和待办',
  'consent.item.cal.d': '标题、备注、地点，用来按意思查找',
  'consent.item.vault': '隐私记',
  'consent.item.vault.d': '也交给 AI（同意后默认开，设置里可关）',
  'consent.newTag': '新',
  'consent.privacy': '其他用户看不到你记的东西。数据存在服务器上，运营者在技术上能访问；文字、录音、图片、附件和隐私记会交给 AI 服务商处理，预览 PPT 时文件会交给微软，详见隐私说明。',
  // 隐私句后面紧接着的一句（AI 服务商的条款、18 岁；不写死谷歌）
  'consent.terms': '按 AI 服务商的条款，这些内容可能被用来改进它们的产品，并可能经人工审阅。使用本服务须年满 18 岁。',
  // 视觉稿 SENDV（单独一行列出会送哪些东西）
  'consent.send.label': '会送出去的：',
  'consent.send.body': '文字、录音、查找时说的话；日程和待办的标题、备注、地点（用来按意思查找）；图片的缩略图（证件照也会送）；文档的文件名和前 2000 字；隐私记解密后的文字；总结时被总结的记录片段；AI 助手联网时的搜索词。',
  'consent.send.msLabel': '交给微软的：',
  'consent.send.msBody': '预览 PPT 时的整个文件，包括隐私记里的 PPT（先解密再交）。',
  // 清单上方的小字分组名（只是标签，不改告知内容）
  'consent.itemsLabel': '用到 AI 的地方',
  'consent.check': '我同意把上面这些交给 AI 服务商处理',
  'consent.needCheck': '先勾选上面的同意，才能点“同意并继续”',
  'consent.agree': '同意并继续',
  'consent.decline': '先不同意，直接用',
  'consent.declineNote': '不同意也能用：不送 AI，按本地规则整理，语音先停用、用键盘记。以后可在 设置 › 语音与 AI 打开',
  'consent.privacyLink': '隐私说明',
  'consent.termsLink': '使用条款',
  'consent.busy': '请稍候…',
  'consent.slow': '网络有点慢，还在保存…',
  'consent.continue': '继续使用',
  'consent.err.offline': '网络没连上，这一步还没记下。请联网后再点一次。',
  // 报“断网”但 navigator.onLine 不是 false（请求失败、超时、读不出回包）：不说“没有网络”
  'consent.err.unreachable': '暂时连不上服务器，稍后再试',
  'consent.err.version': '隐私说明刚更新过，请再点一次。',
  'consent.err.tryLater': '服务器忙，请稍后再点一次。',
  'consent.err.unknown': '这一步没记下，请再点一次。',
  'consent.err.unsure': '网络太慢，不确定记下没有。请再点一次（重复点不会出错）。',
  // no_policy：notice 为空或认不出
  'consent.err.noPolicy': '暂时没法保存你的选择，先不使用 AI，下次打开再问你。',
  // 视觉稿 PH.privupd：“隐私说明更新了”那一屏；四行的标题复用 consent.item.*，按钮复用 consent.agree、consent.decline
  'consent.update.title': '隐私说明更新了',
  // 这一版变的：AI 可能换成别家；联网改成几家同时搜，多了 Naver（要用户重新同意一次）。四行照旧列出会交给第三方的东西
  'consent.update.lead': '这次起，AI 可能交给谷歌、OpenAI、Anthropic 或 DeepSeek 处理，AI 助手联网时搜索词会同时交给 DeepSeek、Brave、Naver 中的几家（不行时交给 Tavily），看完再继续',
  'consent.update.item.media.d': '也交给 AI 识别，用来按图片、按意思找',
  'consent.update.item.plus.d': '说的话和被总结的记录片段交给 AI',
  'consent.update.item.cal.d': '标题、备注、地点交给 AI，用来按意思查找',
  'consent.update.item.ppt': '预览 PPT',
  'consent.update.item.ppt.d': '文件交给微软的在线预览，包括隐私记里的 PPT',
  'consent.update.itemsLabel': '会交给第三方的',
  'consent.update.check': '我同意更新后的内容',
  'consent.update.declineNote': '不同意：AI 功能先停用，按本地规则整理、只按关键词找；以后可在 设置 › 语音与 AI 打开',
} as const;
