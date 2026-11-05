// 今天页右上角头像上的字（B2 FA-7；负责人 11-05 ①）
import { describe, expect, it } from 'vitest';
import { nameInitial } from '../hooks/useMeInitial.ts';

describe('nameInitial', () => {
  it('名字的第一个字：中文、韩文音节、英文、表情不切半；前后空白不算', () => {
    expect(nameInitial('胡凡')).toBe('胡');
    expect(nameInitial('  김민수')).toBe('김');
    expect(nameInitial('amy')).toBe('a');
    const coder = '\u{1F469}\u200d\u{1F4BB}'; // 女程序员表情：三个码位用零宽连接符连成一个字素
    expect(nameInitial(`${coder} dev`)).toBe(coder);
  });
  it('没有名字：null（页面画人形）', () => {
    for (const v of [undefined, null, '', '   ', 3]) expect(nameInitial(v)).toBeNull();
  });
  describe('开头的不可见字符跳过（代码审查 M1）', () => {
    it('零宽空格', () => expect(nameInitial('\u200b胡凡')).toBe('胡'));
    it('零宽连接符', () => expect(nameInitial('\u200d김민수')).toBe('김'));
    it('方向控制符（从右到左覆盖）', () => expect(nameInitial('\u202eamy')).toBe('a'));
    it('单独的组合附加符', () => expect(nameInitial('\u0301胡')).toBe('胡'));
    it('标签字符', () => expect(nameInitial('\u{E0041}\u{E0042}凡')).toBe('凡'));
  });
  it('全是不可见字符、或第一个字是标点符号：null（画人形）；国旗、数字照常', () => {
    expect(nameInitial('\u200b\u200d\u202e')).toBeNull();
    expect(nameInitial('（胡）')).toBeNull();
    expect(nameInitial('\u{1F1F0}\u{1F1F7} 민수')).toBe('\u{1F1F0}\u{1F1F7}');
    expect(nameInitial('7号')).toBe('7');
  });
});
