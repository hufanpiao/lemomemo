// 中国节假日补班日名字的尾巴（R-338、R-340、R-106 B2K-06）：和 src/public/holidays/cn/*.json 的写法一致的数据常量
// （文件名 -data.ts，架构 2.3 A20 的数据文件例外）。holidayMarks 按界面语言取 name.zh / name.ko，所以两种都要认：
// 中文“补班”（“春节补班”），韩文“ 대체 근무일”（前面有空格，“춘절 대체 근무일”）。审校改了写法只改这里，
// __tests__/holiday-tail.test.ts 会核对数据文件和这里一致
export const CN_WORKDAY_TAILS: Readonly<Record<'zh' | 'ko', string>> = { zh: '补班', ko: ' 대체 근무일' };
