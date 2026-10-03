import { module, test } from 'qunit';
import type {
  ExecutionPackage,
  ExecutionRecord,
  ShowData,
} from 'stage-cue-editor/models/show';
import {
  collectDeviations,
  formatDelta,
  mergePackage,
  parsePackage,
  recordsChecksum,
  timeToSeconds,
} from 'stage-cue-editor/utils/execution-merge';

function record(partial: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    recordId: 'rec-1',
    cueId: 'cue-a',
    sceneId: 'scene-1',
    cueTitle: '面光起',
    executedAt: '19:30:10',
    executedBy: '灯控台',
    device: '巡演灯控台 A7',
    ...partial,
  };
}

function pkg(
  records: ExecutionRecord[],
  extra: Partial<ExecutionPackage> = {},
): ExecutionPackage {
  return {
    packageId: 'pkg-1',
    exportedAt: '2026-10-03T20:00:00.000Z',
    venue: '巡演剧场',
    records,
    checksum: recordsChecksum(records),
    ...extra,
  };
}

function show(): ShowData {
  return {
    title: '测试演出',
    venue: 'A 厅',
    date: '2026-10-18',
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
            id: 'cue-a',
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
            id: 'cue-b',
            kind: '音响',
            title: '音乐起',
            duration: 60,
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
        title: '正场',
        startTime: '19:40',
        locked: false,
        cues: [
          {
            id: 'cue-c',
            kind: '舞台',
            title: '换景',
            duration: 30,
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

module('Unit | execution-merge | parsePackage', function () {
  test('合法包通过校验', function (assert) {
    const result = parsePackage(JSON.stringify(pkg([record()])));
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.pkg);
  });

  test('不是 JSON 时整包拒绝', function (assert) {
    const result = parsePackage('not-json');
    assert.notOk(result.pkg);
    assert.ok(result.errors[0]?.includes('JSON'));
  });

  test('校验和不匹配时整包拒绝', function (assert) {
    const raw = JSON.stringify(pkg([record()], { checksum: '00000000' }));
    const result = parsePackage(raw);
    assert.notOk(result.pkg);
    assert.ok(result.errors.some((error) => error.includes('校验和')));
  });

  test('执行时间格式非法时拒绝', function (assert) {
    const result = parsePackage(
      JSON.stringify(pkg([record({ executedAt: '七点半' })])),
    );
    assert.notOk(result.pkg);
    assert.ok(result.errors.some((error) => error.includes('执行时间')));
  });

  test('缺少场次归属或提示编号时拒绝', function (assert) {
    const result = parsePackage(
      JSON.stringify(pkg([record({ cueId: '', sceneId: '' })])),
    );
    assert.strictEqual(result.errors.length, 2);
  });

  test('同场次同一提示编号出现两条记录时拒绝', function (assert) {
    const records = [
      record(),
      record({ recordId: 'rec-2', executedAt: '19:30:40' }),
    ];
    const result = parsePackage(JSON.stringify(pkg(records)));
    assert.ok(result.errors.some((error) => error.includes('多条记录')));
  });
});

module('Unit | execution-merge | mergePackage', function () {
  test('按提示编号与场次对位落位，记录带来源且计划时间不变', function (assert) {
    const base = show();
    const result = mergePackage(
      base,
      pkg([record({ executedAt: '19:30:20' })]),
    );
    const cue = result.show.scenes[0]!.cues[0]!;
    assert.strictEqual(cue.actualTime, '19:30:20');
    assert.strictEqual(cue.actualSource, '巡演灯控台 A7');
    assert.strictEqual(cue.offset, 0, '计划 offset 不被回传改写');
    assert.strictEqual(result.pending.length, 0);
  });

  test('标题相同但编号不同不构成对位（只认编号与场次）', function (assert) {
    const base = show();
    const result = mergePackage(
      base,
      pkg([record({ cueId: 'cue-other', cueTitle: '面光起' })]),
    );
    assert.strictEqual(result.pending[0]?.kind, 'cue-withdrawn');
    assert.notOk(result.show.scenes[0]!.cues[0]!.actualTime);
  });

  test('双方都改了执行时间：两份都留待确认，计划时间不改', function (assert) {
    const base = show();
    base.scenes[0]!.cues[0]!.actualTime = '19:30:05';
    base.scenes[0]!.cues[0]!.actualSource = '本机手记';
    const result = mergePackage(
      base,
      pkg([record({ executedAt: '19:30:22' })]),
    );
    const cue = result.show.scenes[0]!.cues[0]!;
    assert.strictEqual(result.pending.length, 1);
    assert.strictEqual(result.pending[0]?.kind, 'time-conflict');
    assert.strictEqual(result.pending[0]?.localActualTime, '19:30:05');
    assert.strictEqual(result.pending[0]?.record.executedAt, '19:30:22');
    assert.strictEqual(cue.actualTime, '19:30:05', '本机值未被覆盖');
    assert.strictEqual(cue.offset, 0, '计划时间不变');
  });

  test('同一执行时间重复回传不产生待确认', function (assert) {
    const base = show();
    base.scenes[0]!.cues[0]!.actualTime = '19:30:20';
    base.scenes[0]!.cues[0]!.actualSource = '巡演灯控台 A7';
    const result = mergePackage(
      base,
      pkg([record({ executedAt: '19:30:20' })]),
    );
    assert.strictEqual(result.pending.length, 0);
  });

  test('提示被撤下：记录留待核，不挂到同名提示', function (assert) {
    const base = show();
    const result = mergePackage(
      base,
      pkg([record({ cueId: 'cue-gone', cueTitle: '面光起' })]),
    );
    assert.strictEqual(result.pending[0]?.kind, 'cue-withdrawn');
    assert.notOk(
      result.show.scenes[0]!.cues[0]!.actualTime,
      '同名提示没有被误挂',
    );
  });

  test('提示换到别的场次：记录待核并标出当前场次，不自动挂载', function (assert) {
    const base = show();
    // cue-c 属于 scene-2，记录却归属 scene-1
    const result = mergePackage(
      base,
      pkg([record({ cueId: 'cue-c', sceneId: 'scene-1', cueTitle: '换景' })]),
    );
    assert.strictEqual(result.pending[0]?.kind, 'cue-moved');
    assert.strictEqual(result.pending[0]?.foundInSceneId, 'scene-2');
    assert.notOk(result.show.scenes[1]!.cues[0]!.actualTime);
  });

  test('合并不修改入参（校验失败可从原提示表恢复）', function (assert) {
    const base = show();
    const snapshot = JSON.stringify(base);
    mergePackage(base, pkg([record({ cueId: 'cue-gone' })]));
    assert.strictEqual(JSON.stringify(base), snapshot);
  });
});

module('Unit | execution-merge | deviations', function () {
  test('列出计划与实际偏差并保留来源', function (assert) {
    const base = show();
    const result = mergePackage(
      base,
      pkg([record({ executedAt: '19:31:30' })]),
    );
    const deviation = result.deviations[0]!;
    assert.strictEqual(deviation.plannedTime, '19:30:00');
    assert.strictEqual(deviation.actualTime, '19:31:30');
    assert.strictEqual(deviation.deltaSeconds, 90);
    assert.strictEqual(deviation.source, '巡演灯控台 A7');
    assert.strictEqual(collectDeviations(result.show)[0]!.cueId, 'cue-a');
  });

  test('formatDelta 输出早晚方向', function (assert) {
    assert.ok(formatDelta(90).startsWith('晚'));
    assert.ok(formatDelta(-30).startsWith('早'));
    assert.strictEqual(timeToSeconds('19:30'), 70200);
    assert.strictEqual(timeToSeconds('19:30:05'), 70205);
    assert.strictEqual(timeToSeconds('25:00'), null);
  });
});
