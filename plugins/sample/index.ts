import type { Context, FileInfo, Json, Outcome, SourcePlugin } from '@musicfs/plugin-api';
import schema from './config.schema.json';
import translations from './translations.json';
import validate from './generated-config.mjs';

// A small, deterministic 16-bit mono WAV. The plugin has no account or quality model.
function wav(): Uint8Array {
  const sampleRate = 8000;
  const samples = sampleRate;
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, data.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let n = 0; n < samples; n++) view.setInt16(44 + n * 2, (n * 440) % sampleRate < sampleRate / 2 ? 4096 : -4096, true);
  return data;
}
const bytes = wav();
const content: FileInfo = { contentId: 'wav-pcm16-8000hz-square440-v1', size: bytes.byteLength, mediaType: 'audio/wav' };
const missing = <T>(): Outcome<T> => ({ ok: false, error: { kind: 'not_found', message: 'Sample entry not found' } });
const label = (ctx: Context) => (ctx.config as { label: string }).label;

const plugin: SourcePlugin = {
  configuration: { schema, translations },
  async validateConfig(_ctx, candidate: Json) {
    return validate(candidate) ? { ok: true, value: candidate } : {
      ok: false, error: { kind: 'invalid_config', message: 'Invalid source settings',
        fields: (validate.errors ?? []).map(e => ({ path: e.instancePath, message: e.message ?? 'Invalid value' })) }
    };
  },
  async roots(ctx) { return { ok: true, value: { items: [{ sourceId: 'audio', name: label(ctx), directoryRef: '/' }] } }; },
  async list(_ctx, directory) {
    return directory === '/' ? { ok: true, value: { items: [{ kind: 'file', entryId: 'tone-occurrence', name: '440 Hz.wav', fileRef: 'tone', info: content }] } } : missing();
  },
  async stat(_ctx, file) { return file === 'tone' ? { ok: true, value: content } : missing(); },
  async open(ctx, file, request) {
    if (file !== 'tone') return missing();
    if (request.expectedContentId !== content.contentId) return { ok: false, error: { kind: 'content_changed', message: 'Sample version changed' } };
    const range = request.range ?? { start: 0, end: bytes.byteLength - 1 };
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end >= bytes.byteLength) {
      return { ok: false, error: { kind: 'not_supported', message: 'Invalid byte range' } };
    }
    let offset = range.start;
    return { ok: true, value: {
      content, servedRange: request.range ?? null,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (ctx.signal.aborted) { controller.error(ctx.signal.reason); return; }
          if (offset > range.end) { controller.close(); return; }
          const end = Math.min(offset + 1024, range.end + 1);
          controller.enqueue(bytes.slice(offset, end)); offset = end;
        }
      })
    } };
  }
};
export default plugin;
