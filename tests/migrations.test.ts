import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

for (const version of [1, 2, 3]) test(`version-${version} data survives current migrations and subsequent reopening`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-migration-')); const path = join(directory, 'state.sqlite');
  try {
    const legacy = new Database(path);
    legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0001.sql').text());
    if (version >= 2) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0002.sql').text());
    if (version >= 3) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0003.sql').text());
    legacy.exec(`PRAGMA user_version = ${version}`);
    legacy.query('INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, ?)').run('legacy', '{}', 'old', 'active');
    legacy.query('INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES (?, ?, ?, ?, ?, 1, 1)')
      .run('instance', 'legacy', '保留', '{"server":"original"}', '{"session":"fixture"}');
    legacy.close();
    let current = openSqlite(path);
    expect(current.instances()[0]?.config).toEqual({ server: 'original' }); expect(current.capture('instance')?.privateState).toEqual({ session: 'fixture' });
    expect(current.capture('instance')?.authentication).toBeNull();
    expect(current.layout()).toEqual({ revision: 0, nodes: null }); expect(current.saveLayout(0, [])).toBe(true); current.close();
    current = openSqlite(path); expect(current.layout()).toEqual({ revision: 1, nodes: [] }); expect(current.instances()).toHaveLength(1); current.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
