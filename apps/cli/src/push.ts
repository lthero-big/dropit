import { basename } from 'node:path';
import { CliError } from './errors.js';
import type { Item } from './items.js';

export const PUSH_CONCURRENCY = 3;
export const PUSH_AUTO_RETRIES = 3;

export type PushStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

export type PushEvent = {
  file: string;
  name: string;
  status: PushStatus;
  sent?: number;
  total?: number;
  message?: string;
};

export interface PushOutput {
  stderr: { write(chunk: string): unknown };
  stderrIsTTY: boolean;
}

export function formatProgress(label: string, sent: number, total: number): string {
  const pct = total > 0 ? Math.min(100, Math.floor((sent * 100) / total)) : 0;
  return `${label} ${String(pct).padStart(3, ' ')}%  ${sent}/${total}`;
}

export function createPushWriter(output: PushOutput): (event: PushEvent) => void {
  let current = '';
  return (event) => {
    const name = event.name;
    if (!output.stderrIsTTY) {
      if (event.status === 'uploading' && event.sent != null) return;
      const line = event.status === 'queued' ? `排队 ${name}`
        : event.status === 'uploading' ? `上传 ${name}`
        : event.status === 'done' ? `完成 ${name}`
        : event.status === 'cancelled' ? `已取消 ${name}`
        : `失败 ${name}：${event.message ?? '上传失败'}`;
      output.stderr.write(`${line}\n`);
      return;
    }
    if (event.status === 'uploading' && event.sent != null && event.total != null) {
      if (current && current !== name) output.stderr.write('\n');
      current = name;
      output.stderr.write(`\r${formatProgress(name, event.sent, event.total)}`);
      return;
    }
    if (event.status === 'done' || event.status === 'failed' || event.status === 'cancelled') {
      if (current) {
        output.stderr.write('\n');
        current = '';
      }
      if (event.status === 'failed') output.stderr.write(`失败 ${name}：${event.message ?? '上传失败'}\n`);
      else if (event.status === 'cancelled') output.stderr.write(`已取消 ${name}\n`);
    }
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CliError('INTERRUPTED', '已取消上传', 130));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CliError('INTERRUPTED', '已取消上传', 130));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pushFiles(options: {
  files: string[];
  signal: AbortSignal;
  upload: (file: string, onProgress: (sent: number, total: number) => void, signal: AbortSignal) => Promise<Item>;
  onEvent: (event: PushEvent) => void;
  concurrency?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ items: Item[]; failed: number; cancelled: boolean; errors: string[] }> {
  const concurrency = options.concurrency ?? PUSH_CONCURRENCY;
  const sleep = options.sleep ?? delay;
  const files = options.files;
  const items: Item[] = [];
  const errors: string[] = [];
  let failed = 0;
  let cancelled = false;
  let active = 0;
  let index = 0;
  if (files.length === 0) return { items, failed, cancelled, errors };
  for (const file of files) options.onEvent({ file, name: basename(file), status: 'queued' });
  if (options.signal.aborted) {
    for (const file of files) options.onEvent({ file, name: basename(file), status: 'cancelled' });
    return { items, failed, cancelled: true, errors };
  }

  await new Promise<void>((resolve) => {
    let remaining = files.length;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    };
    const cancelRest = () => {
      while (index < files.length) {
        const file = files[index++]!;
        cancelled = true;
        options.onEvent({ file, name: basename(file), status: 'cancelled' });
        finish();
      }
    };
    const pump = () => {
      if (options.signal.aborted) {
        cancelRest();
        return;
      }
      while (active < concurrency && index < files.length) {
        const file = files[index++]!;
        active += 1;
        void run(file).finally(() => {
          active -= 1;
          finish();
          pump();
        });
      }
    };
    async function run(file: string) {
      const name = basename(file);
      const child = new AbortController();
      const onAbort = () => child.abort();
      if (options.signal.aborted) child.abort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      options.onEvent({ file, name, status: 'uploading' });
      try {
        let retries = 0;
        while (true) {
          try {
            const item = await options.upload(file, (sent, total) => {
              options.onEvent({ file, name, status: 'uploading', sent, total });
            }, child.signal);
            items.push(item);
            options.onEvent({ file, name, status: 'done' });
            return;
          } catch (error) {
            if (child.signal.aborted || options.signal.aborted) {
              cancelled = true;
              options.onEvent({ file, name, status: 'cancelled' });
              return;
            }
            const cli = error instanceof CliError ? error : null;
            const retryable = cli?.code === 'RATE_LIMITED' || cli?.code === 'UPLOAD_BUSY';
            if (!cli || !retryable || retries >= PUSH_AUTO_RETRIES) {
              failed += 1;
              const message = cli?.message ?? (error instanceof Error ? error.message : '上传失败');
              errors.push(message);
              options.onEvent({ file, name, status: 'failed', message });
              return;
            }
            retries += 1;
            const wait = cli.retryAfter != null ? cli.retryAfter * 1000 : 1000 * 2 ** (retries - 1);
            try {
              await sleep(wait, child.signal);
            } catch {
              cancelled = true;
              options.onEvent({ file, name, status: 'cancelled' });
              return;
            }
          }
        }
      } finally {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
    pump();
  });
  return { items, failed, cancelled, errors };
}
