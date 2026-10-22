/** A display policy never changes the source's configuration or immutable audio identity. */
export type FileNamingPolicy = { mode: 'original' } | {
  mode: 'template';
  template: string;
  artistSeparator: string;
  indexPadding: number;
  trackPadding: number;
  discPadding: number;
};
export type FileNamingRecord = { revision: number; policy: FileNamingPolicy | null };
export type FileNamingSettings = {
  revision: number;
  /** null inherits the instance policy; at instance level it means original plugin names. */
  policy: FileNamingPolicy | null;
  effectivePolicy: FileNamingPolicy;
  inherited: boolean;
  fields: Record<string, string>;
};
export type FileNamingPreview = {
  directoryRef?: string;
  message?: string;
  items: { before: string; after: string }[];
  total: number;
  changed: number;
  /** Fields used in the template but absent from at least one current file. */
  missingFields: string[];
};
export const DEFAULT_TEMPLATE_POLICY: Extract<FileNamingPolicy, { mode: 'template' }> = {
  mode: 'template', template: '{{title}} - {{artist}}', artistSeparator: '、', indexPadding: 4, trackPadding: 2, discPadding: 1
};
