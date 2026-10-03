export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

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
  /** 断网回传的实际执行时间（HH:mm:ss）；为空表示尚无现场记录 */
  actualTime?: string;
  /** 实际执行记录的来源（巡演设备／记录单），随记录一并保留 */
  actualSource?: string;
}

/** 断网期间在巡演设备上产生的单条现场执行记录 */
export interface ExecutionRecord {
  recordId: string;
  /** 对位身份：提示编号（提示 ID），顺序与标题不作身份依据 */
  cueId: string;
  /** 对位身份：记录所属场次 */
  sceneId: string;
  cueTitle: string;
  /** 现场实际执行时间 HH:mm:ss */
  executedAt: string;
  executedBy: string;
  /** 设备／记录单来源，合并后保留在提示上 */
  device: string;
  note?: string;
}

/** 断网回传导入包 */
export interface ExecutionPackage {
  packageId: string;
  exportedAt: string;
  venue: string;
  records: ExecutionRecord[];
  /** 由 records 内容计算的校验和，防止回传串改／截断 */
  checksum: string;
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

export type PendingKind = 'time-conflict' | 'cue-withdrawn' | 'cue-moved';

/** 合并后需要人工核对的记录（双方改时间 / 撤下 / 换场 / 找不到编号） */
export interface PendingRecord {
  kind: PendingKind;
  record: ExecutionRecord;
  /** 若提示在本机的另一场次，记录该场次；不挂到同名提示上 */
  foundInSceneId?: string;
  foundInSceneLabel?: string;
  /** 双方都改了执行时间时，本机已有值放在这里等待确认 */
  localActualTime?: string;
  detail: string;
}

/** 合并成功后列出的计划时间与实际执行偏差 */
export interface ExecutionDeviation {
  cueId: string;
  sceneId: string;
  cueTitle: string;
  plannedTime: string;
  actualTime: string;
  /** 偏差秒数，正数表示晚于计划 */
  deltaSeconds: number;
  source: string;
}

/** 校验失败的导入包：提示表已恢复原状，原始记录单保留以便重试 */
export interface FailedImport {
  packageId: string;
  rawText: string;
  errors: string[];
  failedAt: string;
}

/** 断网回传合并的持久化状态 */
export interface SyncState {
  pending: PendingRecord[];
  deviations: ExecutionDeviation[];
  lastImportAt: string;
  failedImport: FailedImport | null;
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
