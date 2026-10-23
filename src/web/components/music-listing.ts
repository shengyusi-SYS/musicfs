import { useQuery } from '@tanstack/react-query';
import type { DirectoryStatus, LayoutNode, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { findNode } from '../pages/layout-draft';
import { exportedLocation, layoutLocation, type MusicEntry, type MusicLocation } from './music-navigation';

export type SourceRoot = Awaited<ReturnType<Api['roots']>>[number];
export type SourceDirectory = SourceRoot & { nested?: true };
export type MusicListing = { entries: MusicEntry[]; status: DirectoryStatus | null; source?: { instanceId: string; pluginId: string; directoryRef?: string } };
type ListingData = { entries: (Omit<MusicEntry, 'location'> & { directoryRef?: string; path?: string })[]; status: DirectoryStatus | null; source?: NonNullable<MusicListing['source']> };
export function rootsQuery(api: Api, instance: SourceInstance | undefined) {
  return { queryKey: ['roots', instance?.id, instance?.epoch], queryFn: ({ signal }: { signal: AbortSignal }) => api.roots(instance!.id, signal), enabled: !!instance };
}
export function layoutSource(nodes: LayoutNode[], location: MusicLocation) {
  const node = location.target.kind === 'layout' ? findNode(nodes, location.target.nodeId) : undefined;
  return node?.kind === 'source' ? node : undefined;
}
/** Root IDs follow the plugin's current root; only a selected child pins an opaque directory ref. */
export function sourceDirectory(location: MusicLocation, roots: SourceRoot[] | undefined, nodes: LayoutNode[]): SourceDirectory | undefined {
  const target = location.target; if (target.kind === 'export') return;
  const alias = layoutSource(nodes, location);
  const ref = target.directoryRef ?? alias?.directoryRef;
  const root = roots?.find(root => root.sourceId === (target.kind === 'source' ? target.sourceId : alias?.sourceId))
    ?? roots?.find(root => root.directoryRef === ref)
    ?? roots?.find(root => location.ancestors.some(crumb => crumb.target.kind === 'source' && crumb.target.directoryRef === root.directoryRef));
  if (!root) return;
  return ref === undefined || ref === root.directoryRef ? root : { sourceId: root.sourceId, directoryRef: ref, name: location.name, nested: true };
}
export function listingQuery(api: Api, location: MusicLocation, instances: SourceInstance[], nodes: LayoutNode[], roots: SourceRoot[] | undefined) {
  const target = location.target; const alias = layoutSource(nodes, location);
  const instanceId = target.kind === 'source' ? target.instanceId : alias?.instanceId;
  const instance = instances.find(value => value.id === instanceId);
  const root = alias ? roots?.find(root => root.sourceId === alias.sourceId) : undefined;
  const directoryRef = target.kind === 'export' ? undefined : target.directoryRef ?? alias?.directoryRef ?? root?.directoryRef;
  const source = instanceId ? { instanceId, pluginId: instance?.pluginId ?? '', ...(directoryRef === undefined ? {} : { directoryRef }) } : undefined;
  const sourceId = alias?.sourceId ?? (target.kind === 'source' ? target.sourceId : undefined) ?? roots?.find(root => root.directoryRef === directoryRef)?.sourceId;
  return {
    source,
    queryKey: target.kind === 'export' ? ['library', 'directory', target.path] : ['library', 'source', instanceId, instance?.epoch, directoryRef],
    enabled: target.kind === 'export' || !!instance && (!alias || !!root),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingData> => target.kind === 'export'
      ? api.browseDirectory(target.path, signal) : api.browseSourceDirectory(source!.instanceId, source!.directoryRef, signal),
    select: (value: ListingData): MusicListing => ({ ...value, ...(source ? { source } : {}), entries: value.entries.map(entry => {
      if (entry.kind !== 'directory') return entry;
      if (target.kind === 'export') return { ...entry, location: exportedLocation(entry.path!) };
      const entrySourceId = sourceId ?? roots?.find(root => root.directoryRef === entry.directoryRef)?.sourceId;
      const childTarget: MusicLocation['target'] = target.kind === 'layout'
        ? { kind: 'layout', nodeId: target.nodeId, directoryRef: entry.directoryRef! }
        : { kind: 'source', instanceId: source!.instanceId, directoryRef: entry.directoryRef!, ...(entrySourceId === undefined ? {} : { sourceId: entrySourceId }) };
      return { ...entry, location: { name: entry.name, target: childTarget, ancestors: [...location.ancestors, { name: location.name, target }] } };
    }) })
  };
}
export function groupListing(nodes: LayoutNode[], location: MusicLocation): MusicListing | undefined {
  if (location.target.kind !== 'layout') return;
  const node = findNode(nodes, location.target.nodeId);
  const children = location.target.nodeId === '' ? nodes : node?.kind === 'group' ? node.children : undefined;
  return children ? { status: null, entries: children.map(child => ({ name: child.name, kind: 'directory', modifiedAt: '', location: layoutLocation(nodes, child.id) })) } : undefined;
}
export function useMusicListing(api: Api, location: MusicLocation, instances: SourceInstance[], nodes: LayoutNode[]) {
  const alias = layoutSource(nodes, location);
  const instanceId = location.target.kind === 'source' ? location.target.instanceId : alias?.instanceId;
  const instance = instances.find(instance => instance.id === instanceId);
  const roots = useQuery(rootsQuery(api, instance));
  const query = listingQuery(api, location, instances, nodes, roots.data);
  const listing = useQuery(query); const group = groupListing(nodes, location);
  const missing = alias && roots.isSuccess && !roots.data.some(root => root.sourceId === alias.sourceId);
  const error = instanceId && !instance ? new Error('此音乐来源已删除') : roots.error ?? (missing ? new Error('此音乐内容已不在来源中') : listing.error);
  return { ...listing, data: group ?? listing.data, roots: roots.data,
    source: listing.data?.source ?? query.source,
    isPending: !group && listing.isPending && !error,
    error,
    refetch: () => alias && !roots.isSuccess ? roots.refetch() : listing.refetch() };
}
