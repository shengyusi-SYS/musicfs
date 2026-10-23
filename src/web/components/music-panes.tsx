import { useState, type ReactNode } from 'react';
import { Grid, Splitter } from 'antd';

const paneKey = (wide: boolean) => 'musicfs.library.panes.' + (wide ? 'wide' : 'compact');
function savedSizes(wide: boolean): number[] {
  const defaults = wide ? [20, 54, 26] : [0, 66, 34];
  const sizes = localStorage.getItem(paneKey(wide))?.split(',').map(Number);
  return sizes?.length === 3 && sizes.every(size => size >= 0 && Number.isFinite(size)) && sizes.some(size => size > 0) ? sizes : defaults;
}
function percentages(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map(size => size / total * 100);
}
export function MusicPanes({ sources, content, layout }: { sources: ReactNode; content: ReactNode; layout: ReactNode }) {
  const screens = Grid.useBreakpoint(); const wide = !!screens.xl; const medium = !!screens.md;
  const [widths, setWidths] = useState(() => ({ wide: savedSizes(true), compact: savedSizes(false) }));
  const sizes = !medium ? [0, 100, 0] : wide ? widths.wide : widths.compact;
  return <Splitter className={'music-workspace music-splitter' + (!medium ? ' music-workspace-mobile' : '')}
    onResize={sizes => setWidths(current => ({ ...current, [wide ? 'wide' : 'compact']: percentages(sizes) }))}
    onResizeEnd={sizes => localStorage.setItem(paneKey(wide), percentages(sizes).join(','))}>
    <Splitter.Panel size={wide ? sizes[0]! + '%' : 0} min={wide ? 160 : 0} max={wide ? '35%' : 0} resizable={wide}>{wide ? sources : null}</Splitter.Panel>
    <Splitter.Panel size={sizes[1]! + '%'} min={medium ? 280 : 0}>{content}</Splitter.Panel>
    <Splitter.Panel size={medium ? sizes[2]! + '%' : 0} min={medium ? 190 : 0} max={medium ? '45%' : 0} resizable={medium}>{medium ? layout : null}</Splitter.Panel>
  </Splitter>;
}
