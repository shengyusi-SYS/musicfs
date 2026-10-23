import type { Sources, SourceStamp } from '../sources';
import type { LibraryStore, LayoutNode, SnapshotKey } from './types';
import { namedView } from './published-views';
import { projectFileNames } from './file-naming';

/** Map a publication to visible folders using saved snapshots only; never warm a source. */
export async function publishedPaths(sources: Pick<Sources, 'instances'>, store: LibraryStore, stamp: SourceStamp, key: SnapshotKey): Promise<string[]> {
  const layout = await store.layout();
  const starts: { path: string; sourceId: string; directoryRef?: string }[] = [];
  let instancePath: string | undefined;
  if (layout.nodes === null) {
    const instances = await namedView(await sources.instances());
    const instance = instances.entries.find(item => item.id === stamp.id);
    if (!instance) return [];
    instancePath = '/' + instance.pathName;
    if (key.kind === 'roots') return [instancePath];
  } else {
    const visit = async (nodes: LayoutNode[], parent: string): Promise<void> => {
      for (const node of (await namedView(nodes)).entries) {
        const path = parent + '/' + node.pathName;
        if (node.kind === 'group') await visit(node.children, path);
        else if (node.instanceId === stamp.id) starts.push({ path, sourceId: node.sourceId, ...(node.directoryRef === undefined ? {} : { directoryRef: node.directoryRef }) });
      }
    };
    await visit(layout.nodes, '');
    if (key.kind === 'roots') return starts.map(item => item.path);
  }
  const roots = (await store.snapshot(stamp.id, { kind: 'roots', ref: '' }))?.value;
  if (!roots || roots.kind !== 'roots' || roots.stamp.epoch !== stamp.epoch || roots.stamp.pluginRevision !== stamp.pluginRevision
    || roots.stamp.pluginGeneration !== stamp.pluginGeneration) return [];
  const namedRoots = await namedView(roots.items.map(root => ({ ...root, id: root.sourceId })));
  const pending = instancePath ? namedRoots.entries.map(root => ({ path: instancePath + '/' + root.pathName, ref: root.directoryRef, ancestors: new Set<string>() }))
    : starts.flatMap(start => {
      const root = namedRoots.entries.find(root => root.sourceId === start.sourceId);
      return root ? [{ path: start.path, ref: start.directoryRef ?? root.directoryRef, ancestors: new Set<string>() }] : [];
    });
  const saved = new Map<string, Promise<{ pathName: string; directoryRef: string }[]>>();
  const directories = (ref: string) => {
    let value = saved.get(ref);
    if (!value) {
      value = (async () => {
        const snapshot = (await store.snapshot(stamp.id, { kind: 'directory', ref }))?.value;
        if (!snapshot || snapshot.kind !== 'directory' || snapshot.stamp.epoch !== stamp.epoch
          || snapshot.stamp.pluginRevision !== stamp.pluginRevision || snapshot.stamp.pluginGeneration !== stamp.pluginGeneration) return [];
        const header = await store.snapshotHeader(stamp.id, { kind: 'directory', ref });
        const entries = await namedView(projectFileNames(snapshot.items, header?.fileNamingPolicy ?? { mode: 'original' })
          .map(entry => ({ ...entry, id: entry.entryId })));
        return entries.entries.flatMap(entry => entry.kind === 'directory' ? [{ pathName: entry.pathName, directoryRef: entry.directoryRef }] : []);
      })();
      saved.set(ref, value);
    }
    return value;
  };
  const paths: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!;
    if (current.ref === key.ref) { paths.push(current.path); continue; }
    if (current.ancestors.has(current.ref)) continue;
    const ancestors = new Set(current.ancestors).add(current.ref);
    for (const child of await directories(current.ref)) pending.push({ path: current.path + '/' + child.pathName, ref: child.directoryRef, ancestors });
  }
  return [...new Set(paths)];
}
