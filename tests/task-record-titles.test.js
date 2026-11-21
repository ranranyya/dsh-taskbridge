// 任务记录标题：显式短标题优先，未传标题时不得把角色说明、规则标题、任务 ID 或路径
// 当作主标题，也不得回显原提示；续接轮次不得替换任务链标题。
//
// 每个用例都来自一次可复现的输入：一次 delegate_submit 的 prompt（引擎在
// `JobEngine.start` 里用同一个 `taskTitle()` 生成标题并写入历史），或一条
// 已经持久化的记录（`src/jobs/task-tree.js` 用同一条链的轮次重建标题）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { taskTitle } from '../src/jobs/title.js';
import { buildTaskTree, groupContinuationChains } from '../src/jobs/task-tree.js';

/** One task view as the engine publishes it (`createdAt` epoch ms, no prompt). */
function task(over = {}) {
  return {
    taskId: 'task-round-0001',
    state: 'running',
    createdAt: Date.parse('2026-11-20T10:00:00+08:00'),
    sourcePath: 'E:/work/source',
    hostAcceptance: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 显式短标题：从提交到可见
// ---------------------------------------------------------------------------

test('an explicit short title is used verbatim, and never replaced by prompt text', () => {
  assert.equal(taskTitle('修复登录错误', '你是一名执行者。\n目标：改别的东西'), '修复登录错误');
  // A follow-up that names its own title keeps that title for ITS round; the chain
  // heading is decided separately below.
  assert.equal(taskTitle('补充 aria-live', '继续整改'), '补充 aria-live');
  // No title at all: the prompt's own goal line is the fallback, not the role sentence.
  assert.equal(taskTitle(undefined, '你是一名执行者。\n修复登录错误'), '修复登录错误');
});

test('an explicit title that is only a rule heading is not accepted as a title', () => {
  // The caller repeated the section name instead of the work: the record must fall
  // back to real content rather than headline a directive.
  assert.equal(taskTitle('## 执行规则', '修复登录错误'), '修复登录错误');
  assert.equal(taskTitle('执行任务规则', '修复登录错误'), '修复登录错误');
  // A real explicit title is still kept even when the prompt is all rules.
  assert.equal(taskTitle('修复登录错误', '# 执行规则\n1. 不要提交'), '修复登录错误');
});

// ---------------------------------------------------------------------------
// 2. 未传标题：不得把角色说明 / 规则标题 / 任务 ID / 路径当作主标题
// ---------------------------------------------------------------------------

test('a role-instruction heading never becomes the record title', () => {
  // Before the fix this returned the section name itself.
  assert.equal(taskTitle(undefined, '# 执行任务规则\n\nworkspace: E:/x\n\n修复标题显示'), '修复标题显示');
  assert.equal(taskTitle(undefined, '执行任务规则\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, '## Instructions\nFix the login error'), 'Fix the login error');
});

test('a task id or a workspace path never becomes the record title', () => {
  assert.equal(
    taskTitle(undefined, 'task-3d141e88-d133-4ec7-a500-d15727380935\n修复登录错误'),
    '修复登录错误',
  );
  // A checkout path on this host contains a space, which is still a path.
  assert.equal(
    taskTitle(undefined, 'E:/deepseek workplace/dsh-delegate\n修复登录错误'),
    '修复登录错误',
  );
  assert.equal(taskTitle(undefined, 'workspace: E:/x\n修复登录错误'), '修复登录错误');
});

test('a prompt made only of role lines and rules yields the placeholder, not a leak', () => {
  const title = taskTitle(undefined, '你是一名执行任务的实现工作者。\n# 执行规则\n1. 不要提交\nE:/x');
  assert.equal(title, '委派任务');
  // And it never echoes a fragment of the instructions.
  assert.doesNotMatch(title, /执行规则|不要提交|E:/u);
});

test('a directive bulleted rule list is not a title either', () => {
  assert.equal(taskTitle(undefined, '执行任务规则\n1. 不要提交\n2. 不要派工\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, '# 规则\n- 禁止提交\n- 必须回归'), '委派任务');
});

test('the title stays bounded and keeps Chinese content intact', () => {
  assert.equal(Array.from(taskTitle('中'.repeat(70))).length, 48);
  assert.equal(taskTitle(undefined, '修复任务记录缺失与标题显示'), '修复任务记录缺失与标题显示');
});

// ---------------------------------------------------------------------------
// 2b. 目标行：标签只取一次，任务 ID 不会被当成 "task" 关键字
// ---------------------------------------------------------------------------

test('a goal label is removed once and its content kept', () => {
  assert.equal(taskTitle(undefined, '目标：修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, 'GOAL: 修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, 'task: 修复登录错误\n其他'), '修复登录错误');
  assert.equal(taskTitle(undefined, 'Task\nFix the login error'), 'Fix the login error');
  assert.equal(taskTitle(undefined, '## Goal\nFix auth screen\n## Rules\n1. do not commit'), 'Fix auth screen');
});

test('a task id is never read as a "task" goal label, so it does not swallow the prompt', () => {
  // `task-3d14…` starts with the keyword "task"; only an explicit colon or the end of
  // the line may make it a label, so the id is skipped and the real line titles the task.
  assert.equal(
    taskTitle(undefined, 'task-3d141e88-d133-4ec7-a500-d15727380935\n修复登录错误'),
    '修复登录错误',
  );
  // A sentence that merely STARTS with 任务 is content, not a label.
  assert.equal(taskTitle(undefined, '任务是修复登录错误'), '任务是修复登录错误');
  // A relative path is ordinary text and may title the task.
  assert.equal(taskTitle(undefined, 'src/jobs/title.js 修复标题\n修复登录错误'), 'src/jobs/title.js 修复标题');
});

// ---------------------------------------------------------------------------
// 2c. 前缀不再被当成标识符：只排除「整行就是一个 ID / 一条路径」
// ---------------------------------------------------------------------------

test('a normal title that merely BEGINS with a product name is kept', () => {
  // The identifier pattern used to reject any line starting with "task-"/"taskbridge",
  // so a real title was replaced with the placeholder.
  assert.equal(taskTitle('TaskBridge 记录页标题修复', 'x'), 'TaskBridge 记录页标题修复');
  assert.equal(taskTitle(undefined, 'TaskBridge：修复任务记录缺失'), 'TaskBridge：修复任务记录缺失');
  assert.equal(taskTitle(undefined, 'taskbridge 全链路加固'), 'taskbridge 全链路加固');
  assert.equal(taskTitle(undefined, 'Taskbridge-1.6.1 标题修复'), 'Taskbridge-1.6.1 标题修复');
});

test('only a WHOLE identifier or a WHOLE path is excluded, not a line that mentions one', () => {
  // A sentence that starts with an id or a path is still a title.
  assert.equal(
    taskTitle(undefined, 'task-3d141e88-d133-4ec7-a500-d15727380935 修复登录错误'),
    'task-3d141e88-d133-4ec7-a500-d15727380935 修复登录错误',
  );
  assert.equal(taskTitle(undefined, 'C:/repo 修复登录错误'), 'C:/repo 修复登录错误');
  // A bare id / uuid / whole path answers "which", not "what": it is skipped.
  assert.equal(taskTitle(undefined, '3d141e88-d133-4ec7-a500-d15727380935\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, 'C:/Users/me/My Documents/project'), '委派任务');
  assert.equal(taskTitle(undefined, '/home/me/project\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, '\\\\server\\share\\repo\n修复登录错误'), '修复登录错误');
  // An ordinary title containing a slash is prose, not a path.
  assert.equal(taskTitle(undefined, '登录/注册页对齐修复'), '登录/注册页对齐修复');
});

test('multi-line titles and rooted paths keep only readable work content', () => {
  assert.equal(taskTitle('TaskBridge 修订\nE:/中文/项目\n其他内容'), 'TaskBridge 修订');
  for (const path of ['E:/中文/项目', '/开发/项目', '\\\\服务器\\共享\\项目']) {
    assert.equal(taskTitle(path, path), '委派任务');
  }
});

test('an explicit multi-line title takes the FIRST usable work line, never a later path or note', () => {
  // A caller that appends a path, a note or a fenced block must not have it spliced in.
  assert.equal(taskTitle('修复登录错误\nE:/repo/sub', 'x'), '修复登录错误');
  assert.equal(taskTitle('修订设置页\n说明：只改提示', 'x'), '修订设置页');
  assert.equal(taskTitle('\n修复登录错误\nE:/repo', 'x'), '修复登录错误');
  assert.equal(taskTitle('修复登录错误\n```js\nx=1\n```', 'x'), '修复登录错误');
  // A blank explicit title falls back to the prompt rather than becoming a heading.
  assert.equal(taskTitle('\n\n', '修复登录错误'), '修复登录错误');
});

test('a Chinese-containing absolute path is skipped, but a work title that CONTAINS it is kept', () => {
  // Pure paths, per root kind, with Chinese segments: never a title on their own.
  for (const path of ['E:/中文/项目', '/开发/项目', '\\\\服务器\\共享\\项目']) {
    assert.equal(taskTitle(undefined, path), '委派任务', path);
    assert.equal(taskTitle(undefined, `${path}\n修复登录错误`), '修复登录错误', path);
  }
  // The same paths as part of a real work title are content, not metadata.
  assert.equal(taskTitle(undefined, 'E:/中文/项目 修复登录错误'), 'E:/中文/项目 修复登录错误');
  assert.equal(taskTitle(undefined, '/开发/项目 修复登录错误'), '/开发/项目 修复登录错误');
  assert.equal(taskTitle(undefined, '\\\\服务器\\共享\\项目 修复登录错误'), '\\\\服务器\\共享\\项目 修复登录错误');
  // And a Chinese title is never misread as a path.
  assert.equal(taskTitle(undefined, '中文标题修复记录'), '中文标题修复记录');
});

test('a path followed only by a directory-name tail is still a path, not a work title', () => {
  // Reported defect: a rooted path whose last segment has a space (`项目 资料`) looked like
  // "path + work" because the tail was Chinese. It is a location, so it must be skipped.
  const tails = ['E:/文档/项目 资料', '/开发/项目 资料', '\\\\服务器\\共享\\项目 资料'];
  for (const line of tails) {
    // As a bare candidate line: skipped, so the later work line titles the task.
    assert.equal(taskTitle(undefined, line), '委派任务', line);
    assert.equal(taskTitle(undefined, `${line}\n修复登录错误`), '修复登录错误', line);
    // As an EXPLICIT title: rejected, so the prompt supplies the title.
    assert.equal(taskTitle(line, '修复登录错误'), '修复登录错误', line);
    // As an explicit title with nothing usable behind it: the placeholder.
    assert.equal(taskTitle(line, ''), '委派任务', line);
  }
  // The same shape with a plain Latin tail is skipped too.
  assert.equal(taskTitle(undefined, 'E:/docs/project notes'), '委派任务');
  assert.equal(taskTitle('E:/docs/project notes', ''), '委派任务');
});

test('a path followed by an explicit action phrase IS a work title', () => {
  // What distinguishes the two is the wording after the path, not merely a space.
  assert.equal(taskTitle(undefined, 'E:/中文/项目 修复登录错误'), 'E:/中文/项目 修复登录错误');
  assert.equal(taskTitle(undefined, '/srv/repo Fix task records'), '/srv/repo Fix task records');
  assert.equal(taskTitle(undefined, 'C:/repo 补充单元测试'), 'C:/repo 补充单元测试');
  // Also as an explicit title.
  assert.equal(taskTitle('E:/中文/项目 修复登录错误', 'ignored'), 'E:/中文/项目 修复登录错误');
  assert.equal(taskTitle('/srv/repo Fix task records', 'ignored'), '/srv/repo Fix task records');
});

test('the boundary after a path is found from the end, not at the first space', () => {
  // Splitting on the FIRST space broke both ways:
  //  * `工作 测试/历史` looked like a description even though a separator follows it;
  //  * `My Project 修复登录错误` lost its path prefix because the path itself has a space.
  //
  // Pure paths whose last segment has an interior space plus a further separator.
  for (const line of ['E:/资料/工作 测试/历史', '/开发/工作 测试/历史', '\\\\服务器\\共享\\工作 测试\\历史']) {
    assert.equal(taskTitle(undefined, line), '委派任务', line);
    // A description may not cross a path separator, so the tail stays a path segment.
    assert.equal(taskTitle(line, ''), '委派任务', line);
    assert.equal(taskTitle(undefined, `${line}\n修复登录错误`), '修复登录错误', line);
    assert.equal(taskTitle(line, '修复登录错误'), '修复登录错误', line);
  }
  // An isolated action word is not a description: it has no object, so the line is a path.
  assert.equal(taskTitle(undefined, 'E:/资料/工作 测试'), '委派任务');
  assert.equal(taskTitle('E:/资料/工作 测试', ''), '委派任务');

  // A path that itself contains a space, followed by real work, is kept whole.
  assert.equal(taskTitle(undefined, 'E:/资料/My Project 修复登录错误'), 'E:/资料/My Project 修复登录错误');
  assert.equal(taskTitle(undefined, '/srv/My Project Fix task records'), '/srv/My Project Fix task records');
  assert.equal(taskTitle('E:/资料/My Project 修复登录错误', 'ignored'), 'E:/资料/My Project 修复登录错误');
  assert.equal(taskTitle('/srv/My Project Fix task records', 'ignored'), '/srv/My Project Fix task records');
});

test('a description may not start at the segment start, and each language has its own separator', () => {
  // A path's own last segment may BEGIN with a verb. Since a description can only begin
  // after at least one path character plus whitespace, these stay pure paths.
  for (const line of ['E:/资料/修复记录', '/srv/Update notes', '\\\\服务器\\共享\\修复记录']) {
    assert.equal(taskTitle(undefined, line), '委派任务', line);
    assert.equal(taskTitle(line, ''), '委派任务', line);
    // With real work behind them, the later text wins.
    assert.equal(taskTitle(undefined, `${line}\n修复登录错误`), '修复登录错误', line);
    assert.equal(taskTitle(line, '修复登录错误'), '修复登录错误', line);
  }
  // A Latin action needs whitespace or a colon before its object, and `Fix:` has none.
  assert.equal(taskTitle(undefined, 'E:/repo Fix:'), '委派任务');
  assert.equal(taskTitle('E:/repo Fix:', ''), '委派任务');

  // Chinese attaches its object directly, so no space is needed after the verb.
  assert.equal(taskTitle(undefined, 'E:/repo 修复API显示'), 'E:/repo 修复API显示');
  assert.equal(taskTitle('E:/repo 修复API显示', 'ignored'), 'E:/repo 修复API显示');
});

test('a code fence and everything inside it never titles a task', () => {
  // Before the fix the first line INSIDE the fence became the title.
  assert.equal(taskTitle(undefined, '```js\nconst a = 1;\n```\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, '~~~\nnpm run build\n~~~\n修复登录错误'), '修复登录错误');
  assert.equal(taskTitle(undefined, '```\nconst a = 1;\n```'), '委派任务');
  // An unterminated fence runs to the end, so nothing after it is trusted either.
  assert.equal(taskTitle(undefined, '```\n修复登录错误'), '委派任务');
  assert.equal(taskTitle(undefined, '`npm test`\n修复登录错误'), '修复登录错误');
});

test('the structured goal wins over an earlier prose line, and a bare label uses the next line', () => {
  assert.equal(taskTitle(undefined, '任务说明很长而且不是标题。\n目标：修复登录错误\n其他'), '修复登录错误');
  assert.equal(taskTitle(undefined, '## 目标\n修复授权界面'), '修复授权界面');
  // A bare label with nothing usable under it never becomes the title itself.
  assert.equal(taskTitle(undefined, '## Goal\n```\ncode\n```'), '委派任务');
  assert.equal(taskTitle(undefined, 'Task\nFix the login error'), 'Fix the login error');
});

test('bilingual role prefixes are skipped, and a single-line work instruction is kept', () => {
  for (const prompt of [
    'You are a delegated implementer.\n修复登录错误',
    "You're the implementer for this packet.\n修复登录错误",
    '你是执行体。\n修复登录错误',
    '您是一名实现工作者。\n修复登录错误',
  ]) {
    assert.equal(taskTitle(undefined, prompt), '修复登录错误', prompt);
  }
  // The simple one-line instruction form still works, with and without a goal label.
  assert.equal(taskTitle(undefined, '修复任务记录缺失与标题显示'), '修复任务记录缺失与标题显示');
  assert.equal(taskTitle(undefined, 'Fix the login error'), 'Fix the login error');
});

test('an ambiguous prompt says 委派任务 rather than guessing a rule or a path', () => {
  assert.equal(taskTitle(undefined, '你是一名执行者。\n# 执行规则\n1. 不要提交\nE:/x'), '委派任务');
  assert.equal(taskTitle(undefined, '# 规则\n- 禁止提交\n- 必须回归'), '委派任务');
  assert.equal(taskTitle(undefined, 'E:/deepseek workplace/dsh-delegate'), '委派任务');
  assert.equal(taskTitle(undefined, ''), '委派任务');
  assert.equal(taskTitle(123, null), '委派任务');
});

// ---------------------------------------------------------------------------
// 3. 续接：轮次标题不替换任务链标题，同一链仍显示全部轮次
// ---------------------------------------------------------------------------

test('a continuation keeps the original chain title and all rounds stay in one chain', () => {
  const rounds = [
    task({ taskId: 'task-root-0001', title: '界面保存状态条', state: 'awaiting-host-review' }),
    task({
      taskId: 'task-cont-0002',
      title: '整改：修正窄窗口对齐',
      continueFromTaskId: 'task-root-0001',
      createdAt: Date.parse('2026-11-20T11:00:00+08:00'),
    }),
  ];
  const [chain] = groupContinuationChains(rounds);
  assert.equal(chain.displayTitle, '界面保存状态条', 'the rectification title does not replace the chain title');
  assert.equal(chain.roundCount, 2, 'both rounds are in the SAME chain');
  assert.deepEqual(chain.rounds.map((round) => round.title), ['界面保存状态条', '整改：修正窄窗口对齐']);
});

test('a chain whose ROOT has no title falls back transparently and never invents one', () => {
  const rounds = [
    task({ taskId: 'task-root-0002' }),
    task({ taskId: 'task-cont-0003', title: '整改轮次标题', continueFromTaskId: 'task-root-0002' }),
  ];
  const [chain] = groupContinuationChains(rounds);
  // The chain keeps the first RECORDED title of its own rounds; when none exists it is
  // labelled as missing rather than borrowing the prompt or a path.
  assert.equal(chain.displayTitle, '整改轮次标题');
  assert.equal(chain.titleMissing, false);

  const untitled = groupContinuationChains([task({ taskId: 'task-solo-0004' })]);
  assert.equal(untitled[0].titleMissing, true);
  assert.match(untitled[0].displayTitle, /^未记录标题/u);
  assert.equal(untitled[0].displayTitle.includes('source'), false, 'the path is never the title');
});

// ---------------------------------------------------------------------------
// 4. 从提交到可见、并可从持久历史重建
// ---------------------------------------------------------------------------

test('a submitted task is queryable in the projection and the title survives the persisted round', () => {
  // The engine writes `title: taskTitle(request.title, prompt)`, then the record is
  // stored and re-read as a history view carrying that same `title`.
  const submitted = task({ taskId: 'task-live-0001', state: 'pending' });
  submitted.title = taskTitle(undefined, '# 执行任务规则\n\n修复任务记录缺失与标题显示');

  // Visible while running, in the DEFAULT projection.
  const running = buildTaskTree({ planNodes: [], tasks: [submitted] });
  assert.equal(running.flatNodes.length, 1);
  assert.equal(running.roots[0].displayTitle, '修复任务记录缺失与标题显示');

  // After the run ends, the durable row carries the same title and rebuilds the same
  // heading — the persisted record is not re-derived from a prompt it no longer has.
  const stored = { ...submitted, state: 'awaiting-host-review', archived: true, live: false };
  const reloaded = buildTaskTree({ planNodes: [], tasks: [stored] });
  assert.equal(reloaded.roots[0].displayTitle, '修复任务记录缺失与标题显示');
  assert.equal(reloaded.roots[0].title, stored.title);

  // A record stored by an OLDER build with no title still reads, labelled honestly.
  const legacy = { ...submitted, taskId: 'task-legacy-0009', title: undefined };
  const legacyTree = buildTaskTree({ planNodes: [], tasks: [legacy] });
  assert.equal(legacyTree.roots[0].titleMissing, true);
  assert.match(legacyTree.roots[0].displayTitle, /^未记录标题/u);
});
