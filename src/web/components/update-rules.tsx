import { t, currentLanguage } from '../i18n';
import { useState } from 'react';
import { App, Button, Empty, Skeleton, Space, Switch, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateRule } from '../../contracts/refresh-policy';
import type { RefreshView } from '../../contracts/refreshes';
import type { Api } from '../api';
import { Failure } from './feedback';
import { RefreshProgress, usePersistentRefresh } from './refresh';
import { ruleTargetLabel, ruleTimingLabel, UpdateRuleEditor } from './update-rule-editor';

const states = { get queued() { return t("等待更新"); }, get running() { return t("更新中"); }, get completed() { return t("已完成"); }, get failed() { return t("更新失败"); }, get superseded() { return t("已被替代"); }, get cancelled() { return t("已取消"); } };
const date = (value: string | null) => value ? new Date(value).toLocaleString(currentLanguage()) : t("尚未执行");
export function UpdateRules({ api }: { api: Api }) {
  const client = useQueryClient(); const { message } = App.useApp();
  const rules = useQuery({ queryKey: ['update-rules'], queryFn: ({ signal }) => api.updateRules(signal),
    refetchInterval: query => query.state.data?.some(rule => rule.status === 'queued' || rule.status === 'running') ? 2_000 : false });
  const instances = useQuery({ queryKey: ['instances'], queryFn: ({ signal }) => api.instances(signal) });
  const [editing, setEditing] = useState<UpdateRule | 'new' | null>(null);
  const [operation, setOperation] = useState<{ instanceId: string; operationId: string } | undefined>();
  const refresh = usePersistentRefresh(api, { ...operation, onCompleted: () => { void client.invalidateQueries({ queryKey: ['update-rules'] }); } });
  const invalidate = () => client.invalidateQueries({ queryKey: ['update-rules'] });
  const toggle = useMutation({ mutationFn: (rule: UpdateRule) => api.saveUpdateRule(rule.id, { instanceId: rule.instanceId, target: rule.target, timing: rule.timing, enabled: !rule.enabled, ...(rule.label ? { label: rule.label } : {}) }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteUpdateRule(id), onSuccess: async () => { await invalidate(); message.success(t("自动更新规则已删除")); } });
  const run = useMutation({ mutationFn: (id: string) => api.runUpdateRule(id), onSuccess: async (view: RefreshView) => {
    client.setQueryData(['refresh', view.operationId], view); setOperation({ instanceId: view.instanceId, operationId: view.operationId }); await invalidate();
  } });
  return <section className="surface"><div className="section-heading"><Typography.Title level={3}>{t("自动更新")}</Typography.Title><Button icon={<PlusOutlined aria-hidden="true" />} disabled={!instances.data?.length} onClick={() => setEditing('new')}>{t("添加规则")}</Button></div>
    <Failure error={rules.error} retry={() => void rules.refetch()} /><Failure error={instances.error} retry={() => void instances.refetch()} />
    <Failure error={toggle.error ?? remove.error ?? run.error} />{operation && <RefreshProgress operation={refresh} reload={() => refresh.retry()} />}
    {rules.isPending ? <Skeleton active /> : rules.data?.length ? <div className="update-rule-list">{rules.data.map(rule => {
      const busy = rule.status === 'queued' || rule.status === 'running';
      return <article className="update-rule-row" key={rule.id}><div className="update-rule-identity"><div><Typography.Text strong>{instances.data?.find(instance => instance.id === rule.instanceId)?.name ?? t("音乐来源")} · {ruleTargetLabel(rule)}</Typography.Text>
        {rule.status && <Tag color={rule.status === 'failed' ? 'error' : rule.failedDirectories ? 'warning' : busy ? 'processing' : 'default'}>{rule.status === 'completed' && rule.failedDirectories > 0 ? t('部分失败（{{count, number}} 个目录）', { count: rule.failedDirectories }) : states[rule.status]}</Tag>}</div>
        <div className="secondary-id">{ruleTimingLabel(rule.timing)}</div><div className="secondary-id">{!rule.enabled ? t("已暂停") : rule.nextRunAt ? t("下次计划：{{value0}}", { value0: date(rule.nextRunAt) }) : busy ? t("本次完成后安排下次更新") : t("等待安排")}{rule.lastRunAt && t(" · 上次执行：{{value0}}", { value0: date(rule.lastRunAt) })}</div>
      </div><Space wrap className="update-rule-actions"><Switch checked={rule.enabled} aria-label={t("启用{{value0}}自动更新", { value0: ruleTargetLabel(rule) })} loading={toggle.isPending && toggle.variables?.id === rule.id} disabled={toggle.isPending} onChange={() => toggle.mutate(rule)} />
        {busy && rule.operationId ? <Button size="small" onClick={() => setOperation({ instanceId: rule.instanceId, operationId: rule.operationId! })}>{t("查看进度")}</Button>
          : <Button size="small" icon={<PlayCircleOutlined aria-hidden="true" />} loading={run.isPending && run.variables === rule.id} onClick={() => run.mutate(rule.id)}>{t("立即更新")}</Button>}
        <Button size="small" icon={<EditOutlined aria-hidden="true" />} aria-label={t("编辑{{value0}}规则", { value0: ruleTargetLabel(rule) })} onClick={() => setEditing(rule)} />
        <Button size="small" type="text" danger icon={<DeleteOutlined aria-hidden="true" />} aria-label={t("删除{{value0}}规则", { value0: ruleTargetLabel(rule) })} loading={remove.isPending && remove.variables === rule.id} onClick={() => remove.mutate(rule.id)} />
      </Space></article>;
    })}</div> : !rules.isError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("还没有自动更新规则")} />}
    {editing && <UpdateRuleEditor key={editing === 'new' ? 'new' : editing.id} api={api} {...(editing === 'new' ? {} : { rule: editing })} instances={instances.data ?? []} close={() => setEditing(null)} />}
  </section>;
}
