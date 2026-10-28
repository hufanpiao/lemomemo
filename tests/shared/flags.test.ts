// shared/logic/flags.ts、shared/core/version.ts（架构 0.27 第 1、4 点）
import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, versionAtLeast } from '../../shared/core/version.ts';
import { featureOn, type FeaturesConfig } from '../../shared/logic/flags.ts';

describe('version', () => {
  it('parseVersion：去掉后缀，格式不对返回 null', () => {
    expect(parseVersion('4.1.0')).toEqual([4, 1, 0]);
    expect(parseVersion('4.1.0-preview.3')).toEqual([4, 1, 0]);
    expect(parseVersion(' 4.0.12 ')).toEqual([4, 0, 12]);
    expect(parseVersion('4.1')).toBeNull();
    expect(parseVersion('v4.1.0')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('compareVersions：按数字比，不按字符串比', () => {
    expect(compareVersions('4.0.10', '4.0.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0.0', '4.0.0-preview.1')).toBe(0);
    expect(compareVersions('3.9.9', '4.0.0')).toBeLessThan(0);
    expect(() => compareVersions('x', '4.0.0')).toThrow('bad_version');
  });

  it('versionAtLeast', () => {
    expect(versionAtLeast('4.1.0', '4.1.0')).toBe(true);
    expect(versionAtLeast('4.0.9', '4.1.0')).toBe(false);
  });
});

describe('featureOn', () => {
  const cfg: FeaturesConfig = {
    event: { on: true },
    note: { on: true, min_client: '4.1.0' },
    anniv: { on: false },
    todo: { on: false, min_client: '4.2.0' },
  };
  const ctx = (appVersion: string, beta: string[] = []) => ({ appVersion, beta });

  it('打开、没有版本要求 → 开', () => {
    expect(featureOn(cfg, 'event', ctx('4.0.0'))).toBe(true);
  });

  it('版本低于 min_client → 关；等于或更高 → 开', () => {
    expect(featureOn(cfg, 'note', ctx('4.0.9'))).toBe(false);
    expect(featureOn(cfg, 'note', ctx('4.1.0'))).toBe(true);
    expect(featureOn(cfg, 'note', ctx('4.1.0-preview.2'))).toBe(true);
  });

  it('总开关关着，但在本人的 beta_features 里 → 开（仍要满足版本）', () => {
    expect(featureOn(cfg, 'anniv', ctx('4.0.0'))).toBe(false);
    expect(featureOn(cfg, 'anniv', ctx('4.0.0', ['anniv']))).toBe(true);
    expect(featureOn(cfg, 'todo', ctx('4.1.0', ['todo']))).toBe(false);
    expect(featureOn(cfg, 'todo', ctx('4.2.0', ['todo']))).toBe(true);
  });

  it('失败就关上：配置里没有这个键、版本号解析不了', () => {
    expect(featureOn(cfg, 'vault', ctx('4.0.0', ['vault']))).toBe(false);
    expect(featureOn(cfg, 'note', ctx('dev'))).toBe(false);
    expect(featureOn({ x: { on: true, min_client: 'bad' } }, 'x', ctx('4.0.0'))).toBe(false);
  });
});
