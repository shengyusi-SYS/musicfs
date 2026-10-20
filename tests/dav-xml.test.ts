import { expect, test } from 'bun:test';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { Description, ViewEntry } from '../src/core/library';
import { propfindResponse } from '../src/transport/dav/xml';

test('one compiled property request preserves per-resource dates, namespace identities and failures', async () => {
  const parent: Description = { kind: 'directory', path: '/root', name: 'Root', modifiedAt: '2026-10-20T00:00:00Z', etag: 'root' };
  const first: ViewEntry = { kind: 'file', path: '/root/A & B.flac', name: 'A & B.flac', modifiedAt: '2026-10-19T00:00:00Z' };
  const second: ViewEntry = { kind: 'directory', path: '/root/folder', name: 'folder', modifiedAt: '2026-10-18T00:00:00Z' };
  const failed: ViewEntry = { ...first, path: '/root/unavailable.flac', name: 'unavailable.flac' };
  const metadata: Description = { ...first, kind: 'file', etag: 'file', handle: {
    stamp: { id: 'fixture', pluginId: 'fixture', epoch: 1, pluginRevision: 'fixture', pluginGeneration: 1 },
    fileRef: 'file', content: { contentId: 'file', size: 16, mediaType: 'audio/flac' }
  } };
  const properties = ['displayname', 'getlastmodified', 'getcontentlength'].map(name => ({ namespace: 'DAV:', name }));
  const xml = await propfindResponse(parent, [first, second, failed], { mode: 'prop', properties: [
    ...properties, properties[0]!, { namespace: 'urn:first', name: 'displayname' }, { namespace: 'urn:second', name: 'displayname' }
  ] }, async entry => { if (entry === failed) throw new Error('Unavailable'); return entry === first ? metadata : { ...second, kind: 'directory', etag: 'folder' }; }, () => 503);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'));
  const text = (entry: Element, namespace: string, name: string) => Array.from(entry.getElementsByTagNameNS(namespace, name)).map(node => node.textContent);
  expect(responses).toHaveLength(4);
  expect(text(responses[1]!, 'DAV:', 'displayname')).toEqual(['A & B.flac']);
  expect(text(responses[1]!, 'DAV:', 'getlastmodified')).toEqual(['Mon, 19 Oct 2026 00:00:00 GMT']);
  expect(text(responses[2]!, 'DAV:', 'getlastmodified')).toEqual(['Sun, 18 Oct 2026 00:00:00 GMT']);
  expect(text(responses[1]!, 'DAV:', 'getcontentlength')).toEqual(['16']);
  expect(text(responses[2]!, 'DAV:', 'status')).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 404 Not Found']);
  expect(text(responses[1]!, 'urn:first', 'displayname')).toEqual(['']);
  expect(text(responses[1]!, 'urn:second', 'displayname')).toEqual(['']);
  expect(text(responses[3]!, 'DAV:', 'status')).toEqual(['HTTP/1.1 503 Resource unavailable']);
});
