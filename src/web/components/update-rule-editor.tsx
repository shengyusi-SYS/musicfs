import { t } from '../i18n';
import { useState, type ReactNode } from 'react';
import { App, Button, Checkbox, Drawer, Form, InputNumber, Select, Skeleton, Space, Switch, TimePicker } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceInstance } from '../../contracts/management';
import { sameUpdateTarget, type UpdateRule, type UpdateRuleInput, type UpdateTarget, type UpdateTiming } from '../../contracts/refresh-policy';
import { ApiError, type Api } from '../api';
import { Failure } from './feedback';

const weekdays = () => [t("周日"), t("周一"), t("周二"), t("周三"), t("周四"), t("周五"), t("周六")];
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const timezones = [...new Set([localTimezone(), 'Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone')])];
export const ruleTargetLabel = (rule: Pick<UpdateRule, 'target' | 'label'>) => rule.target.kind === 'instance' ? t("全部内容")
  : rule.target.kind === 'roots' ? t("入口清单") : (rule.label || t("目录")) + (rule.target.recursive ? t("及子目录") : '');
export function ruleTimingLabel(timing: UpdateTiming) {
  if (timing.kind === 'interval') return t("每隔 {{value0}}", { value0: timing.minutes >= 60 && timing.minutes % 60 === 0 ? t('{{count, number}} 小时', { count: timing.minutes / 60 }) : t('{{count, number}} 分钟', { count: timing.minutes }) });
  return `${timing.kind === 'daily' ? t("每天") : timing.weekdays.map(day => weekdays()[day]).join(', ')} ${timing.time} · ${timing.timezone}`;
}
export function UpdateRuleEditor({ api, rule, instanceId, target, label, instances, close, heading }: {
  api: Api; rule?: UpdateRule | undefined; instanceId?: string | undefined; target?: UpdateTarget | undefined;
  label?: string | undefined; instances?: SourceInstance[] | undefined; close(): void; heading?: string | undefined;
}) {
  return <Drawer title={heading ?? t("自动更新")} open onClose={close} destroyOnHidden size={560} mask={false}>
    <UpdateRuleSettings api={api} rule={rule} instanceId={instanceId} target={target} label={label} instances={instances} close={close} />
  </Drawer>;
}
export function UpdateRuleSettings({ api, rule, instanceId, target, label, instances, close }: {
  api: Api; rule?: UpdateRule | undefined; instanceId?: string | undefined; target?: UpdateTarget | undefined;
  label?: string | undefined; instances?: SourceInstance[] | undefined; close(): void;
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
    {instances && <Form.Item label={t("音乐来源")}><Select aria-label={t("音乐来源")} value={selectedInstance || null} options={instances.map(instance => ({ value: instance.id, label: instance.name }))}
      disabled={!!instanceId} placeholder={t("选择音乐来源")} onChange={value => { setSelectedInstance(value); setScope('instance'); }} /></Form.Item>}
    <Form.Item label={t("更新范围")}><Select aria-label={t("更新范围")} value={scope} onChange={setScope} options={[
      ...(directoryTarget && selectedInstance === (rule?.instanceId ?? instanceId) ? [{ value: 'directory', label: directoryName || t("此目录") }, { value: 'recursive', label: (directoryName || t("此目录")) + t("及子目录") }] : []),
      { value: 'instance', label: t("全部内容") }, { value: 'roots', label: t("仅入口清单") }
    ]} /></Form.Item>
  </>;
  return <>
    <Failure error={rules.error} retry={() => void rules.refetch()} />
    {rules.isPending && <Skeleton active paragraph={{ rows: 4 }} />}
    {rules.data && <UpdateTimingForm key={JSON.stringify([selectedInstance, nextTarget, current?.id])} api={api} rule={current}
      instanceId={selectedInstance} target={nextTarget} label={directoryName} selection={selection} close={close} reload={() => rules.refetch()} />}
  </>;
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
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['update-rules'] }); message.success(t("自动更新已保存")); close(); },
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
      <Form.Item label={t("时间安排")}><Select aria-label={t("更新时间安排")} value={timingKind} onChange={setTimingKind} options={[{ value: 'daily', label: t("每天固定时间") }, { value: 'weekly', label: t("每周指定时间") }, { value: 'interval', label: t("每隔一段时间") }]} /></Form.Item>
      {timingKind === 'interval' ? <Form.Item label={t("间隔")} extra={t("更新完成后计时")}><Space><InputNumber min={15} precision={0} value={minutes} onChange={value => setMinutes(value ?? 15)} aria-label={t("更新间隔分钟数")} /><span>{t("分钟")}</span></Space></Form.Item>
        : <><div className="rule-time-grid"><Form.Item label={t("时间")} required><TimePicker aria-label={t("更新时间")} format="HH:mm" value={time ? dayjs(`2000-01-01T${time}:00`) : null} allowClear={false} onChange={value => setTime(value?.format('HH:mm') ?? '')} /></Form.Item>
          <Form.Item label={t("时区")} required><Select aria-label={t("更新时区")} showSearch value={timezone} options={[...new Set([...timezones, timezone])].map(value => ({ value, label: value }))} onChange={setTimezone} /></Form.Item></div>
          {timingKind === 'weekly' && <Form.Item label={t("星期")} validateStatus={!days.length ? 'error' : ''} help={!days.length ? t("至少选择一天") : undefined}><Checkbox.Group options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value, label: weekdays()[value] }))} value={days} onChange={values => setDays(values as number[])} /></Form.Item>}</>}
      <Form.Item label={t("自动更新")}><Switch aria-label={t("启用自动更新")} checked={enabled} checkedChildren={t("已开启")} unCheckedChildren={t("已暂停")} onChange={setEnabled} /></Form.Item>
      <Failure error={existingRuleLoaded ? null : save.error} /><div className="dialog-actions"><Button onClick={close}>{t("取消")}</Button><Button type="primary" htmlType="submit" loading={save.isPending} disabled={!valid}>{t("保存")}</Button></div>
    </Form>;
}
