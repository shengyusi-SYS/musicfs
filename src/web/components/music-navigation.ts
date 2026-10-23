import { useEffect, useState } from 'react';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import { nodeTrail } from '../pages/layout-draft';

export type MusicTarget = { kind: 'export'; path: string } | { kind: 'source'; instanceId: string; directoryRef?: string; sourceId?: string }
  | { kind: 'layout'; nodeId: string; directoryRef?: string };
export type MusicCrumb = { target: MusicTarget; name: string };
export type MusicLocation = MusicCrumb & { ancestors: MusicCrumb[] };
export type MusicEntry = { name: string; kind: 'file' | 'directory'; modifiedAt: string; location?: MusicLocation };
export const exportedMusic: MusicLocation = { target: { kind: 'layout', nodeId: '' }, name: '播放器目录', ancestors: [] };
export const locationKey = (location: MusicCrumb) => JSON.stringify(location.target);
export function layoutLocation(nodes: LayoutNode[], id: string): MusicLocation {
  const trail = nodeTrail(nodes, id);
  if (!trail) return exportedMusic;
  const crumbs: MusicCrumb[] = [exportedMusic, ...trail.map(node => ({ name: node.name, target: { kind: 'layout' as const, nodeId: node.id } }))];
  return { ...crumbs.at(-1)!, ancestors: crumbs.slice(0, -1) };
}
export function currentLayoutLocation(nodes: LayoutNode[], location: MusicLocation): MusicLocation {
  if (location.target.kind === 'export' && location.target.path === '/') return exportedMusic;
  if (location.target.kind !== 'layout') return location;
  const target = location.target; const base = layoutLocation(nodes, target.nodeId);
  if (target.directoryRef === undefined || base.target.kind !== 'layout' || base.target.nodeId === '') return base;
  const nested = location.ancestors.filter(crumb => crumb.target.kind === 'layout' && crumb.target.nodeId === target.nodeId && crumb.target.directoryRef !== undefined);
  return { ...location, ancestors: [...base.ancestors, base, ...nested] };
}
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
  const nodeId = params.get('node'); const directoryRef = params.get('directory');
  if (nodeId !== null) return { name: params.get('name') ?? '播放器目录', target: { kind: 'layout', nodeId, ...(directoryRef === null ? {} : { directoryRef }) }, ancestors: [] };
  const instanceId = params.get('source');
  if (!instanceId) return exportedLocation(params.get('path') ?? '/');
  const root: MusicCrumb = { name: '音乐来源', target: { kind: 'source', instanceId } };
  const sourceId = params.get('root');
  return { name: params.get('name') ?? root.name, target: { kind: 'source', instanceId, ...(directoryRef === null ? {} : { directoryRef }), ...(sourceId === null ? {} : { sourceId }) }, ancestors: directoryRef === null ? [] : [root] };
}
export function useMusicNavigation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => { const restore = () => setLocation(readLocation()); restore(); addEventListener('popstate', restore); return () => removeEventListener('popstate', restore); }, []);
  function open(next: MusicLocation) {
    if (locationKey(next) === locationKey(location)) return;
    const url = new URL(window.location.href); url.searchParams.set('page', 'library');
    for (const key of ['path', 'source', 'directory', 'name', 'node', 'root']) url.searchParams.delete(key);
    if (next.target.kind === 'export') { if (next.target.path !== '/') url.searchParams.set('path', next.target.path); }
    else if (next.target.kind === 'layout') {
      if (next.target.nodeId) url.searchParams.set('node', next.target.nodeId);
      url.searchParams.set('name', next.name);
      if (next.target.directoryRef !== undefined) url.searchParams.set('directory', next.target.directoryRef);
    }
    else {
      url.searchParams.set('source', next.target.instanceId); url.searchParams.set('name', next.name);
      if (next.target.directoryRef !== undefined) url.searchParams.set('directory', next.target.directoryRef);
      if (next.target.sourceId !== undefined) url.searchParams.set('root', next.target.sourceId);
    }
    history.pushState({ ...history.state, musicLocation: next }, '', url); setLocation(next);
  }
  return { location, open };
}
