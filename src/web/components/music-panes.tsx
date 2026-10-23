import { useState, type ReactNode } from 'react';
import { Splitter } from 'antd';

const widthKey = 'musicfs.library.player-pane.width';
/** The shell owns source navigation; only the content and optional target split here. */
export function MusicPanes({ content, layout, open }: { content: ReactNode; layout: ReactNode; open: boolean }) {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(widthKey)) || 300);
  return <Splitter className={'music-workspace music-splitter' + (open ? '' : ' music-player-closed')} onResize={sizes => { if (open) setWidth(sizes[1]!); }}
    onResizeEnd={sizes => { if (open) localStorage.setItem(widthKey, String(sizes[1])); }}>
    <Splitter.Panel min={open ? 320 : 0}>{content}</Splitter.Panel>
    <Splitter.Panel size={open ? width : 0} min={open ? 240 : 0} max={open ? '45%' : 0} resizable={open}>{open ? layout : null}</Splitter.Panel>
  </Splitter>;
}
