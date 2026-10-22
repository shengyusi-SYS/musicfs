import { useState, type ReactNode } from 'react';
import { App, Button, Checkbox, Form, InputNumber, Modal, Select, Space, TimePicker, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import type { UpdateRule, UpdateRuleInput, UpdateTarget, UpdateTiming } from '../../contracts/refresh-policy';
import type { Api } from '../api';
import { Failure } from './feedback';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const timezones = [...new Set([localTimezone(), 'Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone')])];
export const ruleTargetLabel = (rule: Pick<UpdateRule, 'target' | 'label'>) => rule.target.kind === 'instance' ? '全部内容'
  : rule.target.kind === 'roots' ? '入口清单' : (rule.label || '目录') + (rule.target.recursive ? '及子目录' : '');
export function ruleTimingLabel(timing: UpdateTiming) {
  if (timing.kind === 'interval') return `每隔 ${timing.minutes >= 60 && timing.minutes % 60 === 0 ? `${timing.minutes / 60} 小时` : `${timing.minutes} 分钟`}`;
  return `${timing.kind === 'daily' ? '每天' : timing.weekdays.map(day => weekdays[day]).join('、')} ${timing.time} · ${timing.timezone}`;
}

export function UpdateRuleEditor({ api, rule, instanceId, target, label, instances, close, heading, selection }: {
  api: Api; rule?: UpdateRule | undefined; instanceId?: string | undefined; target?: UpdateTarget | undefined;
  label?: string | undefined; instances?: SourceInstance[] | undefined; close(): void; heading?: string | undefined; selection?: ReactNode;
}) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [selectedInstance, setSelectedInstance] = useState(rule?.instanceId ?? instanceId ?? instances?.[0]?.id ?? '');
  const [scope, setScope] = useState<UpdateTarget['kind'] | 'recursive'>(() => {
    const value = rule?.target ?? target; return value?.kind === 'directory' && value.recursive ? 'recursive' : value?.kind ?? 'instance';
  });
  const [timingKind, setTimingKind] = useState<UpdateTiming['kind']>(rule?.timing.kind ?? 'daily');
  const [minutes, setMinutes] = useState(rule?.timing.kind === 'interval' ? rule.timing.minutes : 1440);
  const [time, setTime] = useState(rule?.timing.kind !== 'interval' && rule?.timing.time ? rule.timing.time : '08:00');
  const [timezone, setTimezone] = useState(rule?.timing.kind !== 'interval' && rule?.timing.timezone ? rule.timing.timezone : localTimezone());
  const [days, setDays] = useState(rule?.timing.kind === 'weekly' ? rule.timing.weekdays : [1, 2, 3, 4, 5]);
  const directoryTarget = rule?.target.kind === 'directory' ? rule.target : target?.kind === 'directory' ? target : undefined;
  const directoryName = rule?.label ?? label;
  const save = useMutation({ mutationFn: (input: UpdateRuleInput) => rule ? api.saveUpdateRule(rule.id, input) : api.createUpdateRule(input),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['update-rules'] }); message.success('自动更新已保存'); close(); } });
  const valid = !!selectedInstance && (timingKind !== 'interval' || minutes >= 15) && !!time && !!timezone && (timingKind !== 'weekly' || days.length > 0);
  function submit() {
    if (!valid) return;
    const nextTarget: UpdateTarget = scope === 'directory' || scope === 'recursive'
      ? { kind: 'directory', directoryRef: directoryTarget!.directoryRef, recursive: scope === 'recursive' } : { kind: scope };
    const timing: UpdateTiming = timingKind === 'interval' ? { kind: 'interval', minutes }
      : timingKind === 'daily' ? { kind: 'daily', time, timezone } : { kind: 'weekly', time, timezone, weekdays: [...days].sort() };
    save.mutate({ instanceId: selectedInstance, target: nextTarget, timing, enabled: rule?.enabled ?? true,
      ...(directoryName && nextTarget.kind === 'directory' ? { label: directoryName } : {}) });
  }
  const instanceName = instances?.find(value => value.id === selectedInstance)?.name;
  return <Modal title={heading ?? `${rule ? '编辑自动更新' : '自动更新'}${instanceName ? ` · ${instanceName}` : ''}`} open onCancel={close} destroyOnHidden footer={null} width={560}>
    <Form layout="vertical" onFinish={submit} className="rule-form">{selection}
      {instances ? <Form.Item label="音乐来源" required><Select aria-label="音乐来源" value={selectedInstance || null} options={instances.map(instance => ({ value: instance.id, label: instance.name }))}
        disabled={!!rule || !!instanceId} placeholder="选择音乐来源" onChange={setSelectedInstance} /></Form.Item> : instanceName && <Typography.Paragraph>{instanceName}</Typography.Paragraph>}
      <Form.Item label="更新范围"><Select aria-label="更新范围" value={scope} onChange={setScope} options={[
        ...(directoryTarget ? [{ value: 'directory', label: directoryName || '此目录' }, { value: 'recursive', label: (directoryName || '此目录') + '及子目录' }] : []),
        { value: 'instance', label: '整个来源的全部内容' }, { value: 'roots', label: '仅入口清单' }
      ]} /></Form.Item>
      <Form.Item label="时间安排"><Select aria-label="更新时间安排" value={timingKind} onChange={setTimingKind} options={[{ value: 'daily', label: '每天固定时间' }, { value: 'weekly', label: '每周指定时间' }, { value: 'interval', label: '每隔一段时间' }]} /></Form.Item>
      {timingKind === 'interval' ? <Form.Item label="间隔" extra="本次更新结束后开始计时。"><Space><InputNumber min={15} precision={0} value={minutes} onChange={value => setMinutes(value ?? 15)} aria-label="更新间隔分钟数" /><span>分钟</span></Space></Form.Item>
        : <><div className="rule-time-grid"><Form.Item label="时间" required><TimePicker aria-label="更新时间" format="HH:mm" value={time ? dayjs(`2000-01-01T${time}:00`) : null} allowClear={false} onChange={value => setTime(value?.format('HH:mm') ?? '')} /></Form.Item>
          <Form.Item label="时区" required><Select aria-label="更新时区" showSearch value={timezone} options={[...new Set([...timezones, timezone])].map(value => ({ value, label: value }))} onChange={setTimezone} /></Form.Item></div>
          {timingKind === 'weekly' && <Form.Item label="星期" validateStatus={!days.length ? 'error' : ''} help={!days.length ? '至少选择一天' : undefined}><Checkbox.Group options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value, label: weekdays[value] }))} value={days} onChange={values => setDays(values as number[])} /></Form.Item>}</>}
      <Failure error={save.error} /><div className="dialog-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending} disabled={!valid}>保存</Button></div>
    </Form>
  </Modal>;
}

/** Context menus load policies only while open; directory browsing adds no rule polling. */
export function UpdateRuleControlDialog({ api, instanceId, directoryRef, label, close }: {
  api: Api; instanceId: string; directoryRef?: string | undefined; label?: string | undefined; close(): void;
}) {
  const rules = useQuery({ queryKey: ['update-rules'], queryFn: ({ signal }) => api.updateRules(signal) });
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const instanceName = instances.data?.find(instance => instance.id === instanceId)?.name;
  const heading = ['自动更新', instanceName, label !== instanceName ? label : undefined].filter(Boolean).join(' · ');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const target: UpdateTarget = directoryRef === undefined ? { kind: 'instance' } : { kind: 'directory', directoryRef, recursive: false };
  const matching = rules.data?.filter(rule => rule.instanceId === instanceId && (directoryRef === undefined ? rule.target.kind === 'instance'
    : rule.target.kind === 'directory' && rule.target.directoryRef === directoryRef));
  const selected = matching?.find(rule => rule.id === selectedId) ?? matching?.[0];
  if (!rules.data) return <Modal title={heading} open onCancel={close} footer={null} loading={rules.isPending}><Failure error={rules.error} retry={() => void rules.refetch()} /></Modal>;
  return <UpdateRuleEditor key={selected?.id ?? 'new'} api={api} rule={selected} instanceId={instanceId} target={target} label={label} close={close}
    heading={heading} selection={(matching?.length ?? 0) > 1 && <Form.Item label="规则"><Select value={selected?.id ?? null} onChange={setSelectedId}
      options={matching!.map(rule => ({ value: rule.id, label: `${ruleTargetLabel(rule)} · ${ruleTimingLabel(rule.timing)}` }))} /></Form.Item>} />;
}
