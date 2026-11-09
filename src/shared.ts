export type ProjectAvailability = 'unknown' | 'online' | 'offline' | 'unsupported';

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Orca's host identity; null or "local" denotes this machine. */
  hostId?: string | null;
  hostName?: string;
  /** Null for an additional local path which is not an Orca workspace. */
  workspaceId?: string | null;
  /** Git branch. Null for a folder workspace or an extra local path. */
  branch?: string | null;
  /** Omitted when the focused workspace cannot be identified unambiguously. */
  current?: boolean;
  availability?: ProjectAvailability;
  availabilityReason?: string;
  lastFetchedAt?: string;
  /** A live snapshot was read, but could not be persisted for offline use. */
  cacheError?: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  type: string;
  assignee: string;
  labels: string[];
  dependencies: { id: string; type: string }[];
  updatedAt: string;
  createdAt: string;
  closedAt?: string;
  notes?: string;
  acceptance?: string;
  design?: string;
  estimatedMinutes?: number;
  dueAt?: string;
  deferUntil?: string;
  heartbeatAt?: string;
}

export interface Snapshot {
  project: Project;
  issues: Issue[];
  readyIds: string[];
  blockedIds: string[];
  fetchedAt: string;
  /** True when this is the last persisted snapshot rather than a live read. */
  offline?: boolean;
}

export interface RpcRequest {
  method: string;
  project?: string;
  input?: Record<string, unknown>;
  /** BCP-47 tag from the panel. Absent requests stay in English. */
  locale?: string;
}

export interface Transport {
  request<T = unknown>(request: RpcRequest): Promise<T>;
}
