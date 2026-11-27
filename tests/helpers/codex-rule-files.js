import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIPPED = fileURLToPath(new URL('../../integrations/targets/codex/skills/dsh-taskbridge/SKILL.md', import.meta.url));

export function readCodexRuleFiles(path = SHIPPED) {
  const entry = readFileSync(path, 'utf8');
  const match = entry.match(/\]\((rules-reference-[0-9a-f]{64}\.md)\)/u);
  assert.ok(match, `${path} must link to its rules reference`);
  const referencePath = join(dirname(path), match[1]);
  const reference = readFileSync(referencePath, 'utf8');
  return { entry, reference, referencePath };
}

export function codexRuleText(path) {
  const { entry, reference } = readCodexRuleFiles(path);
  return `${entry}\n${reference}`;
}
