import type { Json, JsonObject, SourcePlugin } from '@musicfs/plugin-api';
import { handleRequest } from './upstream';
import schema from './config.schema.json';
import validate from './generated-config.mjs';
import { authenticate } from './authentication';
import { catalogueContext, migrateState, renewalNeeded, run, validateState, type QqHandler } from './client';
import * as catalog from './catalog';
import * as media from './media';
import { normalizeConfig } from './configuration';

export function createQqPlugin(handler: QqHandler = handleRequest): SourcePlugin {
  return {
    statistics: { tracks: '曲目', files: '导出文件', hiddenTracks: '未导出曲目', missingVersions: '缺失目标版本', fallbackVersions: '回退目标', deduplicatedVersions: '合并重复版本' },
    migrateState: input => migrateState(input.fromVersion, input.state),
    validateState: input => validateState(input.state),
    renewal: { needed: renewalNeeded, renew: ctx => run(ctx, handler, client => client.renew()) },
    configuration: { schema: schema as JsonObject, ui: { order: ['label', 'channel', 'audio', 'metadataCacheDays'] } },
    async validateConfig(ctx, candidate) {
      const config: Json = normalizeConfig(candidate);
      if (!validate(config)) return { ok: false, error: { kind: 'invalid_config', message: '请检查 QQ 实例配置。',
        fields: (validate.errors ?? []).map(error => ({ path: error.instancePath, message: error.message ?? '配置无效' })) } };
      return run(ctx, handler, async () => config);
    },
    authenticate: (ctx, action) => run(ctx, handler, client => authenticate(client, action)),
    roots: (ctx, cursor) => run(ctx, handler, client => catalog.roots(client, cursor)),
    list: (ctx, directory, cursor) => run(catalogueContext(ctx), handler, client => catalog.list(client, directory, cursor)),
    stat: (ctx, file) => run(ctx, handler, client => media.stat(client, file)),
    open: (ctx, file, request) => run(ctx, handler, client => media.open(client, file, request))
  };
}
export default createQqPlugin();
