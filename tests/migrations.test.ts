import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '../src/infrastructure/persistence/sqlite';
import { cachePluginDataPlan } from '../src/infrastructure/persistence/plugin-cache-sql';

for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) test(`version-${version} data survives current migrations and subsequent reopening`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicfs-migration-')); const path = join(directory, 'state.sqlite');
  const snapshot = { id: 'legacy-snapshot', kind: 'roots' as const, items: [], completedAt: '2026-10-20T00:00:00.000Z',
    stamp: { id: 'instance', pluginId: 'legacy', epoch: 1, pluginRevision: 'old', pluginGeneration: 1 } };
  try {
    const legacy = new Database(path);
    legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0001.sql').text());
    if (version >= 2) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0002.sql').text());
    if (version >= 3) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0003.sql').text());
    if (version >= 4) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0004.sql').text());
    if (version >= 5) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0005.sql').text());
    if (version >= 6) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0006.sql').text());
    if (version >= 7) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0007.sql').text());
    if (version >= 8) legacy.exec(await Bun.file('src/infrastructure/persistence/migrations/0008.sql').text());
    legacy.exec(`PRAGMA user_version = ${version}`);
    legacy.query('INSERT INTO installations (id, manifest, revision, generation, status) VALUES (?, ?, ?, 1, ?)').run('legacy', '{}', 'old', 'active');
    legacy.query('INSERT INTO instances (id, plugin_id, name, config, private_state, epoch, state_revision) VALUES (?, ?, ?, ?, ?, 1, 1)')
      .run('instance', 'legacy', '保留', '{"server":"original"}', '{"session":"fixture"}');
    if (version >= 8) legacy.query("INSERT INTO source_plugin_cache VALUES ('instance', 'plan', 1, 'old', 1, '{\"retained\":true}', NULL)").run();
    if (version >= 2) legacy.query('INSERT INTO directory_snapshots (instance_id, kind, ref, request_id, document) VALUES (?, ?, ?, ?, ?)')
      .run('instance', 'roots', '', 'old-request', JSON.stringify(snapshot));
    const oldChange = JSON.stringify({ view: { operationId: 'old-change', status: 'completed' }, expectedGeneration: 1, revision: 'old', registry: 'retained-registry' });
    if (version >= 4) {
      legacy.query(`INSERT INTO ${version >= 6 ? 'plugin_changes' : 'worker_plugin_changes'} (operation_id, status, document) VALUES ('old-change', 'completed', ?)`).run(oldChange);
      legacy.query("INSERT INTO worker_plugin_change_files (operation_id, name, chunk_index, bytes) VALUES ('old-change', 'fixture.mjs', 0, ?)").run(new Uint8Array([1, 2, 3]));
    }
    if (version >= 6) legacy.query(`INSERT INTO plugin_change_instances (operation_id, instance_id, plugin_id, name, config, private_state,
      epoch, state_revision, candidate_config, candidate_state) VALUES ('old-change', 'instance', 'legacy', '保留', '{}', '{"old":true}', 1, 1, '{"new":true}', 'null')`).run();
    legacy.close();
    let current = openSqlite(path);
    expect(current.instances()[0]?.config).toEqual({ server: 'original' }); expect(current.capture('instance')?.privateState).toEqual({ session: 'fixture' });
    expect(current.capture('instance')?.authentication).toBeNull();
    if (version >= 2) expect(current.snapshot('instance', { kind: 'roots', ref: '' })?.value).toEqual(snapshot);
    expect(current.layout()).toEqual({ revision: 0, nodes: null }); expect(current.saveLayout(0, [])).toBe(true); current.close();
    current = openSqlite(path); expect(current.layout()).toEqual({ revision: 1, nodes: [] }); expect(current.instances()).toHaveLength(1); current.close();
    const migrated = new Database(path);
    expect(migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(9);
    if (version >= 8) {
      expect(migrated.query<{ document: string }, []>('SELECT document FROM source_plugin_cache').get()?.document).toBe('{"retained":true}');
      const cleanup = cachePluginDataPlan({ id: 'instance', pluginId: 'legacy', epoch: 1, pluginRevision: 'old', pluginGeneration: 1 }, 'probe', 'null', null, 1000)[0]!;
      const plan = migrated.query<{ detail: string }, (string | number | null)[]>('EXPLAIN QUERY PLAN ' + cleanup.sql).all(...cleanup.values).map(row => row.detail).join('\n');
      expect(plan).toContain('source_plugin_cache_expiry'); expect(plan).toContain('source_plugin_cache_scope');
      expect(plan).not.toContain('SCAN source_plugin_cache');
    }
    if (version >= 4) {
      expect(migrated.query<{ document: string; revision: number }, []>('SELECT document, revision FROM plugin_changes').get()).toEqual({ document: oldChange, revision: 0 });
      expect(migrated.query<{ table: string }, []>('PRAGMA foreign_key_list(worker_plugin_change_files)').get()?.table).toBe('plugin_changes');
      expect(migrated.query<{ count: number }, []>('SELECT count(*) AS count FROM worker_plugin_change_files').get()?.count).toBe(1);
    }
    expect(migrated.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_change_instances').get()?.count).toBe(version >= 6 ? 1 : 0);
    if (version >= 6) expect(migrated.query<{ candidate_config: string; candidate_state: string }, []>('SELECT candidate_config, candidate_state FROM plugin_change_instances').get())
      .toEqual({ candidate_config: '{"new":true}', candidate_state: 'null' });
    expect(migrated.query<{ count: number }, []>('SELECT count(*) AS count FROM source_renewals').get()?.count).toBe(0);
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
