import { useEffect, useId, useState } from 'react';
import { Alert, App, Button, Collapse, Empty, Form, Input, InputNumber, List, Modal, Select, Skeleton, Space, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TEMPLATE_POLICY, type FileNamingPolicy, type FileNamingSettings } from '../../contracts/file-naming';
import type { Api } from '../api';
import { Failure } from './feedback';

export function FileNamingControl({ api, instanceId, directoryRef, label }: {
  api: Api; instanceId: string; directoryRef?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return <><Button icon={<EditOutlined aria-hidden="true" />} onClick={() => setOpen(true)}>文件命名</Button>
    {open && <FileNamingEditor api={api} instanceId={instanceId} directoryRef={directoryRef} label={label} close={() => setOpen(false)} />}</>;
}

export function FileNamingEditor({ api, instanceId, directoryRef, label, close }: {
  api: Api; instanceId: string; directoryRef?: string | undefined; label?: string | undefined;
  close(): void;
}) {
  const settings = useQuery({ queryKey: ['file-naming', instanceId, directoryRef], queryFn: ({ signal }) => api.fileNaming(instanceId, directoryRef, signal) });
  return <Modal title={`文件命名${label ? ` · ${label}` : ''}`} open onCancel={close} footer={null} destroyOnHidden width={720}>
    <Failure error={settings.error} retry={() => void settings.refetch()} />
    {settings.isPending ? <Skeleton active /> : settings.data && <NamingForm api={api} instanceId={instanceId} directoryRef={directoryRef} settings={settings.data} close={close} />}
  </Modal>;
}

function NamingForm({ api, instanceId, directoryRef, settings, close }: {
  api: Api; instanceId: string; directoryRef: string | undefined; settings: FileNamingSettings; close(): void;
}) {
  const { message } = App.useApp(); const client = useQueryClient(); const templateId = useId();
  const [revision] = useState(settings.revision);
  const [mode, setMode] = useState<'inherit' | 'original' | 'template'>(directoryRef !== undefined && settings.inherited ? 'inherit' : settings.effectivePolicy.mode);
  const [template, setTemplate] = useState(() => settings.effectivePolicy.mode === 'template' ? settings.effectivePolicy
    : { ...DEFAULT_TEMPLATE_POLICY, template: settings.fields.title && settings.fields.artist ? DEFAULT_TEMPLATE_POLICY.template : '{{originalName}}' });
  const policy: FileNamingPolicy | null = mode === 'inherit' ? null : mode === 'original' ? { mode: 'original' } : template;
  const policyKey = JSON.stringify(policy); const [previewPolicy, setPreviewPolicy] = useState(policy);
  useEffect(() => { const timer = setTimeout(() => { setPreviewPolicy(policy); }, 350); return () => clearTimeout(timer); }, [policyKey]);
  const preview = useQuery({ queryKey: ['file-naming-preview', instanceId, directoryRef, previewPolicy], retry: false,
    queryFn: ({ signal }) => api.previewFileNaming(instanceId, previewPolicy, directoryRef, signal) });
  const save = useMutation({ mutationFn: () => api.saveFileNaming(instanceId, revision, policy, directoryRef), onSuccess: async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ['file-naming', instanceId] }), client.invalidateQueries({ queryKey: ['file-naming-preview', instanceId], refetchType: 'none' }), client.invalidateQueries({ queryKey: ['library'] })]);
    message.success(mode === 'inherit' ? '已恢复来源命名设置' : '文件命名已保存'); close();
  } });
  const dirtyPreview = policyKey !== JSON.stringify(previewPolicy);
  function insertField(field: string) {
    const input = document.getElementById(templateId) as HTMLTextAreaElement | null;
    const start = input?.selectionStart ?? template.template.length; const end = input?.selectionEnd ?? start; const value = `{{${field}}}`;
    setTemplate(current => ({ ...current, template: current.template.slice(0, start) + value + current.template.slice(end) }));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + value.length, start + value.length); });
  }
  const fields = Object.entries(settings.fields);
  return <Form layout="vertical" onFinish={() => save.mutate()} className="file-naming-form">
    <Form.Item label={directoryRef === undefined ? '来源默认命名' : '此目录命名'}><Select aria-label="文件命名方式" value={mode} onChange={setMode} options={[
      ...(directoryRef === undefined ? [] : [{ value: 'inherit', label: '跟随来源设置' }]),
      { value: 'original', label: '插件原文件名' }, { value: 'template', label: '自定义模板' }
    ]} /></Form.Item>
    {mode === 'template' && <><Form.Item label="文件名模板" htmlFor={templateId} extra="扩展名自动追加。" required>
      <Input.TextArea id={templateId} value={template.template} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="{{title}} - {{artist}}" onChange={event => setTemplate(current => ({ ...current, template: event.target.value }))} />
    </Form.Item><div className="naming-field-picker"><span>插入字段</span><Space wrap size={[6, 6]}>{fields.map(([field, fieldLabel]) => <Button key={field} size="small" onClick={() => insertField(field)}>{fieldLabel}</Button>)}</Space></div>
      <Form.Item label="从示例开始"><Select<string> aria-label="命名模板示例" placeholder="选择后可继续编辑" value={null} options={[
        { value: '{{title}} - {{artist}}', label: '歌名 - 歌手', fields: ['title', 'artist'] },
        { value: '{{originalName}}', label: '原文件名', fields: ['originalName'] },
        { value: '{{artist}} - {{title}} [{{quality}}]', label: '歌手 - 歌名 [音质]', fields: ['artist', 'title', 'quality'] },
        { value: '{{index}}. {{title}}', label: '序号. 歌名', fields: ['index', 'title'] },
        { value: '{{#track}}{{track}} - {{/track}}{{title}}', label: '曲号 - 歌名（缺曲号时省略）', fields: ['track', 'title'] }
      ].filter(option => option.fields.every(field => settings.fields[field] !== undefined))} onChange={value => setTemplate(current => ({ ...current, template: value }))} /></Form.Item>
      <Collapse className="naming-format-options" ghost size="small" items={[{ key: 'format', label: '格式选项与条件块', children: <>
        <div className="naming-format-grid"><Form.Item label="歌手分隔符"><Input aria-label="歌手分隔符" value={template.artistSeparator} onChange={event => setTemplate(current => ({ ...current, artistSeparator: event.target.value }))} /></Form.Item>
          {(['index', 'track', 'disc'] as const).map(field => <Form.Item key={field} label={`${{ index: '目录序号', track: '专辑曲号', disc: '碟号' }[field]}位数`}><InputNumber min={0} max={12} precision={0} aria-label={`${field}补零位数`} value={template[`${field}Padding`]} onChange={value => setTemplate(current => ({ ...current, [`${field}Padding`]: value ?? 0 }))} /></Form.Item>)}</div>
        <Typography.Paragraph type="secondary">{'条件块示例：{{#album}}[{{album}}] {{/album}} 仅在专辑有值时显示方括号和其中的文字。'}</Typography.Paragraph>
      </> }]} /></>}
    <div className="naming-preview-heading"><Typography.Title level={5}>{directoryRef === undefined ? '已加载目录预览' : '名称预览'}</Typography.Title></div>
    <Failure error={preview.error} retry={() => void preview.refetch()} />
    {preview.isPending ? <Skeleton active paragraph={{ rows: 2 }} /> : preview.data && (preview.data.total === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={preview.data.message ?? '当前目录没有可预览的文件'} /> : <>
      <Typography.Paragraph type="secondary">{`当前预览目录 ${preview.data.total.toLocaleString()} 个文件，${preview.data.changed.toLocaleString()} 个名称变化`}{dirtyPreview || preview.isFetching ? ' · 正在更新预览…' : ''}</Typography.Paragraph>
      {!!preview.data.missingFields.length && <Alert className="feedback" showIcon type="info" title={`部分歌曲缺少${preview.data.missingFields.map(field => settings.fields[field] ?? field).join('、')}，缺失字段留空；没有命名资料的文件保留原名。`} />}
      <List className="naming-preview" size="small" dataSource={preview.data.items.slice(0, 8)} locale={{ emptyText: '当前目录没有可预览的文件' }} renderItem={(item, index) => <List.Item key={index}><div><span className="naming-before">{item.before}</span><span className="naming-after">{item.after}</span></div></List.Item>} />
      {preview.data.changed > 0 && <Typography.Paragraph className="naming-path-impact" type="secondary">应用后文件路径会变化，播放器可能重新入库。</Typography.Paragraph>}
    </>)}
    <Failure error={save.error} /><div className="dialog-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending} disabled={mode === 'template' && !template.template.trim()}>应用命名</Button></div>
  </Form>;
}
