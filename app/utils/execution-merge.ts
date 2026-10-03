import type {
  ExecutionDeviation,
  ExecutionPackage,
  ExecutionRecord,
  PendingRecord,
  Scene,
  ShowData,
} from 'stage-cue-editor/models/show';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 时间字符串支持 HH:mm 或 HH:mm:ss，转成自零点起的秒数；非法返回 null */
export function timeToSeconds(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

export function formatDelta(deltaSeconds: number): string {
  const abs = Math.abs(deltaSeconds);
  const minute = Math.floor(abs / 60);
  const second = abs % 60;
  const body = minute ? `${minute} 分 ${second} 秒` : `${second} 秒`;
  return `${deltaSeconds >= 0 ? '晚 ' : '早 '}${body}`;
}

function sceneLabel(scene: Scene): string {
  return `${scene.act} ${scene.name} · ${scene.title}`;
}

/** 由记录内容计算校验和（FNV-1a），与包内 checksum 比对 */
export function recordsChecksum(records: ExecutionRecord[]): string {
  const canonical = records
    .map((record) =>
      [
        record.recordId,
        record.cueId,
        record.sceneId,
        record.executedAt,
        record.executedBy,
        record.device,
        record.note ?? '',
      ].join('|'),
    )
    .sort()
    .join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface ValidationResult {
  pkg: ExecutionPackage | null;
  errors: string[];
}

/**
 * 解析并校验导入包：结构、字段、时间格式、记录唯一性与校验和。
 * 任一项失败即整包拒绝（随后从原提示表恢复，记录单保留可重试）。
 */
export function parsePackage(rawText: string): ValidationResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { pkg: null, errors: ['导入包不是合法的 JSON 文件'] };
  }
  const candidate = parsed as Partial<ExecutionPackage>;
  if (!candidate || typeof candidate !== 'object') {
    return { pkg: null, errors: ['导入包结构缺失'] };
  }
  if (!candidate.packageId) errors.push('缺少导入包编号 packageId');
  if (!candidate.exportedAt || Number.isNaN(Date.parse(candidate.exportedAt)))
    errors.push('缺少合法的导出时间 exportedAt');
  if (!Array.isArray(candidate.records)) {
    errors.push('缺少现场执行记录列表 records');
    return { pkg: null, errors };
  }
  if (candidate.records.length === 0)
    errors.push('导入包中没有任何现场执行记录');

  const seenRecordIds = new Set<string>();
  const seenCueKeys = new Set<string>();
  candidate.records.forEach((record, index) => {
    const where = `第 ${index + 1} 条记录`;
    if (!record || typeof record !== 'object') {
      errors.push(`${where} 结构损坏`);
      return;
    }
    if (!record.recordId) errors.push(`${where} 缺少记录编号 recordId`);
    else if (seenRecordIds.has(record.recordId))
      errors.push(`${where} 记录编号 ${record.recordId} 重复`);
    seenRecordIds.add(record.recordId);
    if (!record.cueId) errors.push(`${where} 缺少提示编号 cueId`);
    if (!record.sceneId) errors.push(`${where} 缺少场次归属 sceneId`);
    if (timeToSeconds(record.executedAt) === null)
      errors.push(`${where} 执行时间 ${record.executedAt} 格式非法`);
    if (!record.device) errors.push(`${where} 缺少来源设备 device`);
    const cueKey = `${record.sceneId}/${record.cueId}`;
    if (seenCueKeys.has(cueKey))
      errors.push(`${where} 提示编号 ${record.cueId} 在同场次内有多条记录`);
    seenCueKeys.add(cueKey);
  });

  if (!candidate.checksum) {
    errors.push('缺少校验和 checksum');
  } else if (
    Array.isArray(candidate.records) &&
    recordsChecksum(candidate.records as ExecutionRecord[]) !==
      candidate.checksum
  ) {
    errors.push('校验和不匹配，导入包可能已截断或被改动');
  }

  if (errors.length) return { pkg: null, errors };
  return { pkg: candidate as ExecutionPackage, errors: [] };
}

/**
 * 按提示编号 + 场次归属对位，把现场记录合并进提示表副本。
 * - 编号+场次精确命中且本机未记执行时间：直接落位
 * - 双方都记了执行时间：不改计划时间、不覆盖现场值，两份一起进待确认
 * - 提示已撤下（编号在表中找不到）：待核，不挂同名提示
 * - 提示换到别的场次：待核并标出当前所在场次，不自动跨场挂载
 */
export function mergePackage(
  show: ShowData,
  pkg: ExecutionPackage,
): {
  show: ShowData;
  pending: PendingRecord[];
  deviations: ExecutionDeviation[];
} {
  const next: ShowData = clone(show);
  const pending: PendingRecord[] = [];
  const deviations: ExecutionDeviation[] = [];

  const scenesById = new Map(next.scenes.map((scene) => [scene.id, scene]));
  const cueLocations = new Map<string, Scene[]>();
  next.scenes.forEach((scene) => {
    scene.cues.forEach((item) => {
      const list = cueLocations.get(item.id) ?? [];
      list.push(scene);
      cueLocations.set(item.id, list);
    });
  });

  pkg.records.forEach((record) => {
    const scene = scenesById.get(record.sceneId);
    const cue = scene?.cues.find((item) => item.id === record.cueId);

    if (cue && scene) {
      if (cue.actualTime && cue.actualTime !== record.executedAt) {
        pending.push({
          kind: 'time-conflict',
          record: clone(record),
          localActualTime: cue.actualTime,
          detail: `本机与回传记录对「${cue.title}」的执行时间不一致：本机 ${cue.actualTime} / 回传 ${record.executedAt}，两份均保留待确认，计划时间不变。`,
        });
        pushDeviation(
          deviations,
          scene,
          cue,
          cue.actualTime,
          cue.actualSource ?? '本机记录',
        );
        return;
      }
      cue.actualTime = record.executedAt;
      cue.actualSource = record.device;
      pushDeviation(deviations, scene, cue, record.executedAt, record.device);
      return;
    }

    const elsewhere = (cueLocations.get(record.cueId) ?? []).filter(
      (item) => item.id !== record.sceneId,
    );
    if (elsewhere.length) {
      const foundScene = elsewhere[0]!;
      pending.push({
        kind: 'cue-moved',
        record: clone(record),
        foundInSceneId: foundScene.id,
        foundInSceneLabel: sceneLabel(foundScene),
        detail: `记录归属「${record.sceneId}」，但提示编号 ${record.cueId} 现在在 ${sceneLabel(foundScene)}；记录留待核对，未挂到任何同名提示。`,
      });
      return;
    }

    pending.push({
      kind: 'cue-withdrawn',
      record: clone(record),
      detail: `提示编号 ${record.cueId} 在本机提示表中已撤下，记录（${record.executedAt}）留待核对，未挂到同名提示。`,
    });
  });

  next.updatedAt = new Date().toISOString();
  return { show: next, pending, deviations };
}

/** 汇总提示表中所有已回传执行时间的提示，列出计划与实际偏差（现场记录保留来源） */
export function collectDeviations(show: ShowData): ExecutionDeviation[] {
  const deviations: ExecutionDeviation[] = [];
  show.scenes.forEach((scene) => {
    scene.cues.forEach((cue) => {
      if (cue.actualTime)
        pushDeviation(
          deviations,
          scene,
          cue,
          cue.actualTime,
          cue.actualSource ?? '未知来源',
        );
    });
  });
  return deviations;
}

function pushDeviation(
  deviations: ExecutionDeviation[],
  scene: Scene,
  cue: { id: string; title: string; offset: number },
  actualTime: string,
  source: string,
): void {
  const planned = sceneStartSeconds(scene.startTime) + cue.offset;
  const actual = timeToSeconds(actualTime);
  if (actual === null) return;
  deviations.push({
    cueId: cue.id,
    sceneId: scene.id,
    cueTitle: cue.title,
    plannedTime: secondsToTime(planned),
    actualTime,
    deltaSeconds: actual - planned,
    source,
  });
}

function sceneStartSeconds(value: string): number {
  const parsed = timeToSeconds(value);
  return parsed ?? 0;
}

function secondsToTime(total: number): string {
  const wrapped = ((total % 86400) + 86400) % 86400;
  const hour = Math.floor(wrapped / 3600);
  const minute = Math.floor((wrapped % 3600) / 60);
  const second = wrapped % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
