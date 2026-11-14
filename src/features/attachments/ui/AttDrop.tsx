// 附件区的“加附件”按钮、拖放、粘贴（线框 sAtt、DDRAG）：拖文件进窗口时盖一层“松手就加到这条随手记”，选的、松手的、Ctrl+V 的都交给附件区的 add
// 运行日志只记个数，不记文件名
import { useEffect, useRef, useState } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useAttT } from '../hooks/useNoteFiles.ts';
import styles from './AttPanel.module.css';

/** 选文件框收的类型（10 种文档的扩展名；真正的类型由本机按内容判） */
const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.docm,.xlsm,.pptm,.doc,.xls,.ppt';

/** “加附件”：多选；离线时变灰，下面写一句 */
export function AddButton({ disabled, offline, onFiles }: { disabled: boolean; offline: boolean; onFiles(f: File[]): void }) {
  const t = useAttT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.add}>
      <Pressable type="button" className={styles.pick} onClick={() => ref.current?.click()} disabled={disabled} data-testid="note-files-add">
        {t('att.add', {})}
      </Pressable>
      {offline ? (
        <span className={styles.addOff} data-testid="note-files-offline">
          {t('att.addOffline', {})}
        </span>
      ) : null}
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          if (fs.length) onFiles(fs);
        }}
        data-testid="note-files-input"
      />
    </div>
  );
}

/** 拖进窗口时盖一层“松手就加到这条随手记”（线框 DDRAG） */
export function DropVeil({ n, vault }: { n: number; vault: boolean }) {
  const t = useAttT();
  return (
    <div className={styles.veil} data-testid="note-files-drop">
      <div className={styles.veilBox}>
        <div className={styles.veilPlus} aria-hidden="true">
          ＋
        </div>
        <div className={styles.veilTitle}>{t(vault ? 'att.drop.vault' : 'att.drop.title', {})}</div>
        <div className={styles.veilSub}>{t('att.drop.sub', { n })}</div>
        <div className={styles.veilHint}>{t('att.drop.hint', {})}</div>
      </div>
    </div>
  );
}

const hasFiles = (d: DataTransfer | null): boolean => d !== null && [...d.types].includes('Files');

/** 拖文件进窗口、Ctrl+V 粘贴文件（on 为 false 时不接）：回拖着的文件个数（0 = 没在拖） */
export function useDropAndPaste(on: boolean, add: (f: File[]) => Promise<void>): number {
  const [n, setN] = useState(0);
  const depth = useRef(0);
  // add 每次父组件重渲染都可能是新的：放进 ref，监听只随 on 绑一次（正文打字时不解绑重绑、不把拖着的遮罩清掉，整块评审第 8 条）
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    if (!on) {
      setN(0);
      return undefined;
    }
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setN(e.dataTransfer?.items.length ?? 1);
    };
    const over = (e: DragEvent): void => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setN(0);
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setN(0);
      const fs = [...(e.dataTransfer?.files ?? [])];
      rlog(`att drop n=${fs.length}`);
      if (fs.length) void addRef.current(fs);
    };
    const paste = (e: ClipboardEvent): void => {
      const fs = [...(e.clipboardData?.files ?? [])];
      // 从 Word、Excel 复制的内容常顺带一张 image/png：剪贴板里有文字就照常粘贴文字，不改成插图
      const types = [...(e.clipboardData?.types ?? [])];
      if (!fs.length || types.includes('text/plain') || types.includes('text/html')) return;
      e.preventDefault();
      rlog(`att paste n=${fs.length}`);
      void addRef.current(fs);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
      depth.current = 0;
    };
  }, [on]);
  return n;
}
