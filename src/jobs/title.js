import { redactText } from '../config/redact.js';

const GOAL = /^(?:目标|任务目标|工作内容|任务|goal|objective|task)(?:\s*[:：]\s*|$)(.*)$/iu;
const ROLE = /^(?:you are\b|you're\b|you will\b|you must\b|act as\b|your (?:role|task|job|objective)\b|as an?\b|你是|您是一名|你负责|你需要|你的(?:角色|任务|职责)|请作为|作为一)/iu;
const RULE = /^(?:instructions?|execution task rules?|task rules?|rules?|guidelines?|constraints?|requirements?|role|persona|system|context|background|overview|summary|steps?|procedure|执行任务规则|执行规则|任务规则|规则|约束|限制|要求|角色|身份|系统|背景|上下文|说明|验收|范围|步骤|流程|概述)(?:\s*[:：].*|\s*)$/iu;
const RESTRICTION = /^(?:不要|不准|不得|禁止|必须|务必|请勿|别|do not\b|don't\b|never\b|must\b|always\b|avoid\b|use only\b)/iu;
const METADATA = /^(?:workspace|worktree|source|repo|repository|branch|commit|path|路径|工作区|仓库|分支|目录|提交)\s*[:：]/iu;
const IDENTIFIER = /^(?:task-[0-9a-z][0-9a-z-]{5,}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|sha256:[\da-f]{64})[:：]?$/iu;
const ROOTED_PATH = /^(?:[a-z]:[\\/]|\\\\|\/|~\/)/iu;
const RELATIVE_PATH = /^(?:[^\s\\/]+[\\/])+[^\s\\/]+$/u;

/**
 * Common work actions. A title is "path + work", not "path", only when one of these starts
 * the description AND that description has an object. Deliberately short: a wording
 * heuristic, not natural-language parsing.
 */
const CJK_ACTION = /^(?:修复|修改|修正|整改|更新|升级|补充|补齐|完善|新增|添加|删除|移除|替换|重构|重写|实现|支持|接入|迁移|优化|调整|对齐|统一|清理|整理|检查|校验|验证|排查|复现|回归|覆盖|编写|生成|同步|合并|拆分|提取|封装|加固|收紧|收口|处理|解决)/u;
const LATIN_ACTION = /^(?:fix(?:es|ed|ing)?|add(?:s|ed|ing)?|update(?:s|d|ing)?|remove(?:s|d|ing)?|delete(?:s|d|ing)?|refactor(?:s|ed|ing)?|implement(?:s|ed|ing)?|support(?:s|ed|ing)?|migrate|improve[sd]?|optimi[sz]e[sd]?|rename[sd]?|clean(?:s|ed|ing)?|test(?:s|ed|ing)?|check(?:s|ed|ing)?|review(?:s|ed|ing)?|sync(?:s|ed|ing)?|extract(?:s|ed|ing)?|merge[sd]?|align(?:s|ed|ing)?|tighten(?:s|ed|ing)?)\b/iu;

/**
 * The object that starts a description, after its action, or '' when there is none.
 *
 * A description needs something to act ON, so a bare verb (`Fix:`, an isolated `测试`) never
 * qualifies. Chinese attaches its object directly (`修复API显示`), while a Latin verb must be
 * separated from its object by whitespace or a colon — which is also why `Fix:` alone, with
 * nothing after the colon, has no object.
 * @param {string} text - the text right after the action.
 * @returns {string} the object text, or '' when the action has no object.
 */
function actionObject(text) {
  const trimmed = text.trim();
  // A separator that leads nowhere (`Fix:` / `修复：`) is not an object.
  return trimmed.replace(/^[:：]+/u, '').trim();
}

/**
 * Whether one rooted (absolute) line carries a work description after its path.
 *
 * A rooted line is ambiguous: `E:/repo 修复API显示` is a work title, while `E:/资料/修复记录`
 * is a path whose last segment merely STARTS with a verb. Splitting on the first space
 * cannot decide that — a path may itself contain spaces (`E:/资料/My Project 修复登录错误`) —
 * so the boundary is searched for inside the LAST path segment:
 *
 *   * a description may only begin at whitespace that follows at least one non-space path
 *     character, so index 0 and leading whitespace are never a boundary (that is what made
 *     `修复记录` and `Update notes` read as work);
 *   * the description may not cross a path separator, so `测试/历史` stays a path segment;
 *   * the action must have an object (see {@link actionObject});
 *   * Chinese attaches its object directly; Latin must be separated by whitespace or colon.
 *
 * A directory literally named after an action plus its object stays genuinely ambiguous;
 * that is documented in the delivery, and no filesystem access is attempted.
 * @param {string} line - one trimmed candidate line.
 * @returns {boolean} true when the line reads as "path + work", not "path".
 */
function describesWorkAfterPath(line) {
  // Everything after the last separator is the final segment, which may hold the description.
  const slash = Math.max(line.lastIndexOf('/'), line.lastIndexOf('\\'));
  const segment = slash >= 0 ? line.slice(slash + 1) : line;
  for (let index = 1; index < segment.length; index += 1) {
    // A boundary is whitespace preceded by a path character: never the segment start.
    if (!/\s/u.test(segment[index]) || /\s/u.test(segment[index - 1])) continue;
    const rest = segment.slice(index).trim();
    if (rest === '') continue;
    const cjk = CJK_ACTION.exec(rest);
    if (cjk !== null && actionObject(rest.slice(cjk[0].length)) !== '') return true;
    const latin = LATIN_ACTION.exec(rest);
    // Latin needs an explicit separator, so `Fixings` or `Update` alone never matches.
    if (latin !== null && /^[\s:：]/u.test(rest.slice(latin[0].length)) && actionObject(rest.slice(latin[0].length)) !== '') {
      return true;
    }
  }
  return false;
}

function textLines(value) {
  return typeof value === 'string' ? value.split(/\r\n?|\n/u).map((line) => line.trim()) : [];
}

function plainLine(line) {
  return line.replace(/^(?:#{1,6}\s*|(?:\d+[.)、]|[-*+])\s+)/u, '').trim();
}

function outsideFences(value) {
  let open = null;
  return textLines(value).map((line) => {
    const fence = /^(\x60{3,}|~{3,})(.*)$/u.exec(line);
    if (open !== null) {
      if (fence?.[1][0] === open[0] && fence[1].length >= open.length && fence[2].trim() === '') open = null;
      return null;
    }
    if (fence) {
      open = fence[1];
      return null;
    }
    return plainLine(line);
  });
}

function candidate(line) {
  if (!line || /^(?:[|>]|[-*_]{3,}|\x60[^\x60]*\x60$)/u.test(line)) return '';
  if (ROLE.test(line) || RULE.test(line) || RESTRICTION.test(line) || METADATA.test(line) || IDENTIFIER.test(line)) return '';
  if (ROOTED_PATH.test(line) && !describesWorkAfterPath(line)) return '';
  if (RELATIVE_PATH.test(line) && !/\p{Script=Han}/u.test(line)) return '';
  return redactText(line).replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Use a short title, a structured goal, or one readable line from older callers. */
export function taskTitle(title, prompt = '') {
  const explicit = outsideFences(title).map(candidate).find((line) => line && GOAL.exec(line)?.[1] !== '');
  if (explicit) return boundedTitle(explicit);

  const lines = outsideFences(prompt);
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    const goal = GOAL.exec(line);
    if (!goal) continue;
    let body = goal[1];
    if (body === '') {
      let next = index + 1;
      while (lines[next] === '') next += 1;
      body = lines[next];
    }
    const text = candidate(body);
    if (text && !GOAL.test(text)) return boundedTitle(text);
  }
  const fallback = lines.map(candidate).find((line) => line && !GOAL.test(line));
  return boundedTitle(fallback || '委派任务');
}

function boundedTitle(title) {
  const chars = Array.from(title);
  return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : title;
}
