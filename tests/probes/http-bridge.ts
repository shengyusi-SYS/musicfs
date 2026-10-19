import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { httpServerHandler } from 'cloudflare:node';

const server = createServer((request, response) => {
  const mode = request.url;
  if (mode === '/direct') { response.setHeader('Content-Length', 4); response.end('RIFF'); return; }
  const abort = new AbortController();
  const web = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('RIFF')); controller.close(); }
  });
  const stream = mode === '/node-stream' ? Readable.from(['RIFF']) : Readable.fromWeb(web as unknown as Parameters<typeof Readable.fromWeb>[0]);
  if (mode === '/request-close') request.on('close', () => stream.destroy(new Error('Request aborted.')));
  if (mode === '/response-close') response.on('close', () => abort.abort(new Error('Response closed')));
  response.setHeader('Content-Length', 4);
  if (mode === '/flush') response.flushHeaders();
  if (mode === '/pipe-event') response.once('pipe', () => response.flushHeaders());
  if (mode === '/timer') setTimeout(() => {}, 1);
  stream.on('error', () => { if (!response.destroyed) response.destroy(); });
  stream.pipe(response);
});
server.listen(3000);
export default httpServerHandler({ port: 3000 });
