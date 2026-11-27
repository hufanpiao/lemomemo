// Playwright 报告器（第三方审查 CI-15）：CI 上 retries 1 保留，重试才过的用例（flaky）不让它悄悄过去——
// 跑完列进 GitHub Step Summary（环境变量 GITHUB_STEP_SUMMARY 指的文件，追加写）；本机没这个变量就打到标准输出。不改退出码（不开 failOnFlakyTests）
import { appendFileSync } from 'node:fs';
import type { FullConfig, Reporter, Suite, TestCase } from '@playwright/test/reporter';

export default class FlakySummary implements Reporter {
  private root: Suite | null = null;
  private config: FullConfig | null = null;

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.root = suite;
  }

  onEnd(): void {
    const flaky: TestCase[] = (this.root?.allTests() ?? []).filter((t) => t.outcome() === 'flaky');
    const where = this.config?.configFile?.split(/[\\/]/).pop() ?? 'playwright';
    const lines = [
      `### e2e flaky（${where}）：${flaky.length} 条`,
      ...flaky.map((t) => `- [${t.parent.project()?.name ?? '-'}] ${t.location.file.split(/[\\/]/).pop()}:${t.location.line} ${t.titlePath().slice(3).join(' › ')}`),
      '',
    ];
    const file = process.env['GITHUB_STEP_SUMMARY'];
    if (file) appendFileSync(file, `${lines.join('\n')}\n`);
    else if (flaky.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
