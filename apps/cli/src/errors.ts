export class CliError extends Error {
  readonly fatal: boolean;
  retryAfter: number | null = null;
  constructor(readonly code: string, message: string, readonly exitCode = 1, fatal = false) {
    super(message);
    this.name = 'CliError';
    this.fatal = fatal;
  }
}

export function isFatal(error: unknown): boolean {
  return error instanceof CliError && (error.fatal || error.exitCode === 2);
}

export function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length < 20) continue;
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const errno = error as NodeJS.ErrnoException;
  if (errno?.code === 'ECONNREFUSED' || errno?.code === 'ENOTFOUND' || errno?.code === 'EAI_AGAIN') {
    return new CliError('UNAVAILABLE', '无法连接服务器');
  }
  if (errno?.code === 'ETIMEDOUT' || errno?.message === 'timeout') {
    return new CliError('UNAVAILABLE', '连接超时');
  }
  const message = error instanceof Error ? error.message : '未知错误';
  return new CliError('INTERNAL', message);
}
