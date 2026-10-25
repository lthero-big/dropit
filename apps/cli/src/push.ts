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
  speed?: number;
  eta?: number | null;
  report?: boolean;
  message?: string;
};

export interface PushOutput {
  stderr: { write(chunk: string): unknown };
  stderrIsTTY: boolean;
  json?: boolean;
}

export interface ProgressSample {
  speed: number;
  eta: number | null;
}

export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '剩余 --';
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `剩余 ${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return `剩余 ${minutes}m${String(rounded % 60).padStart(2, '0')}s`;
}

export function sampleProgress(startedAt: number, sent: number, total: number, now = Date.now()): ProgressSample {
  const elapsed = Math.max(0.05, (now - startedAt) / 1000);
  const speed = sent > 0 ? sent / elapsed : 0;
  const eta = speed > 0 && sent < total ? (total - sent) / speed : sent >= total ? 0 : null;
  return { speed, eta };
}

export function formatProgress(label: string, sent: number, total: number, speed?: number, eta?: number | null): string {
  const pct = total > 0 ? Math.min(100, Math.floor((sent * 100) / total)) : 0;
  const base = `${label} ${String(pct).padStart(3, ' ')}%  ${sent}/${total}`;
  if (speed == null) return base;
  return `${base}  ${formatRate(speed)}  ${formatEta(eta ?? null)}`;
}

function publicEvent(event: PushEvent): Record<string, unknown> {
  return {
    status: event.status,
    name: event.name,
    ...(event.sent != null ? { sent: event.sent } : {}),
    ...(event.total != null ? { total: event.total } : {}),
    ...(event.speed != null ? { speed: Math.round(event.speed) } : {}),
    ...(event.eta != null ? { eta: Math.round(event.eta) } : {}),
    ...(event.message ? { message: event.message } : {}),
  };
}

export function createPushWriter(output: PushOutput): (event: PushEvent) => void {
  let current = '';
  return (event) => {
    const name = event.name;
    if (output.json) {
      if (event.status === 'uploading' && event.sent != null && !event.report) return;
      output.stderr.write(`${JSON.stringify(publicEvent(event))}\n`);
      return;
    }
    if (!output.stderrIsTTY) {
      if (event.status === 'uploading' && event.sent != null && !event.report) return;
      if (event.report && event.sent != null && event.total != null) {
        output.stderr.write(`${formatProgress(name, event.sent, event.total, event.speed, event.eta)}\n`);
        return;
      }
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
      output.stderr.write(`\r${formatProgress(name, event.sent, event.total, event.speed, event.eta)}\x1b[K`);
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
  upload: (file: string, onProgress: (sent: number, total: number, extra?: { speed?: number; eta?: number | null; report?: boolean }) => void, signal: AbortSignal) => Promise<Item>;
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
            const item = await options.upload(file, (sent, total, extra) => {
              options.onEvent({
                file, name, status: 'uploading', sent, total,
                speed: extra?.speed, eta: extra?.eta, report: extra?.report,
              });
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
