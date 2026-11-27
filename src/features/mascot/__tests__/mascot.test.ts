// 吉祥物的纯逻辑：默认和存储解码、待办变化对应的反应、目录不含不分发的素材
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moodNameErrors } from '../../../motion/mascot-stage.ts';
import { DEFAULT_MASCOT, MASCOTS, MASCOT_IDS } from '../data/catalog.ts';
import { CREDITS } from '../data/credits-data.ts';
import { creditOf, PRIVATE_DEF, PRIVATE_URL } from '../data/mascot-private.ts';
import { MASCOT_KEY, mascotOfRows, mascotValue, pickedMascot } from '../data/mascot-setting.ts';
import { kindOfChange } from '../hooks/useMascotReactions.ts';

const row = (value: unknown, extra: Record<string, unknown> = {}) => ({ id: 'k', key: MASCOT_KEY, value, ...extra });

describe('选中的吉祥物', () => {
  it('没选过：普通账号默认 Aldo #23，管理员默认 #2（负责人 11-26“我默认是二号，其他人是aldo”）；小怪兽 #22 不当谁的默认', () => {
    expect(DEFAULT_MASCOT).toBe('23');
    expect(mascotOfRows([])).toBe('23');
    expect(mascotOfRows([], false)).toBe('23');
    expect(mascotOfRows([], true)).toBe('2');
  });
  it('已经存过选择的不受默认改动影响（普通账号、管理员都一样）', () => {
    for (const id of ['15', '3', '7', '13', '18', '19', '20', '22', '23'] as const) {
      expect(mascotOfRows([row(mascotValue(id))], false)).toBe(id);
      expect(mascotOfRows([row(mascotValue(id))], true)).toBe(id);
    }
  });
  it('读得出存过的值；认不出、已删除的回默认', () => {
    expect(mascotOfRows([row(mascotValue('19'))])).toBe('19');
    expect(mascotOfRows([row({ v: 1, id: '2' })])).toBe('23');
    expect(mascotOfRows([row('19')])).toBe('23');
    expect(mascotOfRows([row(mascotValue('19'), { deleted_at: '2026-11-23' })])).toBe('23');
  });
  it('公开目录里没有 #2 的文件，可选的九个都有定义', () => {
    expect(MASCOT_IDS).not.toContain('2');
    expect(Object.keys(MASCOTS).sort()).toEqual([...MASCOT_IDS].sort());
    expect(PRIVATE_DEF.url).toBe(PRIVATE_URL);
    for (const m of Object.values(MASCOTS)) expect(m.url).not.toBe(PRIVATE_URL);
  });
  it('管理员手动选了 #2 或别的就用选的', () => {
    expect(mascotOfRows([row(mascotValue('22'))], true)).toBe('22');
    expect(mascotOfRows([row(mascotValue('2'))], true)).toBe('2');
    expect(mascotOfRows([row(mascotValue('19'))], true)).toBe('19');
    expect(mascotOfRows([row(mascotValue('15'))], true)).toBe('15');
  });
  it('普通账号就算存着 #2 也是默认 Aldo', () => {
    expect(pickedMascot([row(mascotValue('2'))])).toBe('2');
    expect(mascotOfRows([row(mascotValue('2'))], false)).toBe('23');
  });
  it('#2 的署名缺项或链接不是 https 时不显示', () => {
    const ok = { work: 'w', author: 'a', url: 'https://example.test/x' };
    expect(creditOf(ok)).toEqual(ok);
    expect(creditOf({ ...ok, url: 'javascript:alert(1)' })).toBeNull();
    expect(creditOf({ ...ok, author: '' })).toBeNull();
    expect(creditOf(null)).toBeNull();
  });
  it('#2 的许可证照元数据写：没写就没有许可证这一行，链接不是 https 的只留名字', () => {
    const ok = { work: 'w', author: 'a', url: 'https://example.test/x' };
    expect(creditOf(ok)?.license).toBeUndefined();
    expect(creditOf({ ...ok, license: '' })?.license).toBeUndefined();
    expect(creditOf({ ...ok, license: 'CC BY-NC 4.0', license_url: 'https://example.test/l' })?.license).toEqual({ name: 'CC BY-NC 4.0', url: 'https://example.test/l' });
    expect(creditOf({ ...ok, license: 'CC BY-NC 4.0', license_url: 'javascript:x' })?.license).toEqual({ name: 'CC BY-NC 4.0' });
  });
  it('署名有 10 条（九个角色加输入框小人），每条都有作者和链接，改过的写有改动', () => {
    expect(CREDITS).toHaveLength(10);
    expect(CREDITS.filter((c) => c.author === 'ElmerVergara' || c.work === 'Aldo').map((c) => c.changed)).toEqual([true, true]);
    for (const c of CREDITS) {
      expect(c.author).not.toBe('');
      expect(c.url.startsWith('https://')).toBe(true);
    }
  });
});

describe('目录一致性：配置里写的名字都对得上', () => {
  /** 素材里的名字（状态、输入、数据模型属性、节点）按 UTF-8 存在 .riv 里，按字节找 */
  const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets');
  const inAsset = (url: string, name: string): boolean =>
    readFileSync(join(assets, basename(new URL(url, 'http://x/').pathname))).includes(Buffer.from(name, 'utf8'));
  for (const [id, m] of Object.entries(MASCOTS)) {
    it(`#${id}：表情的 rest、on、random 都在 ring 上，ring 的状态、直达输入、形态的数据模型属性都在素材里`, () => {
      if (m.moods) {
        expect(moodNameErrors(m.moods)).toEqual([]);
        for (const s of [...m.moods.ring, m.moods.input]) expect(inAsset(m.url, s), s).toBe(true);
        expect(m.moods.ms).toBeGreaterThan(0);
      }
      if (m.forms) {
        expect(inAsset(m.url, m.forms.num), m.forms.num).toBe(true);
        expect(m.forms.count).toBeGreaterThan(1);
      }
      if (m.look?.node) expect(inAsset(m.url, m.look.node), m.look.node).toBe(true);
      if (m.sm) expect(inAsset(m.url, m.sm), m.sm).toBe(true);
      if (m.artboard) expect(inAsset(m.url, m.artboard), m.artboard).toBe(true);
    });
    it(`#${id}：反应数据（react）和一加载就设的输入（init）里的输入名、属性名、枚举值都在素材里`, () => {
      const names = new Set(Object.keys(m.init ?? {}));
      for (const steps of Object.values(m.react ?? {})) {
        for (const st of steps) {
          if ('input' in st) names.add(st.input);
          if ('prop' in st) names.add(st.prop);
          if (st.do === 'enum') {
            names.add(st.value);
            if (st.back !== undefined) names.add(st.back);
          }
        }
      }
      for (const n of names) expect(inAsset(m.url, n), n).toBe(true);
    });
  }
  it('有表情环的不再写反应数据（反应走表情环），没有的至少写了勾完、新增、删除里的一种', () => {
    for (const [id, m] of Object.entries(MASCOTS)) {
      if (m.moods) expect(m.react, id).toBeUndefined();
      else expect(Object.keys(m.react ?? {}).length, id).toBeGreaterThan(0);
    }
  });
  it('署名按 id 对到目录：九只加输入框小人各一条，不重不漏', () => {
    expect(CREDITS.map((c) => c.id).sort()).toEqual([...MASCOT_IDS, 'peek'].sort());
  });
});

describe('待办变化对应的反应', () => {
  const prev = new Map([['a', false], ['b', true]]);
  const base = [{ id: 'a', done: false }, { id: 'b', done: true }];
  it('没变化不反应', () => expect(kindOfChange(prev, base)).toBeNull());
  it('勾完', () => expect(kindOfChange(prev, [{ id: 'a', done: true }, { id: 'b', done: true }])).toBe('done'));
  it('新增', () => expect(kindOfChange(prev, [...base, { id: 'c', done: false }])).toBe('add'));
  it('删除（含软删）', () => {
    expect(kindOfChange(prev, [base[1] as { id: string; done: boolean }])).toBe('del');
    expect(kindOfChange(prev, [{ id: 'a', done: false, deleted_at: 'x' }, { id: 'b', done: true }])).toBe('del');
  });
  it('一次变太多（同步、批量）不反应', () => {
    const many = [...base, ...['c', 'd', 'e', 'f'].map((id) => ({ id, done: false }))];
    expect(kindOfChange(prev, many)).toBeNull();
  });
});
