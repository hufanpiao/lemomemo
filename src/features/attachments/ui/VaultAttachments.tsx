// 隐私记里的附件区（B4b-1；线框 sAtt“隐私记也能加（加密）”；架构 5.13 第 11 点、R-118 D-12）：隐私记编辑器在图片下面挂（index.ts 懒加载）
// • 传输由隐私记功能给（api：带会话令牌调 vault-file）；这里每挂一次建一份 vault-att（noteId 固定），挂上就 list 一次
// • 卸下（上锁时隐私记页面换成解锁卡、离开编辑页）：丢掉内存里的明文字节、结束微软预览（ms_preview_end）
// • 还没保存的新隐私记没有 noteId：不挂（编辑器保存后才出这一块）
import { useEffect, useState } from 'react';
import { AttPanel } from './AttPanel.tsx';
import { createVaultAtt, useVaultFiles, type VaultAtt, type VaultFileApi } from '../hooks/useNoteFiles.ts';

export interface VaultAttachmentsProps {
  noteId: string;
  api: VaultFileApi;
  disabled: boolean;
}

export default function VaultAttachments({ noteId, api, disabled }: VaultAttachmentsProps) {
  // 在 effect 里建、卸下时丢（开发版 StrictMode 挂、卸、再挂时会重建一份，不沿用已丢掉的那份）
  const [va, setVa] = useState<VaultAtt | null>(null);
  useEffect(() => {
    const v = createVaultAtt(api, noteId);
    setVa(v);
    void v.load();
    return () => {
      v.dispose();
      setVa(null);
    };
  }, [api, noteId]);
  return va ? <Loaded va={va} noteId={noteId} disabled={disabled} /> : null;
}

function Loaded({ va, noteId, disabled }: { va: VaultAtt; noteId: string; disabled: boolean }) {
  const { loaded, items } = useVaultFiles(va);
  if (!loaded) return null;
  return <AttPanel src={va.source} items={items} noteId={noteId} disabled={disabled} />;
}
