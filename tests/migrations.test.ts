import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';

for (const version of [1, 2, 3, 4]) test(`version-${version} data survives current migrations and subsequent reopening`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-migration-')); const path = join(directory, 'state.sqlite');
  const snapshot = { id: 'legacy-snapshot', kind: 'roots' as const, items: [], completedAt: '2026-10-20T00:00:00.000Z',
    stamp: { id: 'instance', pluginId: 'legacy', epoch: 1, pluginRevision: 'old', pluginGeneration: 1 } };
  try {
    const legacy = new Database(path);
    legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0001.sql').text());
    if (version >= 2) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0002.sql').text());
    if (version >= 3) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0003.sql').text());
    if (version >= 4) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0004.sql').text());
    legacy.exec(`PRAGMA user_version = ${version}`);
    legacy.query('INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, ?)').run('legacy', '{}', 'old', 'active');
    legacy.query('INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES (?, ?, ?, ?, ?, 1, 1)')
      .run('instance', 'legacy', '保留', '{"server":"original"}', '{"session":"fixture"}');
    if (version >= 2) legacy.query('INSERT INTO directory_snapshots (instance_id, kind, ref, request_id, document) VALUES (?, ?, ?, ?, ?)')
      .run('instance', 'roots', '', 'old-request', JSON.stringify(snapshot));
    legacy.close();
    let current = openSqlite(path);
    expect(current.instances()[0]?.config).toEqual({ server: 'original' }); expect(current.capture('instance')?.privateState).toEqual({ session: 'fixture' });
    expect(current.capture('instance')?.authentication).toBeNull();
    if (version >= 2) expect(current.snapshot('instance', { kind: 'roots', ref: '' })?.value).toEqual(snapshot);
    expect(current.layout()).toEqual({ revision: 0, nodes: null }); expect(current.saveLayout(0, [])).toBe(true); current.close();
    current = openSqlite(path); expect(current.layout()).toEqual({ revision: 1, nodes: [] }); expect(current.instances()).toHaveLength(1); current.close();
    const migrated = new Database(path); expect(migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(5); migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
