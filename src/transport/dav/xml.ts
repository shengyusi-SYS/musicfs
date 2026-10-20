import { DOMImplementation, DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { HTTPException } from 'hono/http-exception';
import type { Description, ViewEntry } from '../../core/library';

const DAV = 'DAV:';
type Property = { namespace: string; name: string };
type Resource = ViewEntry | Description;
type CompiledProperty = Property & { text?: (entry: Resource) => string };
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

function compile(request: PropfindRequest) {
  // Most directory rows share their snapshot timestamp. No cache survives this response.
  const dates = new Map<string, string>();
  const utc = (value: string) => {
    let formatted = dates.get(value);
    if (formatted === undefined) { formatted = new Date(value).toUTCString(); dates.set(value, formatted); }
    return formatted;
  };
  const readers: Record<string, (entry: Resource) => string> = {
    displayname: entry => entry.name || 'MusicFS',
    creationdate: entry => entry.modifiedAt,
    getlastmodified: entry => utc(entry.modifiedAt),
    getetag: entry => 'etag' in entry ? `"${entry.etag}"` : '',
    getcontentlength: entry => 'handle' in entry ? String(entry.handle.content.size) : '',
    getcontenttype: entry => 'handle' in entry ? entry.handle.content.mediaType : ''
  };
  const forKind = (kind: ViewEntry['kind']) => {
    const available = ['displayname', 'resourcetype', 'creationdate', 'getlastmodified', 'getetag',
      ...(kind === 'file' ? ['getcontentlength', 'getcontenttype'] : [])];
    const wanted = request.mode === 'prop' ? request.properties : [
      ...available.map(name => ({ namespace: DAV, name })), ...request.properties
    ];
    const found: CompiledProperty[] = []; const missing: CompiledProperty[] = []; const seen = new Set<string>();
    for (const property of wanted) {
      const identity = JSON.stringify(property); if (seen.has(identity)) continue; seen.add(identity);
      const supported = property.namespace === DAV && available.includes(property.name); const text = readers[property.name];
      (supported ? found : missing).push({ ...property, ...(supported && text ? { text } : {}) });
    }
    const needsMetadata = request.mode === 'allprop' || request.mode === 'prop' && request.properties.some(property =>
      property.namespace === DAV && (property.name === 'getetag' || kind === 'file' && ['getcontentlength', 'getcontenttype'].includes(property.name)));
    return { needsMetadata, groups: [[200, found], [404, missing]] as const };
  };
  return { file: forKind('file'), directory: forKind('directory') };
}

export async function propfindResponse(
  parent: Description, entries: ViewEntry[], request: PropfindRequest,
  stat: (entry: ViewEntry) => Promise<Description>, status: (error: unknown) => number
): Promise<string> {
  const selections = compile(request);
  const doc = new DOMImplementation().createDocument(DAV, 'D:multistatus', null);
  const root = doc.documentElement!;
  async function add(entry: ViewEntry, known?: Description) {
    const response = davElement(doc, 'response'); response.appendChild(davElement(doc, 'href', href(entry))); root.appendChild(response);
    let description: Resource = known ?? entry;
    try { if (!known && selections[entry.kind].needsMetadata) description = await stat(entry); }
    catch (error) { response.appendChild(davElement(doc, 'status', `HTTP/1.1 ${status(error)} Resource unavailable`)); return; }
    for (const [code, properties] of selections[description.kind].groups) {
      if (!properties.length) continue;
      const propstat = davElement(doc, 'propstat'); const prop = davElement(doc, 'prop'); propstat.appendChild(prop);
      for (const property of properties) {
        const element = doc.createElementNS(property.namespace || null, property.namespace === DAV ? `D:${property.name}` : property.namespace ? `P:${property.name}` : property.name);
        if (code === 200 && request.mode !== 'propname') {
          if (property.name === 'resourcetype') { if (description.kind === 'directory') element.appendChild(davElement(doc, 'collection')); }
          else element.appendChild(doc.createTextNode(property.text?.(description) ?? ''));
        }
        prop.appendChild(element);
      }
      propstat.appendChild(davElement(doc, 'status', `HTTP/1.1 ${code} ${code === 200 ? 'OK' : 'Not Found'}`)); response.appendChild(propstat);
    }
  }
  await add(parent, parent);
  for (const entry of entries) await add(entry);
  return '<?xml version="1.0" encoding="utf-8"?>' + new XMLSerializer().serializeToString(doc);
}
