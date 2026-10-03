import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  ExecutionPackage,
  ExecutionRecord,
  Scene,
  ShowData,
  SyncState,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';
import {
  collectDeviations,
  formatDelta,
  mergePackage,
  parsePackage,
  recordsChecksum,
} from 'stage-cue-editor/utils/execution-merge';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const EMPTY_SYNC: SyncState = {
  pending: [],
  deviations: [],
  lastImportAt: '',
  failedImport: null,
};

function cue(
  id: string,
  kind: CueKind,
  title: string,
  duration: number,
  owner: string,
  extra: Partial<Cue> = {},
): Cue {
  return {
    id,
    kind,
    title,
    duration,
    owner,
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    ...extra,
  };
}

function initialShow(): ShowData {
  const scenes: Scene[] = [
    {
      id: 'scene-1',
      act: '第一幕',
      name: 'S1',
      title: '月下序场',
      startTime: '19:30',
      locked: false,
      cues: [
        cue('cue-light-1', '灯光', '观众席渐暗 · 面光起', 45, '李岚', {
          lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
          notes: '开演铃后 10 秒执行',
          actualTime: '19:30:08',
          actualSource: '本机手记（周监督）',
        }),
        cue('cue-actor-1', '演员', '说书人自左台入场', 90, '赵一帆', {
          cast: ['说书人／周启'],
          props: ['折扇'],
          notes: '追光跟随；入场后停留台中',
        }),
        cue('cue-sound-1', '音响', '古琴引子淡入', 120, '陈默', {
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          dependsOn: ['cue-deleted-old'],
          notes: '旧版依赖保留用于检查示例',
        }),
        cue('cue-prop-1', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
          props: ['月牙灯'],
          lighting: '顶排 3 号定点',
        }),
      ],
    },
    {
      id: 'scene-2',
      act: '第一幕',
      name: 'S2',
      title: '宫门夜宴',
      startTime: '19:40',
      locked: false,
      cues: [
        cue('cue-stage-2', '舞台', '中景屏风换为朱红', 60, '', {
          notes: '负责人尚未确认',
        }),
        cue('cue-actor-2', '演员', '群臣列队入场', 110, '赵一帆', {
          cast: ['群演 6 人', '侍女 4 人'],
          props: ['宫灯'],
        }),
        cue('cue-light-2', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
          lighting: '顶光 4、5 号 70%，色温 3200K',
        }),
      ],
    },
  ];
  scenes.forEach((scene) => recalculateScene(scene));
  return {
    title: '《长夜行》首演提示表',
    venue: '实验剧场 A 厅',
    date: '2026-10-18',
    scenes,
    updatedAt: new Date().toISOString(),
  };
}

function loadShow(): ShowData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialShow();
    const parsed = JSON.parse(raw) as {
      show: ShowData;
      versions: VersionSnapshot[];
    };
    return parsed.show ?? initialShow();
  } catch {
    return initialShow();
  }
}

function loadVersions(): VersionSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as { versions: VersionSnapshot[] }).versions ?? [];
  } catch {
    return [];
  }
}

function loadSync(): SyncState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(EMPTY_SYNC);
    const parsed = JSON.parse(raw) as { sync?: SyncState };
    return { ...clone(EMPTY_SYNC), ...(parsed.sync ?? {}) };
  } catch {
    return clone(EMPTY_SYNC);
  }
}

function recalculateScene(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}

function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

function timeLabel(scene: Scene, offset: number): string {
  const total = startSeconds(scene.startTime) + offset;
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export default class CueEditorComponent extends Component {
  @tracked show: ShowData = loadShow();
  @tracked versions: VersionSnapshot[] = loadVersions();
  @tracked sync: SyncState = this.initialSync();
  @tracked activeSceneId = this.show.scenes[0]?.id ?? '';
  @tracked selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';
  @tracked importError = '';
  @tracked failedDraft = '';

  private initialSync(): SyncState {
    const stored = loadSync();
    return { ...stored, deviations: collectDeviations(this.show) };
  }

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    window.addEventListener('keydown', this.handleKeyboard);
  }

  get activeScene(): Scene | undefined {
    return this.show.scenes.find((scene) => scene.id === this.activeSceneId);
  }

  get selectedCue(): Cue | undefined {
    return this.activeScene?.cues.find(
      (item) => item.id === this.selectedCueId,
    );
  }

  get cueRows() {
    if (!this.activeScene) return [];
    return this.activeScene.cues.map((item, index) => ({
      ...item,
      index,
      start: timeLabel(this.activeScene as Scene, item.offset),
      end: timeLabel(this.activeScene as Scene, item.offset + item.duration),
      selected: item.id === this.selectedCueId,
      hasIssue: this.issues.some((issue) => issue.cueId === item.id),
      kindClass:
        item.kind === '灯光'
          ? 'light'
          : item.kind === '音响'
            ? 'sound'
            : item.kind === '道具'
              ? 'prop'
              : item.kind === '演员'
                ? 'cast'
                : item.kind === '字幕'
                  ? 'caption'
                  : 'stage',
      propsLabel: item.props.join('、'),
      castLabel: item.cast.join('、'),
      actualTime: item.actualTime ?? '',
      actualSource: item.actualSource ?? '',
      hasActual: Boolean(item.actualTime),
    }));
  }

  get sceneRows() {
    return this.show.scenes.map((scene) => ({
      ...scene,
      active: scene.id === this.activeSceneId,
      issueCount: this.issues.filter((issue) => issue.sceneId === scene.id)
        .length,
      duration: scene.cues.reduce((total, item) => total + item.duration, 0),
    }));
  }

  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }

  get ownerOptions(): string[] {
    return OWNERS;
  }

  get allCues(): Array<{ cue: Cue; scene: Scene }> {
    return this.show.scenes.flatMap((scene) =>
      scene.cues.map((item) => ({ cue: item, scene })),
    );
  }

  get issues(): CueIssue[] {
    const issues: CueIssue[] = [];
    this.allCues.forEach(({ cue: item, scene }) => {
      if (!item.owner) {
        issues.push({
          id: `owner-${item.id}`,
          severity: 'error',
          title: '负责人空缺',
          detail: `${scene.act} ${scene.name}「${item.title}」尚未指定负责人。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      item.dependsOn.forEach((reference) => {
        if (!this.allCues.some((entry) => entry.cue.id === reference)) {
          issues.push({
            id: `ref-${item.id}-${reference}`,
            severity: 'error',
            title: '提示被引用但已删除',
            detail: `「${item.title}」仍依赖已删除的提示 ${reference}。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        }
      });
      const previous = scene.cues[scene.cues.indexOf(item) - 1];
      if (previous && item.offset < previous.offset + previous.duration) {
        issues.push({
          id: `overlap-${item.id}`,
          severity: 'error',
          title: '同场时间冲突',
          detail: `「${item.title}」与上一条提示重叠。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
    });

    const allCues = this.allCues;
    for (let index = 0; index < allCues.length; index += 1) {
      for (let next = index + 1; next < allCues.length; next += 1) {
        const left = allCues[index]!;
        const right = allCues[next]!;
        if (left.cue.id === right.cue.id || left.scene.id === right.scene.id)
          continue;
        const leftStart = startSeconds(left.scene.startTime) + left.cue.offset;
        const rightStart =
          startSeconds(right.scene.startTime) + right.cue.offset;
        if (
          !overlaps(
            leftStart,
            left.cue.duration,
            rightStart,
            right.cue.duration,
          )
        )
          continue;
        const sharedProps = left.cue.props.filter((value) =>
          right.cue.props.includes(value),
        );
        const sharedCast = left.cue.cast.filter((value) =>
          right.cue.cast.includes(value),
        );
        if (sharedProps.length) {
          issues.push({
            id: `prop-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '道具撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
        if (sharedCast.length) {
          issues.push({
            id: `cast-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '演员撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
      }
    }
    return issues.map((issue) => ({
      ...issue,
      icon: issue.severity === 'error' ? '!' : 'i',
    }));
  }

  get selectedProps(): string {
    return this.selectedCue?.props.join('、') ?? '';
  }

  get plannedTimeLabel(): string {
    const scene = this.activeScene;
    const cue = this.selectedCue;
    if (!scene || !cue) return '—';
    return timeLabel(scene, cue.offset);
  }

  get selectedCast(): string {
    return this.selectedCue?.cast.join('、') ?? '';
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const before = version.data.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    const after = this.show.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    return Array.from(
      { length: Math.max(before.length, after.length) },
      (_, index) => ({
        id: `diff-${index}`,
        changed: before[index] !== after[index],
        label: `提示 ${index + 1}`,
        before: before[index] ?? '—',
        after: after[index] ?? '—',
      }),
    );
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}`.toLowerCase().includes(term),
    );
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
  }

  @action
  selectCue(id: string): void {
    this.selectedCueId = id;
    this.draft = null;
  }

  @action
  updateShowTitle(value: string): void {
    this.mutate((show) => {
      show.title = value;
    });
  }

  @action
  createCueDraft(kind: CueKind = '灯光'): void {
    if (this.activeScene?.locked) {
      this.notify('该场次已锁定，请先建立修订');
      return;
    }
    this.draft = {
      kind,
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: '',
    };
  }

  @action
  cancelDraft(): void {
    this.draft = null;
  }

  @action
  editSelectedCue(): void {
    const item = this.selectedCue;
    if (!item || this.activeScene?.locked) return;
    this.draft = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      duration: item.duration,
      owner: item.owner,
      lighting: item.lighting,
      sound: item.sound,
      props: item.props.join('、'),
      cast: item.cast.join('、'),
      notes: item.notes,
      dependsOn: item.dependsOn.join('、'),
    };
  }

  @action
  updateDraft<K extends keyof CueDraft>(field: K, value: CueDraft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [field]: value };
  }

  @action
  saveDraft(): void {
    if (!this.draft || !this.draft.title.trim() || !this.activeScene) return;
    const draft = this.draft;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      const saved: Cue = {
        id: draft.id ?? uid('cue'),
        kind: draft.kind,
        title: draft.title.trim(),
        duration: Math.max(1, Number(draft.duration) || 1),
        owner: draft.owner,
        lighting: draft.lighting,
        sound: draft.sound,
        props: draft.props
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        cast: draft.cast
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        notes: draft.notes,
        dependsOn: draft.dependsOn
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        offset: 0,
      };
      const index = scene.cues.findIndex((item) => item.id === saved.id);
      if (index >= 0) scene.cues.splice(index, 1, saved);
      else scene.cues.push(saved);
      recalculateScene(scene);
      this.selectedCueId = saved.id;
    });
    this.draft = null;
  }

  @action
  removeCue(id: string): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      scene.cues = scene.cues.filter((item) => item.id !== id);
      recalculateScene(scene);
    });
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  @action
  addScene(): void {
    const scene: Scene = {
      id: uid('scene'),
      act: `第${this.show.scenes.length + 1}幕`,
      name: `S${this.show.scenes.length + 1}`,
      title: '未命名场次',
      startTime: '20:00',
      locked: false,
      cues: [],
    };
    this.mutate((show) => show.scenes.push(scene));
    this.activeSceneId = scene.id;
    this.selectedCueId = '';
  }

  @action
  copyPreviousScene(): void {
    const index = this.show.scenes.findIndex(
      (scene) => scene.id === this.activeSceneId,
    );
    const previous = this.show.scenes[index - 1];
    if (!previous) {
      this.notify('当前已是第一场');
      return;
    }
    const copied: Scene = clone(previous);
    copied.id = uid('scene');
    copied.act = this.activeScene?.act ?? copied.act;
    copied.name = `${copied.name}-副本`;
    copied.title = `${copied.title}（复制）`;
    copied.cues = copied.cues.map((item) => ({
      ...item,
      id: uid('cue'),
      dependsOn: [],
    }));
    recalculateScene(copied);
    this.mutate((show) => show.scenes.splice(index + 1, 0, copied));
    this.activeSceneId = copied.id;
    this.selectedCueId = copied.cues[0]?.id ?? '';
    this.notify('已复制上一场流程');
  }

  @action
  updateSceneField(
    field: 'title' | 'startTime' | 'act' | 'name',
    value: string,
  ): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  updateSelectedField(field: keyof Cue, value: unknown): void {
    const id = this.selectedCueId;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      const item = scene?.cues.find((entry) => entry.id === id);
      if (!scene || !item || scene.locked) return;
      if (field === 'duration') item.duration = Math.max(1, Number(value) || 1);
      else if (field === 'props' || field === 'cast')
        item[field] = String(value)
          .split(/[、,，]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      else Object.assign(item, { [field]: value });
      recalculateScene(scene);
    });
  }

  @action
  moveSelected(direction: -1 | 1): void {
    const cues = this.activeScene?.cues ?? [];
    const from = cues.findIndex((item) => item.id === this.selectedCueId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= cues.length) return;
    this.moveCue(cues[from]!.id, cues[to]!.id);
  }

  @action
  startDrag(id: string): void {
    this.dragCueId = id;
  }

  @action
  allowDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropOn(id: string): void {
    if (this.dragCueId) this.moveCue(this.dragCueId, id);
    this.dragCueId = '';
  }

  @action
  moveCue(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      const from = scene.cues.findIndex((item) => item.id === sourceId);
      const to = scene.cues.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = scene.cues.splice(from, 1);
      scene.cues.splice(to, 0, moved!);
      recalculateScene(scene);
    });
    this.selectedCueId = sourceId;
    this.notify('顺序已更新，后续提示时间自动顺延');
  }

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      data: clone(this.show),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persist();
    this.notify('已锁定当前版本');
  }

  @action
  createRevision(): void {
    this.mutate((show) =>
      show.scenes.forEach((scene) => {
        scene.locked = false;
      }),
    );
    this.notify('已从当前锁定版建立可编辑修订');
  }

  @action
  toggleSceneLock(): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.locked = !scene.locked;
    });
  }

  @action
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.show));
    this.show = previous;
    this.ensureSelection();
    this.sync = { ...this.sync, deviations: collectDeviations(this.show) };
    this.persist();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.show));
    this.show = next;
    this.ensureSelection();
    this.sync = { ...this.sync, deviations: collectDeviations(this.show) };
    this.persist();
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  @action
  selectCompareVersion(version: VersionSnapshot): void {
    this.compareVersionId = version.id;
  }

  // ===== 断网回传：现场执行记录合并 =====

  get pendingRows() {
    return this.sync.pending.map((item, index) => ({
      ...item,
      rowIndex: index,
      kindLabel:
        item.kind === 'time-conflict'
          ? '双方执行时间不一致'
          : item.kind === 'cue-moved'
            ? '提示已换场'
            : '提示已撤下',
    }));
  }

  get deviationRows() {
    return this.sync.deviations.map((item) => ({
      ...item,
      deltaLabel: formatDelta(item.deltaSeconds),
      late: item.deltaSeconds > 0,
      onTime: item.deltaSeconds === 0,
    }));
  }

  get failedImport() {
    return this.sync.failedImport;
  }

  /** 构造一份断网回传示例包：含双方都改时间、撤下、换场与正常落位四种情形 */
  @action
  loadSamplePackage(): void {
    const scenes = this.show.scenes;
    const scene1 = scenes[0]!;
    const scene2 = scenes[1]!;
    const movedCue = scene2.cues.find((item) => item.id === 'cue-stage-2');
    const normalCue =
      scene1.cues.find((item) => item.id === 'cue-prop-1') ?? scene1.cues[1];
    const records: ExecutionRecord[] = [
      {
        recordId: 'rec-conflict-1',
        cueId: 'cue-light-1',
        sceneId: scene1.id,
        cueTitle: '观众席渐暗 · 面光起',
        executedAt: '19:30:22',
        executedBy: '灯光台 · 林晓',
        device: '巡演灯控台 A7（断网缓存）',
        note: '开场铃延后，现场以追光口令为准',
      },
      ...(normalCue
        ? [
            {
              recordId: 'rec-ok-1',
              cueId: normalCue.id,
              sceneId: scene1.id,
              cueTitle: normalCue.title,
              executedAt: this.plannedLabel(scene1, normalCue),
              executedBy: '道具台 · 吴桐',
              device: '巡演道具台 P3（断网缓存）',
            },
          ]
        : []),
      ...(movedCue
        ? [
            {
              recordId: 'rec-moved-1',
              cueId: movedCue.id,
              sceneId: scene1.id,
              cueTitle: movedCue.title,
              executedAt: '19:42:10',
              executedBy: '舞台监督 · 何舟',
              device: '巡演监督终端 M2（断网缓存）',
              note: '回传归属仍写旧场次 S1',
            },
          ]
        : []),
      {
        recordId: 'rec-gone-1',
        cueId: 'cue-curtain-old',
        sceneId: scene2.id,
        cueTitle: '旧版落幕黑场',
        executedAt: '21:05:40',
        executedBy: '舞台监督 · 何舟',
        device: '巡演监督终端 M2（断网缓存）',
      },
    ];
    const pkg: ExecutionPackage = {
      packageId: `pkg-tour-${Date.now().toString(36)}`,
      exportedAt: new Date().toISOString(),
      venue: '巡演场地 · 断网回传',
      records,
      checksum: recordsChecksum(records),
    };
    this.importRawText(JSON.stringify(pkg, null, 2));
  }

  /** 构造一份校验和被破坏的包，用于演示校验失败恢复 */
  @action
  loadBrokenPackage(): void {
    const scene1 = this.show.scenes[0]!;
    const records: ExecutionRecord[] = [
      {
        recordId: 'rec-broken-1',
        cueId: scene1.cues[0]!.id,
        sceneId: scene1.id,
        cueTitle: scene1.cues[0]!.title,
        executedAt: '19:31:00',
        executedBy: '灯控台',
        device: '故障导出通道',
      },
    ];
    const raw = JSON.stringify(
      {
        packageId: 'pkg-broken-demo',
        exportedAt: new Date().toISOString(),
        venue: '巡演场地 · 断网回传',
        records,
        checksum: 'deadbeef',
      },
      null,
      2,
    );
    this.importRawText(raw);
  }

  @action
  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.importRawText(String(reader.result ?? ''));
      input.value = '';
    };
    reader.readAsText(file);
  }

  @action
  updateFailedDraft(value: string): void {
    this.failedDraft = value;
  }

  /** 校验失败后，记录单仍保留；修正内容后可直接重试 */
  @action
  retryFailedImport(): void {
    if (!this.failedDraft.trim()) return;
    this.importRawText(this.failedDraft);
  }

  @action
  dismissFailedImport(): void {
    this.sync = { ...this.sync, failedImport: null };
    this.importError = '';
    this.failedDraft = '';
    this.persist();
  }

  @action
  resolveTimeConflict(index: number, choice: 'local' | 'remote'): void {
    const item = this.sync.pending[index];
    if (!item || item.kind !== 'time-conflict') return;
    this.mutate((show) => {
      if (choice !== 'remote') return;
      const scene = show.scenes.find(
        (entry) => entry.id === item.record.sceneId,
      );
      const cue = scene?.cues.find((entry) => entry.id === item.record.cueId);
      if (cue) {
        cue.actualTime = item.record.executedAt;
        cue.actualSource = item.record.device;
      }
    });
    this.dropPending(index);
    this.notify(
      choice === 'remote'
        ? '已采用回传执行时间，计划时间保持不变'
        : '已保留本机执行时间，计划时间保持不变',
    );
  }

  @action
  relocatePendingRecord(index: number): void {
    const item = this.sync.pending[index];
    if (!item || item.kind !== 'cue-moved' || !item.foundInSceneId) return;
    this.mutate((show) => {
      const scene = show.scenes.find(
        (entry) => entry.id === item.foundInSceneId,
      );
      const cue = scene?.cues.find((entry) => entry.id === item.record.cueId);
      if (cue) {
        cue.actualTime = item.record.executedAt;
        cue.actualSource = item.record.device;
      }
    });
    this.dropPending(index);
    this.notify('已按提示编号挂到当前所在场次，来源随记录保留');
  }

  /** 人工核对完成后留档移出待核；撤下记录不会挂到任何同名提示上 */
  @action
  archivePending(index: number): void {
    this.dropPending(index);
    this.notify('该记录已核对留档，未改动提示表');
  }

  private plannedLabel(scene: Scene, cue: Cue): string {
    const base = /^(\d{1,2}):(\d{2})/.exec(scene.startTime);
    const hour = Number(base?.[1] ?? 0);
    const minute = Number(base?.[2] ?? 0);
    const total = hour * 3600 + minute * 60 + cue.offset;
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
  }

  private importRawText(rawText: string): void {
    const text = rawText.trim();
    if (!text) {
      this.importError = '导入内容为空';
      return;
    }
    // 合并前留存原提示表；校验或后续处理任一失败都从这份恢复
    const backup = clone(this.show);
    const { pkg, errors } = parsePackage(text);
    if (!pkg) {
      this.show = backup;
      this.importError = errors.join('；');
      this.failedDraft = text;
      this.sync = {
        ...this.sync,
        failedImport: {
          packageId: this.readPackageId(text),
          rawText: text,
          errors,
          failedAt: new Date().toISOString(),
        },
      };
      this.persist();
      this.notify('导入包校验失败，已从原提示表恢复；记录单保留可重试');
      return;
    }

    try {
      const result = mergePackage(backup, pkg);
      this.undoStack.push(backup);
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
      this.show = result.show;
      this.ensureSelection();
      const incomingKeys = new Set(
        result.pending.map((item) => item.record.recordId),
      );
      const kept = this.sync.pending.filter(
        (item) => !incomingKeys.has(item.record.recordId),
      );
      this.sync = {
        pending: [...kept, ...result.pending],
        deviations: collectDeviations(result.show),
        lastImportAt: new Date().toISOString(),
        failedImport: null,
      };
      this.importError = '';
      this.failedDraft = '';
      this.persist();
      this.notify(
        `合并完成：${pkg.records.length} 条回传记录，${result.pending.length} 条进入待确认，已列出计划与实际偏差`,
      );
    } catch (error) {
      this.show = backup;
      this.persist();
      this.importError = `合并中断：${(error as Error).message}`;
      this.notify('合并中断，已从原提示表恢复，可修正记录单后重试');
    }
  }

  private readPackageId(text: string): string {
    try {
      return (
        (JSON.parse(text) as { packageId?: string }).packageId ?? '未知编号'
      );
    } catch {
      return '无法解析的文件';
    }
  }

  private dropPending(index: number): void {
    const pending = this.sync.pending.filter((_, current) => current !== index);
    this.sync = { ...this.sync, pending };
    this.persist();
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  private mutate(mutator: (show: ShowData) => void): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
    this.sync = { ...this.sync, deviations: collectDeviations(this.show) };
    this.persist();
  }

  private ensureSelection(): void {
    if (!this.show.scenes.some((scene) => scene.id === this.activeSceneId))
      this.activeSceneId = this.show.scenes[0]?.id ?? '';
    if (!this.activeScene?.cues.some((item) => item.id === this.selectedCueId))
      this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  private persist(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        show: this.show,
        versions: this.versions,
        sync: this.sync,
      }),
    );
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2200);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const inEditor =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.tagName === 'SELECT';
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (inEditor) return;
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelected(-1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelected(1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.createCueDraft();
    }
  };
}
