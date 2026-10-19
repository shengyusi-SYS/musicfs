import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js/index-native.js';
import type { HostKind } from '@musicfs/plugin-api';
import { ExtensionError, isPackagePath, parseManifest, type PreparedPackage } from '../../core/extensions';

export type PackageLimits = { compressedBytes: number; totalBytes: number; entryBytes: number; entries: number };
export const DEFAULT_PACKAGE_LIMITS: PackageLimits = {
  compressedBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, entries: 256
};

/** Uses native JS codecs with no Web Worker or WASM runtime requirement. */
export async function readPackage(
  archive: Uint8Array, host: HostKind, signal: AbortSignal, limits = DEFAULT_PACKAGE_LIMITS
): Promise<PreparedPackage> {
  signal.throwIfAborted();
  if (archive.byteLength > limits.compressedBytes) throw new ExtensionError('invalid_package', 'Plugin archive is too large');
  const reader = new ZipReader(new Uint8ArrayReader(archive), {
    useWebWorkers: false, useCompressionStream: false, strictness: 'strict', checkSignature: true, checkOverlappingEntry: true
  });
  const files = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let total = 0;
  let count = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal.throwIfAborted();
      const path = entry.directory ? entry.filename.slice(0, -1) : entry.filename;
      if (++count > limits.entries || !isPackagePath(path) || entry.symlink || entry.encrypted || names.has(path.toLowerCase())) {
        throw new ExtensionError('invalid_package', 'Unsupported or duplicate plugin entry');
      }
      names.add(path.toLowerCase());
      if (entry.directory) continue;
      if (entry.uncompressedSize > limits.entryBytes) throw new ExtensionError('invalid_package', 'Plugin entry is too large');
      const chunks: Uint8Array[] = [];
      let size = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.byteLength;
          total += chunk.byteLength;
          if (size > limits.entryBytes || total > limits.totalBytes) {
            throw new ExtensionError('invalid_package', 'Plugin decompression budget exceeded');
          }
          chunks.push(chunk);
        }
      }), { signal });
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      files.set(path, bytes);
    }
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) throw new ExtensionError('invalid_package', 'Missing plugin manifest');
    const manifest = parseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(manifestBytes)), host);
    if (files.size !== manifest.files.length + 1 || manifest.files.some(path => !files.has(path))) {
      throw new ExtensionError('invalid_package', 'Archive files must exactly match the manifest');
    }
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(archive));
    const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    return { manifest, digest, files };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError('invalid_package', 'Invalid plugin ZIP archive');
  } finally {
    await reader.close();
  }
}
