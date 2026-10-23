import { useRef, useState } from 'react';
import { Button, Input, Modal, TreeSelect } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import type { LayoutNode } from '../../contracts/management';
import { folderOptions } from '../pages/layout-draft';

export function RenameNode({ name, commit, cancel }: { name: string; commit: (name: string) => void; cancel: () => void }) {
  const [value, setValue] = useState(name); const valid = !!value.trim();
  const finished = useRef(false);
  function finish(abort = false) {
    if (finished.current) return;
    finished.current = true;
    if (abort || !valid) cancel(); else commit(value.trim());
  }
  return <span className="layout-rename" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Input aria-label="目录名称" autoFocus defaultValue={name} maxLength={500} onFocus={event => { event.stopPropagation(); event.target.select(); }} onChange={event => setValue(event.target.value)}
      onBlur={() => finish()} onKeyDown={event => { if (event.key === 'Enter' && valid) finish(); if (event.key === 'Escape') finish(true); }} />
    <Button type="text" size="small" icon={<CheckOutlined aria-hidden="true" />} aria-label="确认名称" disabled={!valid} onMouseDown={event => event.preventDefault()} onClick={() => finish()} />
    <Button type="text" size="small" icon={<CloseOutlined aria-hidden="true" />} aria-label="取消改名" onMouseDown={event => event.preventDefault()} onClick={() => finish(true)} />
  </span>;
}
export function MoveFolder({ name, current, nodes, exclude, close, move }: { name: string; current: string | null; nodes: LayoutNode[]; exclude: string; close: () => void; move: (id: string | null) => void }) {
  const [destination, setDestination] = useState(current ?? '');
  return <Modal title={'移动「' + name + '」'} open onCancel={close} okText="移动" cancelText="取消" okButtonProps={{ disabled: destination === (current ?? '') }} onOk={() => move(destination || null)}>
    <div className="field-block"><label htmlFor="layout-move-target">目标文件夹</label><TreeSelect id="layout-move-target" value={destination} onChange={setDestination} treeDefaultExpandAll showSearch treeNodeFilterProp="title"
      treeData={[{ value: '', title: '播放器目录', children: folderOptions(nodes, exclude) }]} /></div>
  </Modal>;
}

export function AddToFolder({ nodes, initial, count, close, add }: { nodes: LayoutNode[]; initial: string | null; count: number; close(): void; add(parentId: string | null): void }) {
  const [destination, setDestination] = useState(initial ?? '');
  return <Modal title="添加到播放器目录" open onCancel={close} okText={'添加 ' + count + ' 项'} cancelText="取消" onOk={() => add(destination || null)}>
    <div className="field-block"><label htmlFor="music-add-target">目标文件夹</label><TreeSelect id="music-add-target" value={destination} onChange={setDestination} treeDefaultExpandAll showSearch treeNodeFilterProp="title"
      treeData={[{ value: '', title: '播放器目录', children: folderOptions(nodes) }]} /></div>
  </Modal>;
}
