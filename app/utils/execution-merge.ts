import type {
  ActualExecution,
  ExecutionPackage,
  ExecutionRecord,
  MergeOutcome,
  PendingActual,
  Scene,
  ShowData,
  TimingDeviation,
} from 'stage-cue-editor/models/show';

const TIME_PATTERN = /^\d{1,2}:\d{2}(:\d{2})?$/;

export interface ValidationResult {
  ok: boolean;
  pkg: ExecutionPackage | null;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** 校验断网回传导入包；失败时不返回任何可用数据，调用方应保留原表供重试。 */
export function validateExecutionPackage(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw))
    return { ok: false, pkg: null, errors: ['导入包不是有效的 JSON 对象'] };

  const packageId =
    typeof raw['packageId'] === 'string' ? raw['packageId'].trim() : '';
  if (!packageId) errors.push('导入包缺少 packageId');

  const exportedAt =
    typeof raw['exportedAt'] === 'string' ? raw['exportedAt'] : '';
  const source =
    typeof raw['source'] === 'string' && raw['source'].trim()
      ? raw['source'].trim()
      : '未知现场终端';
  if (!Array.isArray(raw['records'])) {
    errors.push('导入包缺少 records 记录列表');
    return { ok: false, pkg: null, errors };
  }

  const records: ExecutionRecord[] = [];
  raw['records'].forEach((entry, index) => {
    const label = `第 ${index + 1} 条记录`;
    if (!isRecord(entry)) {
      errors.push(`${label}格式无效`);
      return;
    }
    const cueId =
      typeof entry['cueId'] === 'string' ? entry['cueId'].trim() : '';
    const sceneId =
      typeof entry['sceneId'] === 'string' ? entry['sceneId'].trim() : '';
    const executedAt =
      typeof entry['executedAt'] === 'string' ? entry['executedAt'].trim() : '';
    if (!cueId) errors.push(`${label}缺少提示编号 cueId`);
    if (!sceneId) errors.push(`${label}缺少场次归属 sceneId`);
    if (!executedAt) {
      errors.push(`${label}缺少执行时间 executedAt`);
    } else if (!TIME_PATTERN.test(executedAt)) {
      errors.push(`${label}执行时间格式应为 HH:MM 或 HH:MM:SS：${executedAt}`);
    }
    if (cueId && sceneId && executedAt && TIME_PATTERN.test(executedAt)) {
      records.push({
        cueId,
        sceneId,
        executedAt: normalizeTime(executedAt),
        source:
          typeof entry['source'] === 'string' && entry['source'].trim()
            ? entry['source'].trim()
            : undefined,
        recordedAt:
          typeof entry['recordedAt'] === 'string'
            ? entry['recordedAt']
            : undefined,
      });
    }
  });

  if (errors.length) return { ok: false, pkg: null, errors };
  return { ok: true, pkg: { packageId, exportedAt, source, records }, errors };
}

/** 仅按提示编号 cueId + 场次归属 sceneId 对位；顺序与标题不参与身份判断。 */
export function mergeExecutionPackage(
  show: ShowData,
  rawPkg: ExecutionPackage,
): { show: ShowData; outcome: MergeOutcome } {
  const next: ShowData = JSON.parse(JSON.stringify(show)) as ShowData;
  const merged: MergeOutcome['merged'] = [];
  const pending: PendingActual[] = [];

  const pushPending = (
    entry: Omit<PendingActual, 'id' | 'createdAt' | 'packageId'>,
    timeKey: string,
  ): void => {
    pending.push({
      ...entry,
      id: `${rawPkg.packageId}:${entry.cueId}:${entry.reason}:${timeKey}`,
      packageId: rawPkg.packageId,
      createdAt: new Date().toISOString(),
    });
  };

  rawPkg.records.forEach((record) => {
    const source = record.source ?? rawPkg.source;
    const recordedAt = record.recordedAt ?? rawPkg.exportedAt;
    const ownerScene = next.scenes.find((scene) => scene.id === record.sceneId);
    const cue = ownerScene?.cues.find((item) => item.id === record.cueId);
    const localTitle = findCueTitle(next, record.cueId);

    if (!ownerScene || !cue) {
      // 提示在原场次找不到：可能被撤下，也可能被换到别的场次，两种都不得挂到同名提示。
      const movedTo = next.scenes.find(
        (scene) =>
          scene.id !== record.sceneId &&
          scene.cues.some((item) => item.id === record.cueId),
      );
      pushPending(
        {
          reason: movedTo ? 'scene-moved' : 'cue-removed',
          cueId: record.cueId,
          sceneId: record.sceneId,
          cueTitle: localTitle.title ?? '（原表已无此提示）',
          sceneName: ownerScene
            ? `${ownerScene.act} ${ownerScene.name}`
            : movedTo
              ? `${movedTo.act} ${movedTo.name}`
              : '（原场次已不存在）',
          incomingTime: record.executedAt,
          source,
          recordedAt,
        },
        record.executedAt,
      );
      return;
    }

    const localTime = cue.actual?.time;
    if (localTime && localTime !== record.executedAt) {
      // 双方都改了执行时间：两份都留待确认，计划时间与现有执行时间均不动。
      pushPending(
        {
          reason: 'conflict',
          cueId: record.cueId,
          sceneId: record.sceneId,
          cueTitle: cue.title,
          sceneName: `${ownerScene.act} ${ownerScene.name}`,
          incomingTime: record.executedAt,
          localTime,
          source,
          recordedAt,
        },
        record.executedAt,
      );
      return;
    }

    if (!localTime) {
      const actual: ActualExecution = {
        time: record.executedAt,
        source,
        recordedAt,
      };
      cue.actual = actual;
      merged.push({ cueId: record.cueId, sceneId: record.sceneId, actual });
    }
  });

  const deviations = buildDeviations(next);
  next.updatedAt = new Date().toISOString();
  return {
    show: next,
    outcome: { merged, pending: dedupePending(pending), deviations },
  };
}

/** 待核记录人工确认后挂到指定提示；仅接受编号与场次仍对得上的情况。 */
export function resolvePending(
  show: ShowData,
  pending: PendingActual,
  acceptIncoming: boolean,
): { show: ShowData } {
  const next: ShowData = JSON.parse(JSON.stringify(show)) as ShowData;
  const scene = next.scenes.find((item) => item.id === pending.sceneId);
  const cue = scene?.cues.find((item) => item.id === pending.cueId);
  if (!scene || !cue) return { show: next };
  if (acceptIncoming) {
    cue.actual = {
      time: pending.incomingTime,
      source: pending.source,
      recordedAt: pending.recordedAt,
    };
  } else if (pending.localTime) {
    cue.actual = {
      time: pending.localTime,
      source: cue.actual?.source ?? '本机记录',
      recordedAt: cue.actual?.recordedAt ?? pending.createdAt,
    };
  }
  next.updatedAt = new Date().toISOString();
  return { show: next };
}

export function plannedStartTime(scene: Scene, offset: number): string {
  return formatTime(toSceneSeconds(scene.startTime) + offset);
}

/** 列出当前全部已对位提示的计划开始时间与实际执行时间偏差。 */
export function collectDeviations(show: ShowData): TimingDeviation[] {
  return buildDeviations(show);
}

function buildDeviations(show: ShowData): TimingDeviation[] {
  const deviations: TimingDeviation[] = [];
  show.scenes.forEach((scene) => {
    scene.cues.forEach((cue) => {
      if (!cue.actual) return;
      const plannedStart = plannedStartTime(scene, cue.offset);
      const deltaSeconds =
        toDaySeconds(cue.actual.time) -
        (toSceneSeconds(scene.startTime) + cue.offset);
      deviations.push({
        id: `dev-${scene.id}-${cue.id}`,
        cueId: cue.id,
        sceneId: scene.id,
        cueTitle: cue.title,
        sceneName: `${scene.act} ${scene.name}`,
        plannedStart,
        actualStart: cue.actual.time,
        deltaSeconds,
        source: cue.actual.source,
      });
    });
  });
  return deviations;
}

function findCueTitle(show: ShowData, cueId: string): { title: string | null } {
  for (const scene of show.scenes) {
    const found = scene.cues.find((item) => item.id === cueId);
    if (found) return { title: found.title };
  }
  return { title: null };
}

function dedupePending(items: PendingActual[]): PendingActual[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeTime(value: string): string {
  const parts = value.split(':');
  if (parts.length === 2) return `${parts[0]!.padStart(2, '0')}:${parts[1]}:00`;
  return `${parts[0]!.padStart(2, '0')}:${parts[1]}:${parts[2] ?? '00'}`;
}

function toDaySeconds(value: string): number {
  const [hour = '0', minute = '0', second = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60 + Number(second);
}

function toSceneSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

function formatTime(total: number): string {
  const hour = Math.floor((((total % 86400) + 86400) % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
