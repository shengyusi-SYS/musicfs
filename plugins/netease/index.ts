import type { JsonObject, SourcePlugin } from '@musicfs/plugin-api';
import schema from './config.schema.json';
import validate from './generated-config.mjs';
import { authenticate } from './authentication';
import { run, validateState } from './client';
import * as catalog from './catalog';
import * as media from './media';
import { contentConfiguration, migrateConfig, normalizeConfig } from './configuration';
export { normalizeConfig } from './configuration';

const plugin: SourcePlugin = {
  migrateConfig,
  contentConfiguration,
  metadataRefresh: true,
  naming: { fields: { title: '歌名', artist: '歌手', album: '专辑', albumArtist: '专辑艺术家', track: '专辑曲号', disc: '碟号', index: '目录序号', quality: '音质', id: '来源歌曲编号' } },
  validateState: input => validateState(input.state),
  configuration: { schema: schema as JsonObject, ui: { order: ['label', 'quality', 'audio', 'metadataCacheDays'] } },
  statistics: { tracks: '曲目', files: '导出文件', hiddenTracks: '未导出曲目', missingVersions: '缺失目标版本', fallbackVersions: '回退目标', deduplicatedVersions: '合并重复版本' },
  async validateConfig(ctx, candidate) {
    const config = normalizeConfig(candidate);
    if (!validate(config)) return { ok: false, error: { kind: 'invalid_config', message: '请检查网易云实例配置。',
      fields: (validate.errors ?? []).map(error => ({ path: error.instancePath, message: error.message ?? '配置无效' })) } };
    return run(ctx, async () => config);
  },
  authenticate: (ctx, action) => run(ctx, client => authenticate(client, action)),
  roots: (ctx, cursor) => run(ctx, client => catalog.roots(client, cursor)),
  list: (ctx, directory, cursor) => run(ctx, client => catalog.list(client, directory, cursor)),
  stat: (ctx, file) => run(ctx, client => media.stat(client, file)),
  open: (ctx, file, request) => run(ctx, client => media.open(client, file, request))
};
export default plugin;
