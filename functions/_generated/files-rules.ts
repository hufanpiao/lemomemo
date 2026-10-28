// 自动生成，不要手改：由 build/gen_files_rules.mjs 从 shared/manifests（store = 'r2'、客户端可传的桶 images、files）生成。
// 改了清单就运行 npm run gen:files-rules；CI（npm run check:files-rules 和 tests/build/gen-files-rules.test.ts）
// 重新生成后和这份逐字比对，不一致就失败（架构 3.5 第 2 点、0.32 第 9 条）。
// pathPattern 照抄清单，D1 拿它和 files_authorize_impl 里的正则比（3.5 第 4 点）。

export type FilesBucket = 'images' | 'files';

export interface FilesRuleVariant {
  /** image、thumb、avatar，或附件的扩展名 */
  readonly kind: string;
  /** 路径以它结尾（长的在前） */
  readonly suffix: string;
  /** 上传时 Content-Type 必须等于它 */
  readonly contentType: string;
  /** Content-Length 上限（字节） */
  readonly maxBytes: number;
  /** 要查前 12 字节 RIFF????WEBP */
  readonly webp: boolean;
}

export interface FilesRule {
  readonly bucket: FilesBucket;
  /** image：随手记插图和缩略图；avatar：纪念日头像；file：附件和缩略图 */
  readonly segment: 'image' | 'avatar' | 'file';
  readonly pathPattern: string;
  readonly variants: readonly FilesRuleVariant[];
}

export const FILES_RULES: readonly FilesRule[] = [
  {
    "bucket": "images",
    "segment": "image",
    "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.t)?\\.webp$",
    "variants": [
      {
        "kind": "thumb",
        "suffix": ".t.webp",
        "contentType": "image/webp",
        "maxBytes": 2097152,
        "webp": true
      },
      {
        "kind": "image",
        "suffix": ".webp",
        "contentType": "image/webp",
        "maxBytes": 2097152,
        "webp": true
      }
    ]
  },
  {
    "bucket": "files",
    "segment": "file",
    "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\\.t\\.webp)$",
    "variants": [
      {
        "kind": "thumb",
        "suffix": ".t.webp",
        "contentType": "image/webp",
        "maxBytes": 2097152,
        "webp": true
      },
      {
        "kind": "docm",
        "suffix": ".docm",
        "contentType": "application/vnd.ms-word.document.macroEnabled.12",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "docx",
        "suffix": ".docx",
        "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "pptm",
        "suffix": ".pptm",
        "contentType": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "pptx",
        "suffix": ".pptx",
        "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "xlsm",
        "suffix": ".xlsm",
        "contentType": "application/vnd.ms-excel.sheet.macroEnabled.12",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "xlsx",
        "suffix": ".xlsx",
        "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "doc",
        "suffix": ".doc",
        "contentType": "application/msword",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "pdf",
        "suffix": ".pdf",
        "contentType": "application/pdf",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "ppt",
        "suffix": ".ppt",
        "contentType": "application/vnd.ms-powerpoint",
        "maxBytes": 10485760,
        "webp": false
      },
      {
        "kind": "xls",
        "suffix": ".xls",
        "contentType": "application/vnd.ms-excel",
        "maxBytes": 10485760,
        "webp": false
      }
    ]
  },
  {
    "bucket": "images",
    "segment": "avatar",
    "pathPattern": "^[0-9a-f-]{36}/anniv/[0-9a-f-]{36}/[0-9a-f-]{36}\\.webp$",
    "variants": [
      {
        "kind": "avatar",
        "suffix": ".webp",
        "contentType": "image/webp",
        "maxBytes": 2097152,
        "webp": true
      }
    ]
  }
];
