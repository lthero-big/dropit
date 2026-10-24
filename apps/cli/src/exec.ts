import { spawn } from 'node:child_process';
import { CliError } from './errors.js';
import type { Item } from './items.js';

export function itemEnv(item: Item): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DROPIT_ITEM_ID: item.id,
    DROPIT_ITEM_KIND: item.kind,
    DROPIT_ITEM_FILENAME: item.filename ?? '',
    DROPIT_ITEM_MIME: item.mime ?? '',
    DROPIT_ITEM_SIZE: String(item.size),
    DROPIT_ITEM_SPACE: item.spaceId,
    DROPIT_ITEM_TEXT: item.kind === 'text' ? item.text ?? '' : '',
  };
}

export function runItemCommand(argv: readonly string[], item: Item, body: Buffer): Promise<void> {
  const command = argv[0];
  if (!command) throw new CliError('USAGE', '缺少 --exec 后面的命令', 2);
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv.slice(1), {
      shell: false,
      env: itemEnv(item),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.on('error', (error) => finish(new CliError('EXEC_FAILED', error.message)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new CliError('EXEC_FAILED', `命令退出码 ${code ?? 'unknown'}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(body);
  });
}
