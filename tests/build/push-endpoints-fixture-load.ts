// 读 tests/fixtures/push-endpoints.json，给 push-endpoints-fixture*.test.ts 共用（类型写在这里，后端读这个文件时可以照抄字段）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EndpointCase {
  id: string;
  endpoint: string;
  ok: boolean;
  why: string;
  ref?: string;
  pg?: boolean;
  pgWhy?: string;
}
export interface KeyCase {
  id: string;
  field: 'p256dh' | 'auth';
  value: string;
  ok: boolean;
  why: string;
  ref?: string;
}
export interface SendOnlyKeyCase {
  id: string;
  field: 'p256dh';
  value: string;
  sqlOk: true;
  sendOk: false;
  why: string;
  ref: string;
}
export interface Fixture {
  version: number;
  endpoints: EndpointCase[];
  keys: KeyCase[];
  keysSendOnly: SendOnlyKeyCase[];
}

const FILE = join(import.meta.dirname, '..', 'fixtures', 'push-endpoints.json');
export const fx = JSON.parse(readFileSync(FILE, 'utf8')) as Fixture;
