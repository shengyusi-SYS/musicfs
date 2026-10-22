import { useState, type ReactNode } from 'react';
import { App, Button, Checkbox, Form, InputNumber, Modal, Select, Space, Switch, TimePicker } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import { sameUpdateTarget, type UpdateRule, type UpdateRuleInput, type UpdateTarget, type UpdateTiming } from '../../contracts/refresh-policy';
import { ApiError, type Api } from '../api';
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

export function UpdateRuleEditor({ api, rule, instanceId, target, label, instances, close, heading }: {
  api: Api; rule?: UpdateRule | undefined; instanceId?: string | undefined; target?: UpdateTarget | undefined;
  label?: string | undefined; instances?: SourceInstance[] | undefined; close(): void; heading?: string | undefined;
}) {
  const [selectedInstance, setSelectedInstance] = useState(rule?.instanceId ?? instanceId ?? instances?.[0]?.id ?? '');
  const [selectedScope, setScope] = useState<UpdateTarget['kind'] | 'recursive'>();
  const directoryTarget = rule?.target.kind === 'directory' ? rule.target : target?.kind === 'directory' ? target : undefined;
  const directoryName = rule?.label ?? label;
  const rules = useQuery({ queryKey: ['update-rules'], queryFn: ({ signal }) => api.updateRules(signal) });
  const directoryRules = rules.data?.filter(value => value.instanceId === selectedInstance && value.target.kind === 'directory' && value.target.directoryRef === directoryTarget?.directoryRef);
  const initialTarget = rule?.target ?? directoryRules?.find(value => target && sameUpdateTarget(value.target, target))?.target ?? directoryRules?.[0]?.target ?? target;
  const scope = selectedScope ?? (initialTarget?.kind === 'directory' && initialTarget.recursive ? 'recursive' : initialTarget?.kind ?? 'instance');
  const nextTarget: UpdateTarget = scope === 'directory' || scope === 'recursive'
    ? { kind: 'directory', directoryRef: directoryTarget!.directoryRef, recursive: scope === 'recursive' } : { kind: scope };
  const current = rules.data?.find(value => value.instanceId === selectedInstance && sameUpdateTarget(value.target, nextTarget));
  const selection = <>
    {instances && <Form.Item label="音乐来源"><Select aria-label="音乐来源" value={selectedInstance || null} options={instances.map(instance => ({ value: instance.id, label: instance.name }))}
      disabled={!!instanceId} placeholder="选择音乐来源" onChange={value => { setSelectedInstance(value); setScope('instance'); }} /></Form.Item>}
    <Form.Item label="更新范围"><Select aria-label="更新范围" value={scope} onChange={setScope} options={[
      ...(directoryTarget && selectedInstance === (rule?.instanceId ?? instanceId) ? [{ value: 'directory', label: directoryName || '此目录' }, { value: 'recursive', label: (directoryName || '此目录') + '及子目录' }] : []),
      { value: 'instance', label: '全部内容' }, { value: 'roots', label: '仅入口清单' }
    ]} /></Form.Item>
  </>;
  return <Modal title={heading ?? '自动更新'} open onCancel={close} destroyOnHidden footer={null} width={560} loading={rules.isPending}>
    <Failure error={rules.error} retry={() => void rules.refetch()} />
    {rules.data && <UpdateTimingForm key={JSON.stringify([selectedInstance, nextTarget, current?.id])} api={api} rule={current}
      instanceId={selectedInstance} target={nextTarget} label={directoryName} selection={selection} close={close} reload={() => rules.refetch()} />}
  </Modal>;
}

function UpdateTimingForm({ api, rule, instanceId, target, label, selection, close, reload }: {
  api: Api; rule: UpdateRule | undefined; instanceId: string; target: UpdateTarget; label: string | undefined;
  selection: ReactNode; close(): void; reload(): Promise<unknown>;
}) {
  const client = useQueryClient(); const { message } = App.useApp();
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [timingKind, setTimingKind] = useState<UpdateTiming['kind']>(rule?.timing.kind ?? 'daily');
  const [minutes, setMinutes] = useState(rule?.timing.kind === 'interval' ? rule.timing.minutes : 1440);
  const [time, setTime] = useState(rule?.timing.kind !== 'interval' && rule?.timing.time ? rule.timing.time : '08:00');
  const [timezone, setTimezone] = useState(rule?.timing.kind !== 'interval' && rule?.timing.timezone ? rule.timing.timezone : localTimezone());
  const [days, setDays] = useState(rule?.timing.kind === 'weekly' ? rule.timing.weekdays : [1, 2, 3, 4, 5]);
  const save = useMutation({ mutationFn: (input: UpdateRuleInput) => rule ? api.saveUpdateRule(rule.id, input) : api.createUpdateRule(input),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['update-rules'] }); message.success('自动更新已保存'); close(); },
    onError: async error => { if (error instanceof ApiError && error.code === 'update_rule_exists') await reload(); } });
  const existingRuleLoaded = save.error instanceof ApiError && save.error.code === 'update_rule_exists';
  const valid = !!instanceId && (timingKind !== 'interval' || minutes >= 15) && !!time && !!timezone && (timingKind !== 'weekly' || days.length > 0);
  function submit() {
    if (!valid) return;
    const timing: UpdateTiming = timingKind === 'interval' ? { kind: 'interval', minutes }
      : timingKind === 'daily' ? { kind: 'daily', time, timezone } : { kind: 'weekly', time, timezone, weekdays: [...days].sort() };
    save.mutate({ instanceId, target, timing, enabled,
      ...(label && target.kind === 'directory' ? { label } : {}) });
  }
  return <Form layout="vertical" onFinish={submit} className="rule-form">{selection}
      <Form.Item label="时间安排"><Select aria-label="更新时间安排" value={timingKind} onChange={setTimingKind} options={[{ value: 'daily', label: '每天固定时间' }, { value: 'weekly', label: '每周指定时间' }, { value: 'interval', label: '每隔一段时间' }]} /></Form.Item>
      {timingKind === 'interval' ? <Form.Item label="间隔" extra="更新完成后计时"><Space><InputNumber min={15} precision={0} value={minutes} onChange={value => setMinutes(value ?? 15)} aria-label="更新间隔分钟数" /><span>分钟</span></Space></Form.Item>
        : <><div className="rule-time-grid"><Form.Item label="时间" required><TimePicker aria-label="更新时间" format="HH:mm" value={time ? dayjs(`2000-01-01T${time}:00`) : null} allowClear={false} onChange={value => setTime(value?.format('HH:mm') ?? '')} /></Form.Item>
          <Form.Item label="时区" required><Select aria-label="更新时区" showSearch value={timezone} options={[...new Set([...timezones, timezone])].map(value => ({ value, label: value }))} onChange={setTimezone} /></Form.Item></div>
          {timingKind === 'weekly' && <Form.Item label="星期" validateStatus={!days.length ? 'error' : ''} help={!days.length ? '至少选择一天' : undefined}><Checkbox.Group options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value, label: weekdays[value] }))} value={days} onChange={values => setDays(values as number[])} /></Form.Item>}</>}
      <Form.Item label="自动更新"><Switch aria-label="启用自动更新" checked={enabled} checkedChildren="已开启" unCheckedChildren="已暂停" onChange={setEnabled} /></Form.Item>
      <Failure error={existingRuleLoaded ? null : save.error} /><div className="dialog-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending} disabled={!valid}>保存</Button></div>
    </Form>;
}

/** Context menus load policies only while open; directory browsing adds no rule polling. */
export function UpdateRuleControlDialog({ api, instanceId, directoryRef, label, close }: {
  api: Api; instanceId: string; directoryRef?: string | undefined; label?: string | undefined; close(): void;
}) {
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const instanceName = instances.data?.find(instance => instance.id === instanceId)?.name;
  const target: UpdateTarget = directoryRef === undefined ? { kind: 'instance' } : { kind: 'directory', directoryRef, recursive: false };
  return <UpdateRuleEditor api={api} instanceId={instanceId} target={target} label={label} close={close}
    heading={['自动更新', instanceName].filter(Boolean).join(' · ')} />;
}
