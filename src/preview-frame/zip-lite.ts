// 只读的 JSZip 替身（预览沙箱里用；vite.config.ts 把 'jszip' 指到这里）：docx-preview 只用到 JSZip.loadAsync、zip.files[名字].async(类型)，
// PPT 退路另用 zip.file(名字)。按 shared/logic/files/file-sniff.ts 的 zipItems 读中央目录（和判类型、查炸弹同一套读法），
// 解压用浏览器原生的 DecompressionStream（shared/logic/files/inflate.ts），每个条目最多解 ZIP_LIMITS.entryBytes。
// 为什么不用 jszip（代定，交回报告写明）：它的浏览器包是 UMD，打包后要在 App 和沙箱共用的运行时里加一段 require 兜底，首屏多出约 0.6 KB；
//   沙箱只读不写，这几十行够用。不支持写（file(名字, 内容)、generateAsync），docx-preview 渲染时不调。
import { ZIP_LIMITS, zipItems, type ZipItem } from '../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../shared/logic/files/inflate.ts';

type OutType = 'string' | 'uint8array' | 'arraybuffer' | 'blob';

export class ZipObject {
  readonly name: string;
  readonly dir: boolean;
  readonly #item: ZipItem;
  constructor(item: ZipItem) {
    this.name = item.name;
    this.dir = item.name.endsWith('/');
    this.#item = item;
  }
  async #bytes(): Promise<Uint8Array> {
    if (this.#item.method === 0) return this.#item.data;
    const out = await inflateRaw(this.#item.data, ZIP_LIMITS.entryBytes);
    if (!out) throw new Error('zip_entry_too_big');
    return out;
  }
  async async(type: 'string'): Promise<string>;
  async async(type: 'uint8array'): Promise<Uint8Array>;
  async async(type: 'arraybuffer'): Promise<ArrayBuffer>;
  async async(type: 'blob'): Promise<Blob>;
  async async(type: OutType): Promise<string | Uint8Array | ArrayBuffer | Blob> {
    const b = await this.#bytes();
    if (type === 'string') return new TextDecoder().decode(b);
    if (type === 'uint8array') return b;
    const ab = b.slice().buffer;
    return type === 'arraybuffer' ? ab : new Blob([ab]);
  }
}

export default class ZipLite {
  readonly files: Record<string, ZipObject> = {};

  static async loadAsync(input: ArrayBuffer | Uint8Array | Blob): Promise<ZipLite> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
    const items = zipItems(bytes);
    if (!items) throw new Error('zip_unreadable');
    const z = new ZipLite();
    for (const it of items) z.files[it.name] = new ZipObject(it);
    return z;
  }

  file(name: string): ZipObject | null {
    return this.files[name] ?? null;
  }
}
