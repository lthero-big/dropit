import { ApiError, type Identity } from '../src/domain.js';
import { SqliteRepository } from '../src/repository.js';

const path = process.env.RACE_PATH ?? '';
const subject = process.env.RACE_SUBJECT ?? '';
const repo = new SqliteRepository(path);
try {
  const identity: Identity = { provider: 'github', subject, email: process.env.RACE_EMAIL ?? '', name: subject };
  const user = repo.login(identity, null, [], process.env.RACE_HASH ?? subject, Date.now() + 86_400_000, Date.now());
  process.stdout.write(JSON.stringify({ ok: true, role: user.role }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error instanceof ApiError ? error.code : 'ERROR' }));
} finally {
  repo.close();
}
