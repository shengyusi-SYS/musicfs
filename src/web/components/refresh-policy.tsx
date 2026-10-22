import { useState } from 'react';
import { Button } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import type { Api } from '../api';
import { UpdateRuleControlDialog } from './update-rule-editor';

export function RefreshPolicyControl({ api, instanceId, directoryRef, label, disabled = false }: {
  api: Api; instanceId: string; directoryRef?: string; label?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <><Button icon={<ClockCircleOutlined aria-hidden="true" />} disabled={disabled} onClick={() => setOpen(true)}>自动更新</Button>
    {open && <UpdateRuleControlDialog api={api} instanceId={instanceId} directoryRef={directoryRef} label={label} close={() => setOpen(false)} />}</>;
}
