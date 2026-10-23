import { t } from '../i18n';
import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import equal from 'fast-deep-equal';
import type { LayoutNode, SourceInstance } from '../../contracts/management';
import { ApiError, type Api } from '../api';
import { appendNodes, locateNode, type LayoutDraft } from '../pages/layout-draft';

type Nodes = LayoutNode[] | null;
export function useLibraryLayout(api: Api, instances: SourceInstance[], draft: LayoutDraft | null, setDraft: (value: LayoutDraft | null) => void) {
  const client = useQueryClient(); const { message } = App.useApp();
  const layout = useQuery({ queryKey: ['layout'], queryFn: ({ signal }) => api.layout(signal) });
  const [history, setHistory] = useState<{ past: Nodes[]; future: Nodes[] }>({ past: [], future: [] });
  const nodes = draft ? draft.nodes : layout.data?.nodes;
  const defaults = useQuery({ queryKey: ['library', 'layout-default', instances.map(instance => [instance.id, instance.epoch, instance.name])],
    queryFn: ({ signal }) => api.defaultLayout(signal), enabled: layout.isSuccess && nodes === null });
  const displayed = nodes === null ? defaults.data : nodes;
  const save = useMutation({ mutationFn: (value: LayoutDraft) => api.saveLayout(value.base, value.nodes), onSuccess: async value => {
    client.setQueryData(['layout'], value); setDraft(null); setHistory({ past: [], future: [] });
    await client.invalidateQueries({ queryKey: ['library'] }); message.success(t("目录已保存"));
  }, onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: ['layout'] }); } });
  const conflicted = !!draft && !!layout.data && draft.base !== layout.data.revision;
  const disabled = save.isPending || !displayed || conflicted;
  function apply(next: Nodes) {
    if (!layout.data) return;
    setDraft(equal(next, layout.data.nodes) ? null : { base: draft?.base ?? layout.data.revision, nodes: next }); save.reset();
  }
  function change(next: Nodes) {
    if (disabled || nodes === undefined || equal(next, nodes)) return;
    setHistory(previous => ({ past: [...previous.past.slice(-49), nodes], future: [] })); apply(next);
  }
  function travel(direction: 'undo' | 'redo') {
    if (save.isPending || conflicted || nodes === undefined) return;
    const list = direction === 'undo' ? history.past : history.future;
    if (!list.length) return;
    setHistory(direction === 'undo' ? { past: history.past.slice(0, -1), future: [...history.future, nodes] }
      : { past: [...history.past, nodes], future: history.future.slice(0, -1) });
    apply(list.at(-1)!);
  }
  function discard() { setDraft(null); setHistory({ past: [], future: [] }); save.reset(); }
  function createFolder(parentId: string | null) {
    if (disabled || !displayed) return;
    const parent = parentId ? locateNode(displayed, parentId)?.node : undefined;
    const names = (parent?.kind === 'group' ? parent.children : displayed).map(node => node.name);
    let name = t("新建文件夹"); let suffix = 2; while (names.includes(name)) name = t("新建文件夹 ") + suffix++;
    const node: LayoutNode = { id: crypto.randomUUID(), kind: 'group', name, children: [] };
    change(appendNodes(displayed, parentId, [node])); return node;
  }
  return { nodes: displayed, automatic: nodes === null, dirty: !!draft, disabled, conflicted, history,
    error: layout.error ?? (nodes === null ? defaults.error : null), saveError: conflicted ? null : save.error,
    loading: layout.isPending || nodes === null && defaults.isPending, saving: save.isPending,
    reload: () => void (nodes === null ? defaults.refetch() : layout.refetch()), change, createFolder, discard,
    undo: () => travel('undo'), redo: () => travel('redo'), save: (done?: () => void) => { if (draft) save.mutate(draft, done ? { onSuccess: done } : undefined); } };
}
export type LibraryLayout = ReturnType<typeof useLibraryLayout>;
