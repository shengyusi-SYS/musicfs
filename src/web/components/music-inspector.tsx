import { t } from '../i18n';
import { useState } from 'react';
import { Drawer, Tabs } from 'antd';
import type { SourceInstance } from '../../contracts/management';
import type { Api } from '../api';
import { SourceSettings } from './source-editor';
import { NamingSettings } from './file-naming';
import { UpdateRuleSettings } from './update-rule-editor';

export function MusicInspector({ api, instance, directoryRef, label, close, showPlugins }: {
  api: Api; instance: SourceInstance; directoryRef?: string | undefined; label: string; close(): void; showPlugins(): void;
}) {
  const [tab, setTab] = useState(directoryRef === undefined ? 'source' : 'schedule');
  return <Drawer title={directoryRef === undefined ? instance.name : `${instance.name} / ${label}`} size={640} open onClose={close} mask={false} destroyOnHidden>
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'source', label: t("来源设置"), children: <SourceSettings api={api} instance={instance} close={close} showPlugins={showPlugins} saved={close} /> },
      { key: 'schedule', label: t("自动更新"), children: <UpdateRuleSettings api={api} instanceId={instance.id} label={label} close={close}
        target={directoryRef === undefined ? { kind: 'instance' } : { kind: 'directory', directoryRef, recursive: false }} /> },
      { key: 'naming', label: t("文件命名"), children: <NamingSettings api={api} instanceId={instance.id} directoryRef={directoryRef} close={close} /> }
    ]} />
  </Drawer>;
}
