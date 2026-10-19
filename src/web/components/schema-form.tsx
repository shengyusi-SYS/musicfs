import { useMemo } from 'react';
import { Button } from 'antd';
import { generateForm } from '@rjsf/antd';
import { customizeValidator } from '@rjsf/validator-ajv8';
import type { ErrorSchema, RJSFSchema, UiSchema } from '@rjsf/utils';
import type { Configuration, Json } from '@musicfs/plugin-api';
import { ApiError } from '../api';

const JsonForm = generateForm<unknown>();
const validator = customizeValidator<unknown>();

/** Translate the finite public hints here; RJSF-specific options never enter a plugin. */
export default function SchemaForm({ configuration, value, pending, error, onSubmit, submitLabel = '保存配置' }: {
  configuration: Configuration; value: Json; pending: boolean; error: Error | null; onSubmit: (config: Json) => void; submitLabel?: string;
}) {
  const ui = useMemo(() => {
    const hints: UiSchema<unknown> = Object.create(null) as UiSchema<unknown>;
    if (configuration.ui?.order) hints['ui:order'] = [...configuration.ui.order, '*'];
    for (const [field, widget] of Object.entries(configuration.ui?.widgets ?? {})) {
      const path = field.startsWith('/') ? field.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')) : [field];
      let target = hints;
      for (const part of path) {
        if (!Object.hasOwn(target, part)) Object.defineProperty(target, part, { value: Object.create(null), enumerable: true });
        target = target[part] as UiSchema<unknown>;
      }
      if (widget === 'uri') target['ui:widget'] = 'uri';
      else target['ui:widget'] = widget;
    }
    return hints;
  }, [configuration]);
  const extraErrors = useMemo(() => {
    // ErrorSchema<Json> expands the recursive JSON union indefinitely in TypeScript.
    const errors: ErrorSchema = Object.create(null) as ErrorSchema;
    if (!(error instanceof ApiError)) return errors;
    for (const field of error.fault?.fields ?? []) {
      let target: Record<string, unknown> = errors;
      const parts = field.path.startsWith('/') ? field.path.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')) : [field.path];
      for (const part of parts.filter(Boolean)) {
        if (!Object.hasOwn(target, part)) Object.defineProperty(target, part, { value: Object.create(null), enumerable: true });
        target = target[part] as Record<string, unknown>;
      }
      target.__errors = [...(target.__errors as string[] | undefined ?? []), field.message];
    }
    return errors;
  }, [error]);
  return <JsonForm schema={configuration.schema as RJSFSchema} uiSchema={ui} validator={validator} formData={value}
    disabled={pending} extraErrors={extraErrors} extraErrorsBlockSubmit={false} omitExtraData={false} showErrorList={false}
    onSubmit={({ formData }) => onSubmit((formData ?? null) as Json)}>
    <Button type="primary" htmlType="submit" loading={pending}>{submitLabel}</Button>
  </JsonForm>;
}
