/* Domain model — spec §9 (data model) and §18 (data contract).
   Ids are strings, times are epoch milliseconds, money is integer halalas (1 SAR = 100). */

export const DEPT_IDS = ['exec', 'research', 'amazon', 'supply', 'marketing', 'finance', 'tech', 'personal', 'core'] as const;
export type DeptId = (typeof DEPT_IDS)[number];
export type OpsDeptId = Exclude<DeptId, 'core'>;

export const TASK_STATUSES = ['scheduled', 'progress', 'waiting', 'done', 'backlog', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: readonly TaskStatus[] = ['scheduled', 'progress', 'waiting', 'backlog'];

export const ACTION_TYPES = [
  'read', 'report', 'internal', 'price_change', 'ad_budget', 'listing_edit',
  'supplier_msg', 'purchase_order', 'payment', 'external_email'
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const STAGE_IDS = ['research', 'sourcing', 'shipping', 'live', 'paused'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const MODELS = ['SONNET', 'OPUS', 'HAIKU'] as const;
export type ModelKey = (typeof MODELS)[number];

export const FREQS = ['daily', 'workdays', 'weekly', 'monthly1'] as const;
export type Freq = (typeof FREQS)[number];

export type AlertLevel = 'critical' | 'warning' | 'info';
export type PolicyMode = 'auto' | 'limit' | 'always';
export type ConnectorMethod = 'mcp' | 'api' | 'browser' | 'import' | 'manual';
export type ConnectorState = 'connected' | 'simulated' | 'needs_auth' | 'connecting' | 'disabled' | 'manual' | 'unavailable';

export interface FileDoc { name: string; body: string }

export interface PendingCall {
  /** tool name as exposed to the model */
  tool: string;
  /** exact input the model produced — executed verbatim after approval */
  input: Record<string, unknown>;
  action: ActionType;
  value?: number;
  /** connector id when the call targets an external connector */
  connector?: string | null;
  reason: string;
  toolUseId: string;
}

export interface Task {
  id: string;
  title: string;
  dept: DeptId;
  agent: string;
  status: TaskStatus;
  at: number | null;
  doneAt: number | null;
  progress: number;
  action: ActionType;
  value?: number;
  ok: boolean;
  routine: string | null;
  source: string | null;
  productId: string | null;
  model: ModelKey;
  team: boolean;
  viaExec: boolean;
  artifact: FileDoc | null;
  result: { summary: string; file?: FileDoc | null } | null;
  /** owner forced approval ("after my approval") */
  force?: boolean;
  /** model cost of the finished task, halalas */
  cost?: number;
  tokens?: number;
  /** why the task needs approval (shown above the draft) */
  approvalReason?: string | null;
  createdAt?: number;
}

export interface Routine {
  id: string;
  title: string;
  dept: DeptId;
  agent: string;
  freq: Freq;
  dow?: number;
  time: string;
  action: ActionType;
  paused: boolean;
}

export interface StageEntry { stage: StageId; at: number }

export interface Product {
  id: string;
  name: string;
  sku: string;
  asin: string | null;
  stage: StageId;
  stageSince: number;
  cost: number;
  price: number;
  stock: number;
  sales7d: number;
  note: string;
  stages: StageEntry[];
  flags: { low?: boolean; stall?: StageId | null };
}

export interface Alert {
  id: string;
  level: AlertLevel;
  dept: DeptId;
  agent: string;
  title: string;
  detail: string;
  productId: string | null;
  at: number;
  dismissed: boolean;
  taskId: string | null;
}

export interface Policy {
  action: ActionType;
  label: string;
  mode: PolicyMode;
  limit?: number;
  unit?: '%' | 'SAR';
  locked?: boolean;
}

export interface PolicyOverride {
  action: ActionType;
  scope: 'agent' | 'dept';
  /** agent id (config) or dept id */
  target: string;
  mode: PolicyMode;
  limit?: number;
  unit?: '%' | 'SAR';
}

export interface Kpi {
  salesToday: number;
  salesYesterday: number;
  profitToday: number;
  profitYesterday: number;
  adSpendToday: number;
  cash: number;
  ordersToday: number;
  ordersYesterday: number;
  adYesterday: number;
}

export interface Brief { id: string; at: number; text: string; read: boolean }

export type ActivityKind = 'start' | 'finish' | 'draft' | 'route' | 'read' | 'write' | 'alert' | 'approve' | 'cancel' | 'stage';
export interface ActivityEvent { t: number; dept: DeptId; agent: string; kind: ActivityKind; text: string }

export interface ChatMessage { me: boolean; text: string }

export interface AgentConfig {
  id: string;
  name: string;
  dept: DeptId;
  mgr: boolean;
  role: string;
  instructions: string;
  model: ModelKey;
  tools: string[];
  status: 'active' | 'paused';
}

export interface DeptConfig { id: DeptId; name: string; enabled: boolean; tools: string[] }

export interface Settings {
  briefTime: string;
  lowStockDays: number;
  warnStockDays: number;
  acosWarn: number;
  alertRetentionDays: number;
  stageLimits: Record<'research' | 'sourcing' | 'shipping', number>;
  defaultModel: ModelKey;
  managerModel: ModelKey;
}

export interface Budget { monthlyCap: number; warnAt: number; onCap: 'alert' | 'downgrade' | 'pause' }

export interface ToolDef {
  id: string;
  name: string;
  core: boolean;
  dom: string;
  color: string;
  m: ConnectorMethod;
  phase: number;
  custom?: boolean;
}

export interface CompanyConfig {
  version: number;
  publishedAt: number;
  note: string;
  changes: string[];
  depts: DeptConfig[];
  agents: AgentConfig[];
  settings: Settings;
  policies: Policy[];
  overrides: PolicyOverride[];
  budget: Budget;
  customTools: ToolDef[];
  /** only on drafts: agent id -> agent id that inherits open tasks of a deleted agent */
  reassign?: Record<string, string>;
}

export interface ConnectorLogEntry { at: number; level: 'ok' | 'info' | 'warn' | 'error'; text: string }

export interface ConnectorStatus {
  state: ConnectorState;
  scopes: 'read' | 'write';
  lastSync: number | null;
  log: ConnectorLogEntry[];
  hasSecret: boolean;
  last4: string;
  url: string;
  auth: 'oauth' | 'key' | 'none';
  latency: number | null;
  lastError: string;
}

export interface Usage {
  month: string;
  total: number;
  tokens: number;
  tasks: number;
  byAgent: Record<string, { tasks: number; tokens: number; cost: number; dept: DeptId }>;
  byDept: Record<string, number>;
  byModel: Record<ModelKey, number>;
  daily: Record<string, number>;
  warned: number;
  lastMonthTotal: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  area: string;
  action: string;
  target: string;
  detail: string | string[] | null;
}

export interface ConfigHistoryEntry {
  version: number;
  publishedAt: number;
  note: string;
  changes: string[];
  config: CompanyConfig;
}

/** Full snapshot returned by GET /api/state (shape the UI expects). */
export interface State {
  v: 4;
  notes: number;
  tasks: Task[];
  routines: Routine[];
  products: Product[];
  alerts: Alert[];
  policies: Policy[];
  kpi: Kpi;
  metrics: Partial<Record<DeptId, [number, number]>>;
  chats: Partial<Record<DeptId, ChatMessage[]>>;
  briefs: Brief[];
  events: ActivityEvent[];
  running: boolean;
  config: CompanyConfig;
  configHistory: ConfigHistoryEntry[];
  audit: AuditEntry[];
  usage: Usage;
  connectors: Record<string, ConnectorStatus>;
  base: Partial<Record<DeptId, [number, number]>>;
}

export type ServerEvent =
  | { type: 'snapshot'; state: State }
  | { type: 'task.upsert'; task: Task }
  | { type: 'task.remove'; id: string }
  | { type: 'routine.upsert'; routine: Routine }
  | { type: 'routine.remove'; id: string }
  | { type: 'product.upsert'; product: Product }
  | { type: 'alert.upsert'; alert: Alert }
  | { type: 'kpi'; kpi: Kpi }
  | { type: 'metric'; dept: DeptId; values: [number, number] }
  | { type: 'notes'; count: number }
  | { type: 'activity'; event: ActivityEvent; tool?: string | null; brain?: boolean; route?: { from: DeptId; to: DeptId } }
  | { type: 'chat'; dept: DeptId; message: ChatMessage }
  | { type: 'brief'; brief: Brief }
  | { type: 'policies'; policies: Policy[] }
  | { type: 'running'; on: boolean }
  | { type: 'config'; config: CompanyConfig }
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'usage'; usage: Usage }
  | { type: 'connectors'; connectors: Record<string, ConnectorStatus> };

/** Input of createTask (spec §14 composer). */
export interface NewTask {
  title: string;
  dept: DeptId | 'auto';
  mode?: 'auto' | 'schedule' | 'approve' | 'auto_internal';
  at?: number | null;
  model?: ModelKey;
  team?: boolean;
  productId?: string | null;
  repeat?: { freq: Freq; time: string } | null;
  source?: string | null;
}
