import { parentPort, workerData } from 'node:worker_threads';
import { ApiError, type Identity } from '../src/domain.js';
import { SqliteRepository } from '../src/repository.js';

const data = workerData as { path: string; subject: string; email: string; admins: string[]; sessionHash: string };
const repo = new SqliteRepository(data.path);
try {
  const identity: Identity = { provider: 'github', subject: data.subject, email: data.email, name: data.subject };
  const user = repo.login(identity, null, data.admins, data.sessionHash, Date.now() + 86_400_000, Date.now());
  parentPort?.postMessage({ ok: true, role: user.role, id: user.id });
} catch (error) {
  parentPort?.postMessage({ ok: false, code: error instanceof ApiError ? error.code : 'ERROR' });
} finally {
  repo.close();
}
