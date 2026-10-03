export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

/** 断网回传后对位到提示的现场执行时间，保留记录来源。 */
export interface ActualExecution {
  time: string;
  source: string;
  recordedAt: string;
}

/** 无法自动对位的回传记录：撤下、换场或双方执行时间冲突。 */
export type PendingReason = 'cue-removed' | 'scene-moved' | 'conflict';

export interface PendingActual {
  id: string;
  reason: PendingReason;
  cueId: string;
  sceneId: string;
  cueTitle: string;
  sceneName: string;
  incomingTime: string;
  localTime?: string;
  source: string;
  recordedAt: string;
  packageId: string;
  createdAt: string;
}

export interface Cue {
  id: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  dependsOn: string[];
  offset: number;
  actual?: ActualExecution;
}

export interface Scene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cues: Cue[];
}

export interface ShowData {
  title: string;
  venue: string;
  date: string;
  scenes: Scene[];
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  data: ShowData;
}

/** 断网期间现场回传的单条执行记录。身份只认提示编号与场次归属。 */
export interface ExecutionRecord {
  cueId: string;
  sceneId: string;
  executedAt: string;
  source?: string;
  recordedAt?: string;
}

export interface ExecutionPackage {
  packageId: string;
  exportedAt: string;
  source: string;
  records: ExecutionRecord[];
}

export interface TimingDeviation {
  id: string;
  cueId: string;
  sceneId: string;
  cueTitle: string;
  sceneName: string;
  plannedStart: string;
  actualStart: string;
  deltaSeconds: number;
  source: string;
}

export interface MergeOutcome {
  merged: Array<{ cueId: string; sceneId: string; actual: ActualExecution }>;
  pending: PendingActual[];
  deviations: TimingDeviation[];
}

export interface CueDraft {
  id?: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string;
  cast: string;
  notes: string;
  dependsOn: string;
}

export interface CueIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  icon?: string;
  sceneId?: string;
  cueId?: string;
}

export interface VersionDiff {
  id: string;
  changed: boolean;
  label: string;
  before: string;
  after: string;
}

export const CUE_KINDS: CueKind[] = [
  '灯光',
  '音响',
  '道具',
  '演员',
  '舞台',
  '字幕',
];
export const OWNERS = ['李岚', '周启', '陈默', '赵一帆', '孙禾', '待指定'];
