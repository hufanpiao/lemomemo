// 可见高度真机探测按钮（R-371 第二条路，platform/vh-probe.ts）：只在设置 › 关于的诊断打开时、非正式版里出现（AboutSection 挂）。
// 一次只跑一种（跑着时按钮都禁用）；结果一行一条累加在下面，负责人截图。按钮字是英文、不进词典（同诊断区，A20 只管汉字）
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { runVhMethod, VH_METHODS } from '../../../platform/vh-probe.ts';
import styles from './SettingsPage.module.css';

export function VhProbe() {
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  return (
    <div data-testid="settings-vh-probe">
      <div className={`${styles.actions} ${styles.probeActions}`}>
        {VH_METHODS.map((m) => (
          <FormButton
            key={m.id}
            size="compact"
            disabled={busy}
            data-testid={`vh-probe-${m.id}`}
            onClick={() => {
              setBusy(true);
              void runVhMethod(m)
                .then((line) => setLines((l) => [...l, line]))
                .finally(() => setBusy(false));
            }}
          >
            {m.label}
          </FormButton>
        ))}
      </div>
      {lines.length > 0 && (
        <pre className={styles.diag} data-testid="settings-vh-probe-out">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
