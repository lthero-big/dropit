import { CliError } from './errors.js';

export interface Globals {
  json: boolean;
  help: boolean;
  url?: string;
  space?: string;
  room?: string;
}

export type Command =
  | { kind: 'help' }
  | { kind: 'login'; name?: string; scopes?: Array<'read' | 'write'>; expiresInDays?: number | null }
  | { kind: 'logout' }
  | { kind: 'whoami' }
  | { kind: 'send'; text?: string }
  | { kind: 'push'; files: string[]; keep: boolean }
  | { kind: 'ls' }
  | { kind: 'get'; id: string; output?: string; resume: boolean; force: boolean; jobs: number }
  | { kind: 'rm'; id: string }
  | { kind: 'share'; id: string; expires: '1h' | '1d' | '7d' | 'never'; maxViews: number | null }
  | { kind: 'watch'; exec?: string[] }
  | { kind: 'room-new'; code?: string; pin?: string }
  | { kind: 'room-enter'; code: string; pin?: string }
  | { kind: 'room-join'; target: string };

export interface Parsed {
  globals: Globals;
  command: Command;
}

const EXPIRES = new Set(['1h', '1d', '7d', 'never']);

function missing(flag: string): never {
  throw new CliError('USAGE', `缺少 ${flag} 的值`, 2);
}

function integer(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new CliError('USAGE', `${flag} 必须是整数`, 2);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliError('USAGE', `${flag} 必须在 ${min} 到 ${max} 之间`, 2);
  }
  return value;
}

export function parseArgs(argv: string[]): Parsed {
  const globals: Globals = { json: false, help: false };
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let exec: string[] | undefined;
  const take = (flag: string, index: number): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith('-')) missing(flag);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--json') { globals.json = true; continue; }
    if (arg === '--help' || arg === '-h') { globals.help = true; continue; }
    if (arg === '--url') { globals.url = take('--url', ++i); continue; }
    if (arg === '--space') { globals.space = take('--space', ++i); continue; }
    if (arg === '--room') { globals.room = take('--room', ++i); continue; }
    if (arg === '--exec') {
      exec = argv.slice(i + 1);
      if (exec[0] === '--') exec.shift();
      if (!exec.length || !exec[0]) throw new CliError('USAGE', '缺少 --exec 后面的命令', 2);
      break;
    }
    if (arg === '-c' || arg === '--continue') { flags.set('continue', '1'); continue; }
    if (arg === '--force') { flags.set('force', '1'); continue; }
    if (arg === '--keep') { flags.set('keep', '1'); continue; }
    if (arg === '--jobs') { flags.set('jobs', take('--jobs', ++i)); continue; }
    if (arg === '-o' || arg === '--output') { flags.set('output', take(arg, ++i)); continue; }
    if (arg === '--code' || arg === '--pin') { flags.set(arg.slice(2), take(arg, ++i)); continue; }
    if (arg === '--name' || arg === '--scopes' || arg === '--expires-in-days' || arg === '--expires' || arg === '--max-views') {
      flags.set(arg.slice(2), take(arg, ++i));
      continue;
    }
    if (arg.startsWith('-')) throw new CliError('USAGE', `未知选项 ${arg}`, 2);
    positionals.push(arg);
  }
  if (globals.help && positionals.length === 0) return { globals, command: { kind: 'help' } };
  const name = positionals[0];
  if (!name) throw new CliError('USAGE', '缺少命令。运行 dropit --help 查看用法。', 2);
  if (globals.help) return { globals, command: { kind: 'help' } };
  const extra = (allowed: string[]) => {
    for (const key of flags.keys()) {
      if (!allowed.includes(key)) throw new CliError('USAGE', `选项 --${key} 不能用于 ${name}`, 2);
    }
    if (exec && name !== 'watch') throw new CliError('USAGE', '--exec 只能用于 watch', 2);
  };
  const one = (label: string) => {
    if (positionals.length < 2 || !positionals[1]) throw new CliError('USAGE', `缺少 ${label}`, 2);
    if (positionals.length > 2) throw new CliError('USAGE', `${name} 只接受一个 ${label}`, 2);
    return positionals[1];
  };
  switch (name) {
    case 'help':
      extra([]);
      return { globals, command: { kind: 'help' } };
    case 'login': {
      extra(['name', 'scopes', 'expires-in-days']);
      if (positionals.length > 1) throw new CliError('USAGE', 'login 不接受位置参数', 2);
      let scopes: Array<'read' | 'write'> | undefined;
      if (flags.has('scopes')) {
        const parts = flags.get('scopes')!.split(',').map(part => part.trim()).filter(Boolean);
        if (!parts.length || parts.some(part => part !== 'read' && part !== 'write') || new Set(parts).size !== parts.length) {
          throw new CliError('USAGE', '--scopes 只能是 read 与 write 的组合', 2);
        }
        scopes = parts as Array<'read' | 'write'>;
      }
      let expiresInDays: number | null | undefined;
      if (flags.has('expires-in-days')) {
        const raw = flags.get('expires-in-days')!;
        expiresInDays = raw === 'never' ? null : integer(raw, '--expires-in-days', 1, 3650);
      }
      return { globals, command: { kind: 'login', name: flags.get('name'), scopes, expiresInDays } };
    }
    case 'logout':
    case 'whoami':
      extra([]);
      if (positionals.length > 1) throw new CliError('USAGE', `${name} 不接受位置参数`, 2);
      return { globals, command: { kind: name } };
    case 'send':
      extra([]);
      return { globals, command: { kind: 'send', text: positionals.length > 1 ? positionals.slice(1).join(' ') : undefined } };
    case 'push':
      extra(['keep']);
      if (positionals.length < 2) throw new CliError('USAGE', 'push 至少需要一个文件', 2);
      return { globals, command: { kind: 'push', files: positionals.slice(1), keep: flags.has('keep') } };
    case 'ls':
      extra([]);
      if (positionals.length > 1) throw new CliError('USAGE', 'ls 不接受位置参数', 2);
      return { globals, command: { kind: 'ls' } };
    case 'get':
      extra(['output', 'continue', 'force', 'jobs']);
      return {
        globals,
        command: {
          kind: 'get',
          id: one('id'),
          output: flags.get('output'),
          resume: flags.has('continue'),
          force: flags.has('force'),
          jobs: flags.has('jobs') ? integer(flags.get('jobs')!, '--jobs', 1, 8) : 1,
        },
      };
    case 'rm':
      extra([]);
      return { globals, command: { kind: 'rm', id: one('id') } };
    case 'share': {
      extra(['expires', 'max-views']);
      const expires = flags.get('expires');
      if (!expires || !EXPIRES.has(expires)) throw new CliError('USAGE', '--expires 必须是 1h、1d、7d 或 never', 2);
      const maxViews = flags.has('max-views') ? integer(flags.get('max-views')!, '--max-views', 1, 100) : null;
      return { globals, command: { kind: 'share', id: one('id'), expires: expires as '1h' | '1d' | '7d' | 'never', maxViews } };
    }
    case 'watch':
      extra([]);
      if (positionals.length > 1) throw new CliError('USAGE', 'watch 的参数请放在 --exec 后面', 2);
      return { globals, command: { kind: 'watch', exec } };
    case 'room': {
      const action = positionals[1];
      extra(action === 'new' ? ['code', 'pin'] : action === 'enter' ? ['pin'] : []);
      if (action === 'new') {
        if (positionals.length > 2) throw new CliError('USAGE', 'room new 不接受其他参数', 2);
        if (flags.has('pin') && !flags.has('code')) throw new CliError('USAGE', '--pin 需要和 --code 一起使用', 2);
        return { globals, command: { kind: 'room-new', code: flags.get('code'), pin: flags.get('pin') } };
      }
      if (action === 'enter') {
        const code = positionals[2];
        if (!code) throw new CliError('USAGE', '缺少房间码', 2);
        if (positionals.length > 3) throw new CliError('USAGE', 'room enter 只接受一个房间码', 2);
        return { globals, command: { kind: 'room-enter', code, pin: flags.get('pin') } };
      }
      if (action === 'join') {
        const target = positionals[2];
        if (!target) throw new CliError('USAGE', '缺少房间链接', 2);
        if (positionals.length > 3) throw new CliError('USAGE', 'room join 只接受一个链接', 2);
        return { globals, command: { kind: 'room-join', target } };
      }
      throw new CliError('USAGE', 'room 的子命令是 new、join 或 enter', 2);
    }
    default:
      throw new CliError('USAGE', `未知命令 ${name}`, 2);
  }
}

export const usageText = `dropit — 云剪贴板命令行

用法
  dropit login [--url <url>] [--name <设备名>] [--scopes read,write] [--expires-in-days <天数|never>]
  dropit logout
  dropit whoami
  dropit send [文本...]
  dropit push <文件>... [--keep]
  dropit ls
  dropit get <id|latest> [-o <目录>] [-c] [--force] [--jobs <1-8>]
  dropit rm <id|latest>
  dropit share <id|latest> --expires <1h|1d|7d|never> [--max-views <次数>]
  dropit watch [--exec [--] <命令> [参数...]]
  dropit room new [--code <房间码> [--pin <PIN>]]
  dropit room join <链接或令牌>
  dropit room enter <房间码> [--pin <PIN>]

全局选项
  --url <url>            服务地址，优先于 DROPIT_URL 与配置文件
  --space <id|名称>      这次使用该空间，并记住为默认目标
  --room <链接或令牌>    这次使用该临时房间，并记住为默认目标
  --json                 成功时向 stdout 输出 JSON；错误 JSON 写到 stderr
  -h, --help

环境变量优先于配置文件：DROPIT_URL、DROPIT_TOKEN。
配置文件默认在 $XDG_CONFIG_HOME/dropit/config.json（否则 ~/.config/dropit/config.json），权限 0600。
可用 DROPIT_CONFIG 指定配置文件路径。令牌不会打印到终端。
退出码：0 成功，2 用法错误，130 被中断，其他非 0 为失败。错误写到 stderr。
没有 TTY 时不会询问输入。send 在没有参数时从 stdin 读取。
不小于 256 KiB 的 push 按分片上传，最多 3 个分片并行，失败分片会重试。再次执行同一命令会从配置目录的 uploads.json 续传。该文件权限 0600，不含令牌。Ctrl+C 删除未完成的服务器会话；--keep 保留它。
get 不加 -o 时把内容写到 stdout。-c 续传已有文件。--jobs 大于 1 时并行 Range 下载到临时文件，完成后原子改名。符号链接一律拒绝，默认不覆盖已有文件。
watch 断线后按指数退避重连，并用新的 snapshot 对账。
--exec 不经过 shell；条目正文从 stdin 传入，元数据放在 DROPIT_ITEM_* 环境变量里。
`;
