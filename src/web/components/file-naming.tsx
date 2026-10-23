import { t } from '../i18n';
import { useEffect, useId, useState } from 'react';
import { App, Button, Collapse, Empty, Form, Input, InputNumber, List, Select, Skeleton, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TEMPLATE_POLICY, type FileNamingPolicy, type FileNamingSettings } from '../../contracts/file-naming';
import type { Api } from '../api';
import { Failure } from './feedback';

export function NamingSettings({ api, instanceId, directoryRef, close }: {
  api: Api; instanceId: string; directoryRef?: string | undefined;
  close(): void;
}) {
  const settings = useQuery({ queryKey: ['file-naming', instanceId, directoryRef], queryFn: ({ signal }) => api.fileNaming(instanceId, directoryRef, signal) });
  return <>
    <Failure error={settings.error} retry={() => void settings.refetch()} />
    {settings.isPending ? <Skeleton active /> : settings.data && <NamingForm api={api} instanceId={instanceId} directoryRef={directoryRef} settings={settings.data} close={close} />}
  </>;
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
    message.success(mode === 'inherit' ? t("已恢复来源命名设置") : t("文件命名已保存")); close();
  } });
  const dirtyPreview = policyKey !== JSON.stringify(previewPolicy);
  function insertField(field: string) {
    const input = document.getElementById(templateId) as HTMLTextAreaElement | null;
    const start = input?.selectionStart ?? template.template.length; const end = input?.selectionEnd ?? start; const value = `{{${field}}}`;
    setTemplate(current => ({ ...current, template: current.template.slice(0, start) + value + current.template.slice(end) }));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + value.length, start + value.length); });
  }
  const fields = Object.entries(settings.fields).map(([key, label]) => [key, t(label)] as const);
  return <Form layout="vertical" onFinish={() => save.mutate()} className="file-naming-form">
    <Form.Item label={directoryRef === undefined ? t("来源默认命名") : t("此目录命名")}><Select aria-label={t("文件命名方式")} value={mode} onChange={setMode} options={[
      ...(directoryRef === undefined ? [] : [{ value: 'inherit', label: t("跟随来源设置") }]),
      { value: 'original', label: t("插件原文件名") }, { value: 'template', label: t("自定义模板") }
    ]} /></Form.Item>
    {mode === 'template' && <><Form.Item label={t("文件名模板")} htmlFor={templateId} extra={t("扩展名自动追加。")} required>
      <Input.TextArea id={templateId} value={template.template} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="{{title}} - {{artist}}" onChange={event => setTemplate(current => ({ ...current, template: event.target.value }))} />
    </Form.Item><div className="naming-field-picker"><span>{t("插入字段")}</span><Space wrap size={[6, 6]}>{fields.map(([field, fieldLabel]) => <Button key={field} size="small" onClick={() => insertField(field)}>{fieldLabel}</Button>)}</Space></div>
      <Form.Item label={t("从示例开始")}><Select<string> aria-label={t("命名模板示例")} placeholder={t("选择后可继续编辑")} value={null} options={[
        { value: '{{title}} - {{artist}}', label: t("歌名 - 歌手"), fields: ['title', 'artist'] },
        { value: '{{originalName}}', label: t("原文件名"), fields: ['originalName'] },
        { value: '{{artist}} - {{title}} [{{quality}}]', label: t("歌手 - 歌名 [音质]"), fields: ['artist', 'title', 'quality'] },
        { value: '{{index}}. {{title}}', label: t("序号. 歌名"), fields: ['index', 'title'] },
        { value: '{{#track}}{{track}} - {{/track}}{{title}}', label: t("曲号 - 歌名（缺曲号时省略）"), fields: ['track', 'title'] }
      ].filter(option => option.fields.every(field => settings.fields[field] !== undefined))} onChange={value => setTemplate(current => ({ ...current, template: value }))} /></Form.Item>
      <Collapse className="naming-format-options" ghost size="small" items={[{ key: 'format', label: t("格式选项与条件块"), children: <>
        <div className="naming-format-grid"><Form.Item label={t("歌手分隔符")}><Input aria-label={t("歌手分隔符")} value={template.artistSeparator} onChange={event => setTemplate(current => ({ ...current, artistSeparator: event.target.value }))} /></Form.Item>
          {(['index', 'track', 'disc'] as const).map(field => <Form.Item key={field} label={t("{{value0}}位数", { value0: { index: t("目录序号"), track: t("专辑曲号"), disc: t("碟号") }[field] })}><InputNumber min={0} max={12} precision={0} aria-label={t("{{value0}}补零位数", { value0: field })} value={template[`${field}Padding`]} onChange={value => setTemplate(current => ({ ...current, [`${field}Padding`]: value ?? 0 }))} /></Form.Item>)}</div>
        <Typography.Paragraph type="secondary">{t("条件块示例：{{#album}}[{{album}}] {{/album}} 仅在专辑有值时显示方括号和其中的文字。")}</Typography.Paragraph>
      </> }]} /></>}
    <div className="naming-preview-heading"><Typography.Title level={5}>{directoryRef === undefined ? t("已加载目录预览") : t("名称预览")}</Typography.Title></div>
    <Failure error={preview.error} retry={() => void preview.refetch()} />
    {preview.isPending ? <Skeleton active paragraph={{ rows: 2 }} /> : preview.data && (preview.data.total === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={preview.data.message ? t(preview.data.message) : t("当前目录没有可预览的文件")} /> : <>
      <Typography.Paragraph type="secondary">{t('{{count, number}} 个文件', { count: preview.data.total }) + ' · ' + t('{{count, number}} 个名称变化', { count: preview.data.changed })}{dirtyPreview || preview.isFetching ? t(" · 更新预览中…") : ''}
        {!!preview.data.missingFields.length && t(" · 部分缺少{{value0}}", { value0: preview.data.missingFields.map(field => t(settings.fields[field] ?? field)).join(', ') })}</Typography.Paragraph>
      <List className="naming-preview" size="small" dataSource={preview.data.items.slice(0, 8)} locale={{ emptyText: t("当前目录没有可预览的文件") }} renderItem={(item, index) => <List.Item key={index}><div>{item.before !== item.after && <span className="naming-before">{item.before}</span>}<span className="naming-after">{item.after}</span></div></List.Item>} />
    </>)}
    <Failure error={save.error} /><div className="dialog-actions"><Button onClick={close}>{t("取消")}</Button><Button type="primary" htmlType="submit" loading={save.isPending} disabled={mode === 'template' && !template.template.trim()}>{t("应用命名")}</Button></div>
  </Form>;
}
