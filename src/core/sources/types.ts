import type { AuthStep, Json, PluginFault } from '@musicfs/plugin-api';
import type { Installation } from '../extensions';

export type Instance = { id: string; pluginId: string; name: string; config: Json; epoch: number };
export type InstanceSnapshot = Instance & {
  privateState: Json;
  stateRevision: number;
  pluginRevision: string;
  pluginGeneration: number;
  authentication: AuthenticationRecord | null;
};
export type SourceStamp = Pick<InstanceSnapshot, 'id' | 'pluginId' | 'epoch' | 'pluginRevision' | 'pluginGeneration'>;
export type Authentication = { operationId: string; step: AuthStep | null; error?: PluginFault };
export type AuthenticationRecord = Authentication & { revision: number; stamp: SourceStamp };
export type AuthenticationAction = { kind: 'start' } | { kind: 'cancel'; operationId: string }
  | { kind: 'poll'; operationId: string; challengeId: string }
  | { kind: 'submit'; operationId: string; challengeId: string; input: Json };
type Stored<T> = T | Promise<T>;

/** Adapter operations own atomic checks and writes; no network work runs inside them. */
export interface InstanceStore {
  instances(): Stored<Instance[]>;
  capture(id: string): Stored<InstanceSnapshot | undefined>;
  insert(instance: Instance, privateState: Json, installation: Installation): Stored<boolean>;
  current(snapshot: SourceStamp): Stored<boolean>;
  saveState(snapshot: InstanceSnapshot, state: Json): Stored<boolean>;
  /** Policy-only changes retain the content epoch/authentication; all writes still compare the private-state revision. */
  configure(snapshot: InstanceSnapshot, config: Json, privateState: Json, preserveContent?: boolean): Stored<boolean>;
  /** Advances the epoch while preserving the latest private state, fencing any pending authentication call. */
  advanceAuthentication(snapshot: InstanceSnapshot, next: AuthenticationRecord): Stored<boolean>;
  /** Atomically accepts a step and private state against both the operation and state revisions. */
  saveAuthentication(snapshot: InstanceSnapshot, next: AuthenticationRecord, state: Json): Stored<boolean>;
  deleteInstance(id: string): Stored<void>;
}

export class SourceError extends Error {
  constructor(public readonly code: 'missing_instance' | 'stale_call' | 'invalid_auth_action' | 'plugin_failure', message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

