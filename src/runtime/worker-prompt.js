/**
 * Build the delegation prompt for one task.
 * @param {object} input - `taskId`, `prompt`, `workspacePath`, `isolation`, `diff`, `baseline`.
 * @returns {string} assembled prompt.
 */
export function buildWorkerPrompt(input) {
  const lines = [];
  lines.push('You are a delegated implementation worker. Your work will be reviewed by the host.');
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
  lines.push('- Do not install packages from the network unless the task explicitly requires it.');
  lines.push('- Report what you changed and what you could not do. Do not claim checks you did not run.');
  lines.push('');
  lines.push('## Checks and extra permissions');
  lines.push('- Read ordinary files and logs with the normal file tools and the ordinary workspace permission. '
    + 'Do not ask for elevated access merely to read a log, and do not use a sandbox escape as a substitute for '
    + 'a file tool.');
  lines.push('- Run tests under the ordinary permission first. If a test fails for a CONCRETE environment reason '
    + '(a missing module, a denied pipe, an absent binary), keep that error text and report it rather than retrying '
    + 'the same command with more access.');
  lines.push('- Ask for extra permission only for the one complete, bounded command that genuinely needs it, and say '
    + 'which error it resolves. A permission granted for one call never covers a later call, and it never widens '
    + 'the sandbox permanently.');
  lines.push('- Run one combined test command, save its FULL stdout/stderr, its real exit code and a short summary '
    + '(for example into `.cache/`), and read that saved log afterwards with the file tools. Do not re-run a test '
    + 'merely to change a filter, a `Select-String` pattern or a `Select-Object -First N`: read the log instead.');
  lines.push('- After reading temporary test logs you created (such as under `.cache/`), remove those untracked '
    + 'temporary log files before finishing so the delivery diff contains only intended task changes.');
  lines.push('- A missing dependency is a fact to verify, not a reason to re-run the suite: check whether the module '
    + 'exists before concluding the test failed, and never use extra permission to paper over a module-not-found '
    + 'error.');
  lines.push('- Fix a failing test before running the suite again. Report the tests you actually ran, their exit '
    + 'codes and their counts; if the worktree cannot provide a dependency, say so plainly instead of retrying.');
  lines.push('');
  lines.push('## Completion');
  lines.push('When the task is complete, reply with a short summary, the files you changed, and any checks you actually ran with their results.');
  lines.push('You cannot approve your own work; the host decides acceptance.');
  if (input.baseline !== undefined && input.baseline !== null) {
    lines.push('');
    lines.push(`## Starting state: ${input.baseline.dirtyBaseline === true ? 'the workspace already had uncommitted changes' : 'the workspace was clean'}`);
  }
  return lines.join('\n');
}
