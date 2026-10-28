// RHEA-190 auth step 2: offline recovery for a lost admin password.
//   docker exec dropit dropit-admin reset-password <email>
// Opens the same SQLite database as the server (DATA_DIR), sets a temporary password,
// forces a change at next sign-in and signs the account out everywhere.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteRepository } from './repository.js';
import { hashPasswordSync, temporaryPassword } from './password.js';

export interface AdminCliIo { out: (line: string) => void; err: (line: string) => void }

const usage = `Usage:
  dropit-admin reset-password <email>   set a temporary password (must be changed at next sign-in)
  dropit-admin list-users               list accounts (email, role, state)

Reads the database in DATA_DIR (default /data in the Docker image).`;

export function runAdminCli(args: string[], env: NodeJS.ProcessEnv = process.env, io: AdminCliIo = { out: console.log, err: console.error }, now = Date.now()): number {
  const [command, email] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') { io.out(usage); return command ? 0 : 1; }
  const dataDir = env.DATA_DIR || fileURLToPath(new URL('../../../data', import.meta.url));
  if (command === 'list-users') {
    const repo = new SqliteRepository(join(dataDir, 'dropit.sqlite'));
    try {
      const users = repo.users();
      if (!users.length) io.out('No accounts yet. Open /setup (the setup code is in the server log).');
      for (const user of users) io.out(`${user.email}\t${user.role}\t${user.disabled ? 'disabled' : user.pending ? 'pending' : 'active'}\t${user.hasPassword ? 'password' : 'no password'}`);
      return 0;
    } finally { repo.close(); }
  }
  if (command !== 'reset-password') { io.err(`Unknown command: ${command}\n\n${usage}`); return 1; }
  if (!email) { io.err(usage); return 1; }
  const repo = new SqliteRepository(join(dataDir, 'dropit.sqlite'));
  try {
    const account = repo.passwordAccount(email.trim().toLowerCase());
    if (!account) { io.err(`No account with email ${email}. Run "dropit-admin list-users" to see them.`); return 2; }
    const temporary = temporaryPassword();
    repo.setPassword(account.id, hashPasswordSync(temporary), true, now);
    repo.revokeSessions(account.id);
    if (account.disabled) io.err(`Warning: ${account.email} is disabled; another admin must enable it before it can sign in.`);
    io.out(`Temporary password for ${account.email} (${account.role}): ${temporary}`);
    io.out('Sign in with it at /login; you will be asked to choose a new password. All existing sessions were signed out.');
    return 0;
  } finally { repo.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = runAdminCli(process.argv.slice(2));
