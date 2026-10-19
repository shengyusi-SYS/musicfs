import { mkdir, chmod } from 'node:fs/promises';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js/index-native.js';

// Fixed developer probe dependency. Product multi-platform bundling is a separate release step.
const version = 'v1.75.2';
const sha256 = '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702';
const name = `rclone-${version}-linux-amd64`;
const url = `https://downloads.rclone.org/${version}/${name}.zip`;
const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Official rclone download failed (${response.status})`);
const archive = new Uint8Array(await response.arrayBuffer());
if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== sha256) throw new Error('Pinned rclone archive checksum mismatch');
const directory = `dist/tools/${name}`; await mkdir(directory, { recursive: true });
const zip = new ZipReader(new Uint8ArrayReader(archive), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
try {
  for await (const entry of zip.getEntriesGenerator()) {
    if (entry.directory) continue;
    for (const file of ['rclone', 'README.txt']) if (entry.filename === `${name}/${file}`) {
      await Bun.write(`${directory}/${file}`, await entry.getData(new Uint8ArrayWriter()));
    }
  }
} finally { await zip.close(); }
if (!await Bun.file(`${directory}/rclone`).exists()) throw new Error('Official archive is missing rclone');
await chmod(`${directory}/rclone`, 0o755);
await Bun.write(`${directory}/release.json`, JSON.stringify({ version, platform: 'linux-amd64', url, sha256 }, null, 2) + '\n');
console.log(`Verified ${version} at ${directory}/rclone`);
