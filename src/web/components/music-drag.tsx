import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import type { Placement } from '../pages/layout-draft';
import type { SourceDirectory } from './music-listing';

export type SourceDrag = { type: 'music-source'; instanceId: string; roots: SourceDirectory[] };
export type LayoutDrag = { type: 'music-layout'; nodeId: string; name: string };
type MusicDrag = SourceDrag | LayoutDrag;
export const sourceDrag = (instanceId: string, roots: SourceDirectory[]): SourceDrag => ({ type: 'music-source', instanceId, roots });
const isMusicDrag = (data: Record<string | symbol, unknown>): data is MusicDrag => data.type === 'music-source' || data.type === 'music-layout';

function useMusicDrag<T extends HTMLElement>(data: MusicDrag | undefined) {
  const ref = useRef<T>(null); const current = useRef(data); current.current = data;
  const enabled = !!data;
  useEffect(() => {
    const element = ref.current; if (!element || !enabled) return;
    return draggable({ element, getInitialData: () => current.current!,
      onGenerateDragPreview: ({ nativeSetDragImage }) => setCustomNativeDragPreview({ nativeSetDragImage, render: ({ container }) => {
        const preview = document.createElement('div'); preview.className = 'music-drag-preview';
        const value = current.current!;
        preview.textContent = value.type === 'music-layout' ? '移动「' + value.name + '」' : value.roots.length === 1 ? '添加「' + value.roots[0]!.name + '」' : '添加 ' + value.roots.length + ' 项';
        container.append(preview);
      } }) });
  }, [enabled]);
  return ref;
}

export function MusicSourceDrag({ data, children }: { data: SourceDrag | undefined; children: ReactNode }) {
  const ref = useMusicDrag<HTMLSpanElement>(data);
  return <span ref={ref} className={data ? 'music-source-drag' : undefined}>{children}</span>;
}
export function MusicLayoutDrag({ data, children }: { data: LayoutDrag | undefined; children: ReactNode }) {
  const ref = useMusicDrag<HTMLSpanElement>(data);
  return <span ref={ref} className={data ? 'music-layout-drag' : undefined}>{children}</span>;
}
export function MusicDragRow({ dragData, ...props }: HTMLAttributes<HTMLTableRowElement> & { dragData?: SourceDrag | undefined }) {
  const ref = useMusicDrag<HTMLTableRowElement>(dragData);
  return <tr {...props} ref={ref} className={[props.className, dragData ? 'music-source-drag' : ''].filter(Boolean).join(' ')} />;
}

export function MusicDropTarget({ disabled, name, folder, root = false, children, add, canMove, move }: {
  disabled: boolean; name: string; folder: boolean; root?: boolean; children: ReactNode;
  add(data: SourceDrag): void; canMove(nodeId: string, placement: Placement): boolean; move(nodeId: string, placement: Placement): void;
}) {
  const ref = useRef<HTMLSpanElement>(null); const [over, setOver] = useState<Placement | null>(null);
  const current = useRef({ add, canMove, move }); current.current = { add, canMove, move };
  useEffect(() => {
    const element = ref.current; if (!element || disabled) return;
    function placement(y: number): Placement {
      const bounds = element!.getBoundingClientRect(); const ratio = (y - bounds.top) / bounds.height;
      return root || folder && ratio >= .25 && ratio <= .75 ? 'inside' : ratio < .5 ? 'before' : 'after';
    }
    return dropTargetForElements({ element,
      canDrop: ({ source, input }) => isMusicDrag(source.data) && (source.data.type === 'music-source' ? folder : current.current.canMove(source.data.nodeId, placement(input.clientY))),
      getData: ({ source, input }) => ({ placement: source.data.type === 'music-source' ? 'inside' : placement(input.clientY) }),
      getDropEffect: ({ source }) => source.data.type === 'music-source' ? 'copy' : 'move',
      onDragEnter: ({ self }) => setOver(self.data.placement as Placement), onDrag: ({ self }) => setOver(self.data.placement as Placement),
      onDragLeave: () => setOver(null), onDrop: ({ source, self }) => {
        setOver(null); if (!isMusicDrag(source.data)) return;
        if (source.data.type === 'music-source') current.current.add(source.data);
        else current.current.move(source.data.nodeId, self.data.placement as Placement);
      } });
  }, [disabled, folder, root]);
  return <span ref={ref} data-drop-folder={folder ? name : undefined} className={'music-drop-target' + (over ? ' music-drop-' + over : '')}>{children}</span>;
}
