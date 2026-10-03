import { render, click } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';
import { setupRenderingTest } from 'ember-qunit';
import { module, test } from 'qunit';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';

function clickButtonByText(scope: string, text: string): Promise<void> {
  document
    .querySelectorAll('[data-test-hit]')
    .forEach((node) => node.removeAttribute('data-test-hit'));
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`${scope} button`),
  );
  const found = buttons.find((button) =>
    (button.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`未找到按钮：${text}`);
  found.setAttribute('data-test-hit', 'true');
  return click(`${scope} [data-test-hit]`);
}

module('Integration | Component | cue-editor', function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    localStorage.removeItem(STORAGE_KEY);
  });

  test('渲染提示表与断网回传面板', async function (assert) {
    await render(hbs`<CueEditor />`);
    assert.dom('.sync-panel').exists({ count: 1 });
    assert.dom('.cue-row').exists({ count: 4 });
    assert
      .dom('.deviation-block .deviation-row')
      .exists({ count: 1 }, '示例数据自带一条实际执行记录的偏差');
  });

  test('示例包合并：双方改时间、换场与撤下记录进入待核，计划时间不改', async function (assert) {
    await render(hbs`<CueEditor />`);
    await clickButtonByText('.sync-actions', '载入断网示例包');
    assert.dom('.pending-item').exists({ count: 3 });
    assert.dom('.pending-item.kind-time-conflict').exists({ count: 1 });
    assert.dom('.pending-item.kind-cue-moved').exists({ count: 1 });
    assert.dom('.pending-item.kind-cue-withdrawn').exists({ count: 1 });
    assert
      .dom('.deviation-block .deviation-row')
      .exists({ count: 2 }, '冲突项保留本机值，另加一条正常落位');

    await clickButtonByText('.pending-item.kind-time-conflict', '采用回传');
    assert.dom('.pending-item.kind-time-conflict').doesNotExist();
    assert
      .dom('.cue-row .actual-chip')
      .hasText(/19:30:22/, '确认后回传时间落位');
  });

  test('校验失败示例：原提示表保留，记录单留存可重试', async function (assert) {
    await render(hbs`<CueEditor />`);
    await clickButtonByText('.sync-actions', '载入校验失败示例');
    assert.dom('.sync-failed').exists({ count: 1 });
    assert.dom('.cue-row').exists({ count: 4 }, '校验失败后原提示表完整');
    assert.dom('.sync-failed textarea').exists();
  });
});
