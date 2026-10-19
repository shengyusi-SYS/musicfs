import { DOMImplementation, DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { HTTPException } from 'hono/http-exception';
import type { Description, ViewEntry } from '../../core/library';

const DAV = 'DAV:';
type Property = { namespace: string; name: string };
export type PropfindRequest = { mode: 'allprop' | 'propname' | 'prop'; properties: Property[] };
const children = (element: Element): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
export function parsePropfind(body: string): PropfindRequest {
  if (!body.trim()) return { mode: 'allprop', properties: [] };
  try {
    const doc = new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(body, 'application/xml');
    const root = doc.documentElement;
    if (doc.doctype || !root || root.namespaceURI !== DAV || root.localName !== 'propfind') throw new Error('Invalid PROPFIND');
    const elements = children(root); const selections = elements.filter(child => child.namespaceURI === DAV && ['allprop', 'propname', 'prop'].includes(child.localName ?? ''));
    if (selections.length !== 1 || !selections[0]) throw new Error('Exactly one selection is required');
    const mode = selections[0].localName as PropfindRequest['mode'];
    const selected = mode === 'prop' ? children(selections[0]) : elements.filter(child => child.namespaceURI === DAV && child.localName === 'include').flatMap(children);
    return { mode, properties: selected.map(child => ({ namespace: child.namespaceURI ?? '', name: child.localName ?? child.nodeName })) };
  } catch { throw new HTTPException(400, { message: 'Invalid PROPFIND XML' }); }
}
function davElement(doc: Document, name: string, text?: string): Element {
  const element = doc.createElementNS(DAV, `D:${name}`);
  if (text !== undefined) element.appendChild(doc.createTextNode(text));
  return element;
}
function href(entry: ViewEntry) {
  return '/dav' + entry.path.split('/').map(encodeURIComponent).join('/') + (entry.kind === 'directory' && entry.path !== '/' ? '/' : '');
}
const supported = (entry: Description) => ['displayname', 'resourcetype', 'creationdate', 'getlastmodified', 'getetag',
  ...(entry.kind === 'file' ? ['getcontentlength', 'getcontenttype'] : [])];
function value(doc: Document, parent: Element, property: string, entry: Description) {
  if (property === 'resourcetype') { if (entry.kind === 'directory') parent.appendChild(davElement(doc, 'collection')); return; }
  const texts: Record<string, string> = { displayname: entry.name || 'MusicFS', creationdate: entry.modifiedAt,
    getlastmodified: new Date(entry.modifiedAt).toUTCString(), getetag: `"${entry.etag}"`,
    ...(entry.kind === 'file' ? { getcontentlength: String(entry.handle.content.size), getcontenttype: entry.handle.content.mediaType } : {}) };
  parent.appendChild(doc.createTextNode(texts[property] ?? ''));
}
export async function propfindResponse(
  parent: Description, entries: ViewEntry[], request: PropfindRequest,
  stat: (entry: ViewEntry) => Promise<Description>, status: (error: unknown) => number
): Promise<string> {
  const doc = new DOMImplementation().createDocument(DAV, 'D:multistatus', null);
  const root = doc.documentElement!;
  async function add(entry: ViewEntry, known?: Description) {
    const response = davElement(doc, 'response'); response.appendChild(davElement(doc, 'href', href(entry))); root.appendChild(response);
    let description: Description;
    try { description = known ?? await stat(entry); }
    catch (error) { response.appendChild(davElement(doc, 'status', `HTTP/1.1 ${status(error)} Resource unavailable`)); return; }
    const available = supported(description);
    const wanted = request.mode === 'prop' ? request.properties : [
      ...available.map(name => ({ namespace: DAV, name })), ...request.properties
    ];
    const seen = new Set<string>();
    const found: Property[] = []; const missing: Property[] = [];
    for (const property of wanted) {
      const identity = JSON.stringify(property); if (seen.has(identity)) continue; seen.add(identity);
      (property.namespace === DAV && available.includes(property.name) ? found : missing).push(property);
    }
    for (const [code, properties] of [[200, found], [404, missing]] as const) {
      if (!properties.length) continue;
      const propstat = davElement(doc, 'propstat'); const prop = davElement(doc, 'prop'); propstat.appendChild(prop);
      for (const property of properties) {
        const element = doc.createElementNS(property.namespace || null, property.namespace === DAV ? `D:${property.name}` : property.namespace ? `P:${property.name}` : property.name);
        if (code === 200 && request.mode !== 'propname') value(doc, element, property.name, description);
        prop.appendChild(element);
      }
      propstat.appendChild(davElement(doc, 'status', `HTTP/1.1 ${code} ${code === 200 ? 'OK' : 'Not Found'}`)); response.appendChild(propstat);
    }
  }
  await add(parent, parent);
  for (const entry of entries) await add(entry);
  return '<?xml version="1.0" encoding="utf-8"?>' + new XMLSerializer().serializeToString(doc);
}
