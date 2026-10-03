import { module, test } from 'qunit';
import type { ExecutionPackage, ShowData } from 'stage-cue-editor/models/show';
import {
  collectDeviations,
  mergeExecutionPackage,
  validateExecutionPackage,
} from 'stage-cue-editor/utils/execution-merge';

function makeShow(): ShowData {
  return {
    title: '测试演出',
    venue: '测试剧场',
    date: '2026-10-03',
    updatedAt: '',
    scenes: [
      {
        id: 'scene-1',
        act: '第一幕',
        name: 'S1',
        title: '序场',
        startTime: '19:30',
        locked: false,
        cues: [
          {
            id: 'cue-1',
            kind: '灯光',
            title: '面光起',
            duration: 60,
            owner: '李岚',
            lighting: '',
            sound: '',
            props: [],
            cast: [],
            notes: '',
            dependsOn: [],
            offset: 0,
          },
          {
            id: 'cue-2',
            kind: '音响',
            title: '音乐淡入',
            duration: 120,
            owner: '陈默',
            lighting: '',
            sound: '',
            props: [],
            cast: [],
            notes: '',
            dependsOn: [],
            offset: 60,
          },
        ],
      },
      {
        id: 'scene-2',
        act: '第一幕',
        name: 'S2',
        title: '次场',
        startTime: '19:40',
        locked: false,
        cues: [
          {
            id: 'cue-3',
            kind: '舞台',
            title: '换景',
            duration: 90,
            owner: '孙禾',
            lighting: '',
            sound: '',
            props: [],
            cast: [],
            notes: '',
            dependsOn: [],
            offset: 0,
          },
        ],
      },
    ],
  };
}

function pkg(
  records: ExecutionPackage['records'],
  extra: Partial<ExecutionPackage> = {},
): ExecutionPackage {
  return {
    packageId: 'pkg-1',
    exportedAt: '2026-10-03T20:00:00+08:00',
    source: '断网终端 A',
    records,
    ...extra,
  };
}

module('Unit | Utility | execution-merge | 校验', function () {
  test('缺少 packageId 或 records 校验失败', function (assert) {
    assert.false(validateExecutionPackage({}).ok);
    assert.false(validateExecutionPackage({ packageId: 'p1' }).ok);
  });

  test('记录缺编号、场次或执行时间格式错误时校验失败', function (assert) {
    const result = validateExecutionPackage({
      packageId: 'p1',
      records: [
        { cueId: '', sceneId: 'scene-1', executedAt: '19:31' },
        { cueId: 'cue-1', sceneId: 'scene-1', executedAt: '七点半' },
      ],
    });
    assert.false(result.ok);
    assert.strictEqual(result.pkg, null, '失败时拿不到任何包数据');
    assert.ok(result.errors.length >= 2);
  });

  test('合法包通过校验并补默认来源', function (assert) {
    const result = validateExecutionPackage({
      packageId: 'p1',
      records: [{ cueId: 'cue-1', sceneId: 'scene-1', executedAt: '19:31' }],
    });
    assert.true(result.ok);
    assert.strictEqual(result.pkg?.records[0]?.executedAt, '19:31:00');
    assert.strictEqual(result.pkg?.source, '未知现场终端');
  });
});

module('Unit | Utility | execution-merge | 对位', function () {
  test('按编号与场次归属对位，标题与顺序不影响', function (assert) {
    const show = makeShow();
    show.scenes[0]!.cues[0]!.title = '标题已被本机修改';
    show.scenes[0]!.cues.reverse();
    const { show: next, outcome } = mergeExecutionPackage(
      show,
      pkg([{ cueId: 'cue-1', sceneId: 'scene-1', executedAt: '19:32:10' }]),
    );
    const cue = next.scenes[0]!.cues.find((item) => item.id === 'cue-1');
    assert.strictEqual(cue?.actual?.time, '19:32:10');
    assert.strictEqual(cue?.actual?.source, '断网终端 A');
    assert.strictEqual(outcome.merged.length, 1);
    assert.strictEqual(outcome.pending.length, 0);
  });

  test('提示被撤下时记录留待核，不挂到同名提示', function (assert) {
    const show = makeShow();
    show.scenes[0]!.cues = show.scenes[0]!.cues.filter(
      (item) => item.id !== 'cue-2',
    );
    // 另一场存在标题完全相同的提示，也不得被挂上。
    show.scenes[1]!.cues.push({
      id: 'cue-9',
      kind: '音响',
      title: '音乐淡入',
      duration: 30,
      owner: '陈默',
      lighting: '',
      sound: '',
      props: [],
      cast: [],
      notes: '',
      dependsOn: [],
      offset: 90,
    });
    const { show: next, outcome } = mergeExecutionPackage(
      show,
      pkg([
        {
          cueId: 'cue-2',
          sceneId: 'scene-1',
          executedAt: '19:33:00',
          source: '断网终端 B',
        },
      ]),
    );
    assert.strictEqual(outcome.pending.length, 1);
    assert.strictEqual(outcome.pending[0]?.reason, 'cue-removed');
    assert.notOk(
      next.scenes[1]!.cues.find((item) => item.id === 'cue-9')?.actual,
      '同名提示不被挂接',
    );
  });

  test('提示换到别的场次时记录标记 scene-moved，不自动挂到新场次', function (assert) {
    const show = makeShow();
    const moved = show.scenes[0]!.cues.splice(1, 1)[0]!;
    show.scenes[1]!.cues.push(moved);
    const { outcome } = mergeExecutionPackage(
      show,
      pkg([{ cueId: 'cue-2', sceneId: 'scene-1', executedAt: '19:33:00' }]),
    );
    assert.strictEqual(outcome.pending[0]?.reason, 'scene-moved');
    assert.notOk(
      show.scenes[1]!.cues.find((item) => item.id === 'cue-2')?.actual,
    );
  });

  test('双方执行时间不一致时两份都留待确认且计划时间不改', function (assert) {
    const show = makeShow();
    show.scenes[0]!.cues[0]!.actual = {
      time: '19:31:00',
      source: '本机',
      recordedAt: 't1',
    };
    const { show: next, outcome } = mergeExecutionPackage(
      show,
      pkg([{ cueId: 'cue-1', sceneId: 'scene-1', executedAt: '19:35:00' }]),
    );
    assert.strictEqual(outcome.pending.length, 1);
    assert.strictEqual(outcome.pending[0]?.reason, 'conflict');
    assert.strictEqual(outcome.pending[0]?.localTime, '19:31:00');
    assert.strictEqual(outcome.pending[0]?.incomingTime, '19:35:00');
    assert.strictEqual(
      next.scenes[0]!.cues[0]!.actual?.time,
      '19:31:00',
      '现有执行时间不动',
    );
    assert.strictEqual(next.scenes[0]!.startTime, '19:30', '计划开场时间不动');
    assert.strictEqual(next.scenes[0]!.cues[0]!.offset, 0, '计划 offset 不动');
  });

  test('相同执行时间重复回传不产生待核、不覆盖来源', function (assert) {
    const show = makeShow();
    show.scenes[0]!.cues[0]!.actual = {
      time: '19:32:00',
      source: '断网终端 A',
      recordedAt: 't1',
    };
    const { outcome } = mergeExecutionPackage(
      show,
      pkg([
        {
          cueId: 'cue-1',
          sceneId: 'scene-1',
          executedAt: '19:32:00',
          source: '断网终端 C',
        },
      ]),
    );
    assert.strictEqual(outcome.pending.length, 0);
    assert.strictEqual(outcome.merged.length, 0);
    assert.strictEqual(show.scenes[0]!.cues[0]!.actual?.source, '断网终端 A');
  });
});

module('Unit | Utility | execution-merge | 偏差与来源', function () {
  test('合并后列出计划与实际偏差，现场记录保留来源', function (assert) {
    const show = makeShow();
    const { show: next } = mergeExecutionPackage(
      show,
      pkg([
        {
          cueId: 'cue-1',
          sceneId: 'scene-1',
          executedAt: '19:30:00',
          source: '终端 X',
        },
        {
          cueId: 'cue-2',
          sceneId: 'scene-1',
          executedAt: '19:32:30',
          source: '终端 Y',
        },
      ]),
    );
    const deviations = collectDeviations(next);
    assert.strictEqual(deviations.length, 2);
    const cue2 = deviations.find((entry) => entry.cueId === 'cue-2');
    assert.strictEqual(cue2?.plannedStart, '19:31:00');
    assert.strictEqual(cue2?.actualStart, '19:32:30');
    assert.strictEqual(cue2?.deltaSeconds, 90);
    assert.strictEqual(cue2?.source, '终端 Y');
    assert.strictEqual(deviations[0]?.deltaSeconds, 0);
  });

  test('合并不修改原始 show 对象，失败回传的表可直接重试', function (assert) {
    const show = makeShow();
    mergeExecutionPackage(
      show,
      pkg([{ cueId: 'cue-1', sceneId: 'scene-1', executedAt: '20:01:00' }]),
    );
    assert.notOk(
      show.scenes[0]!.cues[0]!.actual,
      '原对象保持不变，导入失败时调用方继续用它',
    );
  });
});
