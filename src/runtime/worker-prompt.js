/**
 * Build the delegation prompt for one task.
 * @param {object} input - `taskId`, `prompt`, `workspacePath`, `isolation`, `diff`, `baseline`.
 * @returns {string} assembled prompt.
 */
export function buildWorkerPrompt(input) {
  const lines = [];
  lines.push('You are a delegated worker.');
  lines.push('');
  lines.push(`Task id: ${input.taskId}`);
  if (typeof input.workspacePath === 'string' && input.workspacePath !== '') {
    lines.push(`Workspace: ${input.workspacePath}`);
  }
  lines.push(`Isolation: ${input.isolation ?? 'shared'}`);
  lines.push('');
  lines.push('## Task');
  lines.push(String(input.prompt ?? '').trim());
  lines.push('');
  lines.push('## Working rules');
  lines.push('- Follow the assigned plan. Make routine choices within the packet. '
    + 'If a premise conflicts with the project, report what you verified and the affected step to the host before changing course.');
  lines.push('- You may modify files only inside the workspace above.');
  if (input.isolation === 'shared' || input.baseline?.dirtyBaseline === true) {
    lines.push('- Preserve existing uncommitted changes and unrelated files in this checkout.');
  }
  lines.push('- Do not commit, push, tag, or rewrite git history.');
  lines.push('- Do not read or print credentials, tokens, or .env contents.');
  lines.push('- Do not install packages or make external network requests (`Invoke-WebRequest`, `curl`, `wget`, etc.) unless the task explicitly requires it.');
  lines.push('');
  lines.push('## Checks and extra permissions');
  lines.push('- Always prefer native file/search/edit tools for files, search, and logs. '
    + 'Use shell commands only for tests, builds, typechecks, and Git inspection.');
  lines.push('- Read ordinary files and logs with the normal file tools and the ordinary workspace permission. '
    + 'Do not ask for elevated access merely to read a log, and do not use a sandbox escape as a substitute for '
    + 'a file tool.');
  lines.push('- Run tests under the ordinary permission first. If a test fails for a CONCRETE environment reason '
    + '(a missing module, a denied pipe, an absent binary), keep that error text and report it rather than retrying '
    + 'the same command with more access.');
  lines.push('- Ask for extra permission only for the one complete, bounded command that genuinely needs it, and say '
    + 'which error it resolves. A permission granted for one call never covers a later call, and it never widens '
    + 'the sandbox permanently.');
  lines.push('- Run one combined test command (on Windows prefer `node --test` or `npm.cmd test` over `npm.ps1`) and '
    + 'read its stdout/stderr and real exit code directly. Do NOT create `.cache/` or temporary log files inside the '
    + 'workspace; if any temporary probe file is ever created, remove those untracked temporary files before finishing '
    + 'so the delivery diff contains only intended task changes. Do not re-run a test merely to change a filter, a '
    + '`Select-String` pattern or a `Select-Object -First N`.');
  lines.push('- A missing dependency is a fact to verify, not a reason to re-run the suite: check whether the module '
    + 'exists before concluding the test failed, and never use extra permission to paper over a module-not-found '
    + 'error.');
  lines.push('- Fix a failing test before running the suite again. Report the tests you actually ran, their exit '
    + 'codes and their counts; if the worktree cannot provide a dependency, say so plainly instead of retrying.');
  lines.push('');
  lines.push('## Completion');
  lines.push('- Before delivery, do one self-review. For implementation tasks, review your diff, new files, and test results '
    + 'for missed requirements, out-of-scope edits, and gaps in required checks. '
    + 'Fix concrete in-scope issues and rerun affected checks.');
  lines.push('- For verification-only tasks, check findings against the evidence and keep the work read-only.');
  lines.push('- Summarize work, changed files, checks and results, and gaps. Do not claim checks you did not run.');
  lines.push('You cannot approve your own work; the host decides acceptance.');
  if (input.baseline !== undefined && input.baseline !== null) {
    lines.push('');
    lines.push(`## Starting state: ${input.baseline.dirtyBaseline === true ? 'the workspace already had uncommitted changes' : 'the workspace was clean'}`);
  }
  return lines.join('\n');
}
