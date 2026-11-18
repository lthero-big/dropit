import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const PASSWORD = 'Ｐａｓｓｗｏｒｄ-é-🔐';
export const NORMALIZED_PASSWORD = 'Password-e\u0301-🔐';

/** Schema, hashes, sessions and seed items all come from the TS baseline. */
export async function fixture(directory, {
  quota = null, itemLimit = null, sessionMs = null,
  referenceRoot = fileURLToPath(new URL('../../../', import.meta.url)),
} = {}) {
  const load = name => import(pathToFileURL(resolve(referenceRoot, 'apps/server/dist/' + name + '.js')));
  const [
    { SqliteRepository }, { hashPasswordSync }, { hash }, { ClipboardService },
    { loadConfig }, { DiskFileStorage }, { MemoryBroadcaster },
  ] = await Promise.all(['repository', 'password', 'domain', 'service', 'config', 'files', 'events'].map(load));
  await mkdir(directory, { recursive: true });
  const repo = new SqliteRepository(resolve(directory, 'dropit.sqlite'));
  const time = Date.now();
  const config = { ...loadConfig({}), dataDir: directory };
  const events = new MemoryBroadcaster();
  const service = new ClipboardService(config, repo, new DiskFileStorage(resolve(directory, 'files')), events, () => time);
  try {
    const alice = repo.createPasswordUser({
      email: 'alice@example.test', name: 'Alice 测试', passwordHash: hashPasswordSync(PASSWORD), now: time, firstAdmin: true,
    });
    const bob = repo.createPasswordUser({
      email: 'bob@example.test', name: 'Bob', passwordHash: hashPasswordSync(PASSWORD), now: time + 1, policy: 'open',
    });
    const viewer = repo.createPasswordUser({
      email: 'viewer@example.test', name: 'Viewer', passwordHash: hashPasswordSync(PASSWORD), now: time + 2, policy: 'open',
    });
    const temporary = repo.createPasswordUser({
      email: 'temporary@example.test', name: 'Temporary', passwordHash: hashPasswordSync(PASSWORD), now: time + 3, policy: 'open',
    });
    repo.setPassword(temporary.id, hashPasswordSync(PASSWORD), true, time);
    const disabled = repo.createPasswordUser({
      email: 'disabled@example.test', name: 'Disabled', passwordHash: hashPasswordSync(PASSWORD), now: time + 4, policy: 'open',
    });
    repo.updateUser(disabled.id, { disabled: true });
    const pending = repo.provisionUser({ email: 'pending@example.test', name: 'Pending', role: 'user', quotaBytes: null, now: time + 5 });
    repo.setPassword(pending.id, hashPasswordSync(PASSWORD), false, time);

    const aliceSpace = repo.spaces(alice.id)[0];
    const bobSpace = repo.spaces(bob.id)[0];
    const oldCookie = 'T'.repeat(43);
    repo.createSession(alice.id, hash(oldCookie), time + 86400000, time, { userAgent: 'TS fixture', ipSummary: '127.0.0.0/24' });
    const existing = service.text(aliceSpace, repo.session(hash(oldCookie), time), 'TS 已有文本 café 🦀\n第二行', {
      group: '历史分组', device: { id: 'fixture-device', name: 'TS 设备', kind: 'cli' },
    });
    const invite = 'read-only-invite';
    repo.createInvite({
      id: 'fixture-invite', tokenHash: hash(invite), spaceId: aliceSpace.id, maxUses: 10, uses: 0, expiresAt: time + 86400000,
      revoked: 0, createdBy: alice.id, joinSpace: 1, createdAt: time, role: 'viewer',
    });
    repo.acceptInvite(hash(invite), viewer.id, time);
    repo.createSession(bob.id, hash('expired-session'), time - 1, time - 1000);
    if (quota !== null) repo.updateUser(alice.id, { quotaBytes: quota });
    const overrides = [];
    for (const [key, value] of [['maxItems', itemLimit], ['sessionMs', sessionMs]]) {
      if (value !== null) overrides.push({ key, oldValue: config[key], newValue: value, oldOverride: null, newOverride: value });
    }
    if (overrides.length) repo.saveLimitChanges(overrides, alice, time);
    const result = { alice, bob, viewer, temporary, disabled, pending, aliceSpace: aliceSpace.id, bobSpace: bobSpace.id, oldCookie, existing, invite };
    await writeFile(resolve(directory, 'fixture.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    events.close();
    repo.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Provide an isolated output directory');
  await fixture(resolve(process.argv[2]));
  console.log('TS schema-19 fixture created');
}
