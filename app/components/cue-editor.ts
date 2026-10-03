import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  PendingActual,
  Scene,
  ShowData,
  TimingDeviation,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';
import {
  collectDeviations,
  mergeExecutionPackage,
  plannedStartTime,
  resolvePending,
  validateExecutionPackage,
} from 'stage-cue-editor/utils/execution-merge';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

interface StoredState {
  show: ShowData;
  versions: VersionSnapshot[];
  pendingActuals?: PendingActual[];
}

function loadShow(): ShowData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialShow();
    const parsed = JSON.parse(raw) as StoredState;
    return parsed.show ?? initialShow();
  } catch {
    return initialShow();
  }
}

function loadVersions(): VersionSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as StoredState).versions ?? [];
  } catch {
    return [];
  }
}

function loadPendingActuals(): PendingActual[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as StoredState).pendingActuals ?? [];
  } catch {
    return [];
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

function formatDelta(deltaSeconds: number): string {
  if (deltaSeconds === 0) return '准时';
  const sign = deltaSeconds > 0 ? '延误' : '提前';
  const absolute = Math.abs(deltaSeconds);
  const minutes = Math.floor(absolute / 60);
  const seconds = absolute % 60;
  if (minutes && seconds) return `${sign} ${minutes} 分 ${seconds} 秒`;
  return minutes ? `${sign} ${minutes} 分` : `${sign} ${seconds} 秒`;
}

export default class CueEditorComponent extends Component {
  @tracked show: ShowData = loadShow();
  @tracked versions: VersionSnapshot[] = loadVersions();
  @tracked pendingActuals: PendingActual[] = loadPendingActuals();
  @tracked activeSceneId = this.show.scenes[0]?.id ?? '';
  @tracked selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';
  @tracked importText = '';
  @tracked importErrors: string[] = [];
  @tracked lastOutcomeSummary = '';

  private undoStack: Array<{
    show: ShowData;
    pendingActuals: PendingActual[];
  }> = [];
  private redoStack: Array<{
    show: ShowData;
    pendingActuals: PendingActual[];
  }> = [];
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
    return this.activeScene.cues.map((item, index) => {
      const plannedStart = timeLabel(this.activeScene as Scene, item.offset);
      const deviation = this.deviations.find(
        (entry) =>
          entry.cueId === item.id &&
          entry.sceneId === (this.activeScene as Scene).id,
      );
      return {
        ...item,
        index,
        start: plannedStart,
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
        hasActual: Boolean(item.actual),
        actualTime: item.actual?.time ?? '',
        actualSource: item.actual?.source ?? '',
        deltaLabel: deviation ? formatDelta(deviation.deltaSeconds) : '',
        deltaClass: deviation
          ? deviation.deltaSeconds === 0
            ? 'on-time'
            : deviation.deltaSeconds > 0
              ? 'late'
              : 'early'
          : '',
      };
    });
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

  get deviations(): TimingDeviation[] {
    return collectDeviations(this.show);
  }

  get deviationRows() {
    return this.deviations.map((entry) => ({
      ...entry,
      deltaLabel: formatDelta(entry.deltaSeconds),
      deltaClass:
        entry.deltaSeconds === 0
          ? 'on-time'
          : entry.deltaSeconds > 0
            ? 'late'
            : 'early',
    }));
  }

  get pendingRows() {
    return this.pendingActuals.map((item) => {
      const stillInScene = this.show.scenes.some(
        (scene) =>
          scene.id === item.sceneId &&
          scene.cues.some((cue) => cue.id === item.cueId),
      );
      return {
        ...item,
        reasonLabel:
          item.reason === 'conflict'
            ? '双方执行时间不一致'
            : item.reason === 'scene-moved'
              ? '提示已换场'
              : '提示已撤下',
        canAttach: stillInScene,
      };
    });
  }

  get selectedCuePlannedStart(): string {
    return this.activeScene && this.selectedCue
      ? plannedStartTime(this.activeScene, this.selectedCue.offset)
      : '';
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
    this.redoStack.push({
      show: clone(this.show),
      pendingActuals: clone(this.pendingActuals),
    });
    this.show = previous.show;
    this.pendingActuals = previous.pendingActuals;
    this.ensureSelection();
    this.persist();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({
      show: clone(this.show),
      pendingActuals: clone(this.pendingActuals),
    });
    this.show = next.show;
    this.pendingActuals = next.pendingActuals;
    this.ensureSelection();
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

  @action
  updateImportText(value: string): void {
    this.importText = value;
    if (this.importErrors.length) this.importErrors = [];
  }

  @action
  onImportInput(event: Event): void {
    this.updateImportText((event.target as HTMLTextAreaElement).value);
  }

  @action
  selectDeviation(sceneId: string, cueId: string): void {
    this.selectScene(sceneId);
    this.selectedCueId = cueId;
  }

  @action
  importExecutionPackage(): void {
    const rawText = this.importText.trim();
    if (!rawText) {
      this.importErrors = ['请先粘贴断网回传的现场执行记录（JSON）'];
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // 校验失败：不改提示表，记录单原样保留供重试。
      this.importErrors = ['JSON 解析失败，请检查记录单内容后重试'];
      return;
    }
    const validation = validateExecutionPackage(parsed);
    if (!validation.ok || !validation.pkg) {
      this.importErrors = validation.errors.length
        ? validation.errors
        : ['导入包校验失败'];
      return;
    }

    const previous = clone(this.show);
    const { show: mergedShow, outcome } = mergeExecutionPackage(
      this.show,
      validation.pkg,
    );
    const previousPending = clone(this.pendingActuals);
    this.undoStack.push({ show: previous, pendingActuals: previousPending });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.show = mergedShow;

    const incomingPending = new Set(outcome.pending.map((item) => item.id));
    this.pendingActuals = [
      ...this.pendingActuals.filter((item) => !incomingPending.has(item.id)),
      ...outcome.pending,
    ];
    this.importErrors = [];
    this.persist();
    this.ensureSelection();

    const late = outcome.deviations.filter(
      (item) => item.deltaSeconds > 0,
    ).length;
    const early = outcome.deviations.filter(
      (item) => item.deltaSeconds < 0,
    ).length;
    const onTime = outcome.deviations.filter(
      (item) => item.deltaSeconds === 0,
    ).length;
    this.lastOutcomeSummary = `已对位 ${outcome.merged.length} 条，待核 ${outcome.pending.length} 条；偏差：准时 ${onTime} 条、提前 ${early} 条、延误 ${late} 条（计划时间未改动）`;
    this.notify('现场执行记录合并完成');
  }

  @action
  loadSamplePackage(): void {
    const scenes = this.show.scenes;
    const first = scenes[0];
    const second = scenes[1];
    const records = [];
    if (first?.cues[0])
      records.push({
        cueId: first.cues[0].id,
        sceneId: first.id,
        executedAt: '19:31:20',
        source: '左台口断网终端',
        recordedAt: '2026-10-03T19:31:30+08:00',
      });
    if (first?.cues[2])
      records.push({
        cueId: first.cues[2].id,
        sceneId: first.id,
        executedAt: '19:34:05',
        source: '左台口断网终端',
        recordedAt: '2026-10-03T19:34:10+08:00',
      });
    if (second?.cues[1])
      records.push({
        cueId: second.cues[1].id,
        sceneId: second.id,
        executedAt: '19:42:00',
        source: '右台口断网终端',
        recordedAt: '2026-10-03T19:42:20+08:00',
      });
    // 以下两条对位不上：一条提示已撤下，一条编号属于别的场次（如已换场）。
    records.push({
      cueId: 'cue-retired-x',
      sceneId: first?.id ?? 'scene-1',
      executedAt: '19:39:10',
      source: '左台口断网终端',
      recordedAt: '2026-10-03T19:39:15+08:00',
    });
    if (first && second?.cues[0])
      records.push({
        cueId: second.cues[0].id,
        sceneId: first.id,
        executedAt: '19:45:40',
        source: '右台口断网终端',
        recordedAt: '2026-10-03T19:45:45+08:00',
      });
    this.importText = JSON.stringify(
      {
        packageId: `pkg-demo-${Date.now().toString(36)}`,
        exportedAt: '2026-10-03T20:05:00+08:00',
        source: '巡演现场断网终端',
        records,
      },
      null,
      2,
    );
    this.importErrors = [];
  }

  @action
  loadConflictSample(): void {
    const first = this.show.scenes[0];
    const target = first?.cues[0];
    if (!first || !target) {
      this.importErrors = ['当前没有可演示冲突的提示'];
      return;
    }
    const planned = plannedStartTime(first, target.offset);
    this.importText = JSON.stringify(
      {
        packageId: `pkg-conflict-${Date.now().toString(36)}`,
        exportedAt: '2026-10-03T20:10:00+08:00',
        source: '后台断网终端',
        records: [
          {
            cueId: target.id,
            sceneId: first.id,
            executedAt: planned,
            source: '后台断网终端',
            recordedAt: '2026-10-03T19:31:00+08:00',
          },
        ],
      },
      null,
      2,
    );
    this.importErrors = [];
    this.notify('示例已填入：先导入一次，再次点击导入即可制造双方时间不一致');
  }

  @action
  acceptPendingActual(id: string): void {
    this.resolvePendingItem(id, true);
  }

  @action
  keepLocalPendingActual(id: string): void {
    this.resolvePendingItem(id, false);
  }

  @action
  discardPendingActual(id: string): void {
    this.pendingActuals = this.pendingActuals.filter((item) => item.id !== id);
    this.persist();
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  private resolvePendingItem(id: string, acceptIncoming: boolean): void {
    const item = this.pendingActuals.find((entry) => entry.id === id);
    if (!item) return;
    if (
      item.reason !== 'conflict' &&
      !this.show.scenes.some(
        (scene) =>
          scene.id === item.sceneId &&
          scene.cues.some((cue) => cue.id === item.cueId),
      )
    ) {
      this.notify('该提示仍不在原场次，无法挂回');
      return;
    }
    const previous = clone(this.show);
    const { show } = resolvePending(this.show, item, acceptIncoming);
    this.undoStack.push({
      show: previous,
      pendingActuals: clone(this.pendingActuals),
    });
    this.redoStack = [];
    this.show = show;
    this.pendingActuals = this.pendingActuals.filter(
      (entry) => entry.id !== id,
    );
    this.persist();
    this.notify(acceptIncoming ? '已采用现场回传时间' : '已保留本机执行时间');
  }

  private mutate(mutator: (show: ShowData) => void): void {
    this.undoStack.push({
      show: clone(this.show),
      pendingActuals: clone(this.pendingActuals),
    });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
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
        pendingActuals: this.pendingActuals,
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
