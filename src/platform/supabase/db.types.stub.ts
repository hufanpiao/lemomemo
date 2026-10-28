// 【桩】数据库类型。正式的 shared/db.types.ts 由后端用 `supabase gen types typescript` 生成（架构 2.5）。
// 后端生成并合并后：删掉本文件，把 database.ts 里的 import 改成 '../../../shared/db.types.ts'。
// 这里只手写 B0 骨架用得到的形状（和 supabase-js 的 GenericSchema 结构一致），不代表最终列。

type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      app_config: {
        Row: { id: number; min_client_version: string; latest_version: string; notice: Json | null };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      profiles: {
        Row: {
          user_id: string;
          display_name: string | null;
          ui_locale: 'zh-CN' | 'ko-KR';
          tz_mode: 'device' | 'fixed';
          beta_features: string[];
        };
        Insert: never;
        Update: { display_name?: string | null; ui_locale?: 'zh-CN' | 'ko-KR'; tz_mode?: 'device' | 'fixed' };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}
