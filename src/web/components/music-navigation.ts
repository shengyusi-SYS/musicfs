import type { DirectoryStatus, SourceInstance } from '../../contracts/management';
import type { Api } from '../api';

export type MusicTarget = { kind: 'export'; path: string } | { kind: 'source'; instanceId: string; directoryRef?: string };
export type MusicCrumb = { target: MusicTarget; name: string };
export type MusicLocation = MusicCrumb & { ancestors: MusicCrumb[] };
export type MusicEntry = { name: string; kind: 'file' | 'directory'; modifiedAt: string; location?: MusicLocation };
export type MusicListing = { entries: MusicEntry[]; status: DirectoryStatus | null; source?: { instanceId: string; pluginId: string; directoryRef?: string } };
export const exportedMusic: MusicLocation = { target: { kind: 'export', path: '/' }, name: '播放器目录', ancestors: [] };
export const locationKey = (location: MusicCrumb) => JSON.stringify(location.target);
export function exportedLocation(path: string): MusicLocation {
  const segments = path.split('/').filter(Boolean);
  const ancestors: MusicCrumb[] = [exportedMusic, ...segments.slice(0, -1).map((name, index) => ({ name,
    target: { kind: 'export' as const, path: '/' + segments.slice(0, index + 1).join('/') } }))];
  return segments.length ? { name: segments.at(-1)!, target: { kind: 'export', path }, ancestors } : exportedMusic;
}
export function sourceLocation(instance: SourceInstance): MusicLocation {
  return { name: instance.name, target: { kind: 'source', instanceId: instance.id }, ancestors: [] };
}
function readLocation(): MusicLocation {
  if (history.state?.musicLocation) return history.state.musicLocation;
  const params = new URLSearchParams(location.search);
  const instanceId = params.get('source');
  if (!instanceId) return exportedLocation(params.get('path') ?? '/');
  const root: MusicCrumb = { name: '音乐来源', target: { kind: 'source', instanceId } };
  const directoryRef = params.get('directory');
  return { name: params.get('name') ?? root.name, target: { kind: 'source', instanceId, ...(directoryRef === null ? {} : { directoryRef }) }, ancestors: directoryRef === null ? [] : [root] };
}
export function useMusicNavigation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => { const restore = () => setLocation(readLocation()); addEventListener('popstate', restore); return () => removeEventListener('popstate', restore); }, []);
  function open(next: MusicLocation) {
    if (locationKey(next) === locationKey(location)) return;
    const url = new URL(window.location.href); url.searchParams.set('page', 'library');
    for (const key of ['path', 'source', 'directory', 'name']) url.searchParams.delete(key);
    if (next.target.kind === 'export') { if (next.target.path !== '/') url.searchParams.set('path', next.target.path); }
    else {
      url.searchParams.set('source', next.target.instanceId); url.searchParams.set('name', next.name);
      if (next.target.directoryRef !== undefined) url.searchParams.set('directory', next.target.directoryRef);
    }
    history.pushState({ ...history.state, musicLocation: next }, '', url); setLocation(next);
  }
  return { location, open };
}
export function listingQuery(api: Api, location: MusicLocation, instances: SourceInstance[]) {
  const target = location.target;
  const instance = target.kind === 'source' ? instances.find(value => value.id === target.instanceId) : undefined;
  return {
    queryKey: target.kind === 'export' ? ['library', 'directory', target.path] : ['library', 'source', target.instanceId, instance?.epoch, target.directoryRef],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MusicListing> => {
      if (target.kind === 'export') {
        const value = await api.browseDirectory(target.path, signal);
        return { ...value, entries: value.entries.map(entry => ({ ...entry, ...(entry.kind === 'directory' ? { location: exportedLocation(entry.path) } : {}) })) };
      }
      const value = await api.browseSourceDirectory(target.instanceId, target.directoryRef, signal);
      return { ...value, source: { instanceId: target.instanceId, pluginId: instance?.pluginId ?? '', ...(target.directoryRef === undefined ? {} : { directoryRef: target.directoryRef }) },
        entries: value.entries.map(entry => ({ ...entry, ...(entry.kind === 'directory' ? { location: { name: entry.name,
          target: { kind: 'source' as const, instanceId: target.instanceId, directoryRef: entry.directoryRef },
          ancestors: [...location.ancestors, { name: location.name, target }] } } : {}) })) };
    }
  };
}
import { useEffect, useState } from 'react';
