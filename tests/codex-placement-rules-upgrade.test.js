import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digest,
  isKnownPriorTemplate,
  readCodexStatus,
  refreshKnownAgentTemplate,
  renderAgentFile,
  useDirectoryClassifier,
} from '../src/codex/installer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previous = readFileSync(join(ROOT, 'tests/fixtures/agent-1.5.3.toml'), 'utf8');
const previous154 = readFileSync(join(ROOT, 'tests/fixtures/agent-1.5.4.toml'), 'utf8');
const current = readFileSync(join(ROOT, 'codex/skills/dsh-taskbridge/SKILL.md'), 'utf8');
const version = '1.9.0';

useDirectoryClassifier(async (paths) => new Map(paths.map((path) => {
  let kind = 'missing';
  try {
    const stat = lstatSync(path);
    kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [path, kind];
})));

test('the placement rules keep the exact published 1.5.3 and 1.5.4 identities upgradeable', () => {
  const lf = previous.replace(/\r\n/gu, '\n');
  const lf154 = previous154.replace(/\r\n/gu, '\n');
  assert.equal(digest(previous), 'd26428333420f6e37d6a2ed5b953268bb99642eec4c08d46c402002ca6793df8');
  assert.equal(digest(lf), '12c1caac42d461b143e23b0b1e1218e32a735ee665ce13ac56ebef7c0f46cfd3');
  assert.equal(digest(previous154), '94ee47a0bfc16a36c76010d1e1a2476ff6117966f5c1559b01193353199f82e8');
  assert.equal(digest(lf154), '8efbe5d627f72b34fb66decd7784552b5eafb0289c409bb6443ae28094351aae');
  assert.notEqual(current.replace(/\r\n/gu, '\n'), lf);
  assert.notEqual(current.replace(/\r\n/gu, '\n'), lf154);
  for (const text of [previous, lf, previous154, lf154]) {
    assert.equal(isKnownPriorTemplate(text), true);
    assert.equal(isKnownPriorTemplate(`${text}\n# operator change\n`), false);
  }
});

test('a real temporary Codex home upgrades only known rules into native skill, retires old toml, and preserves custom edits and config', async () => {
  for (const oldText of [previous, previous.replace(/\r\n/gu, '\n'), previous154, previous154.replace(/\r\n/gu, '\n')]) {
    const home = mkdtempSync(join(tmpdir(), 'taskbridge-placement-rules-'));
    try {
      const legacyAgent = join(home, 'agents/dsh-taskbridge.toml');
      const skill = join(home, 'skills/dsh-taskbridge/SKILL.md');
      const config = join(home, 'config.toml');
      const configText = '# operator settings\r\nmodel = "operator-model"\r\n';
      mkdirSync(join(home, 'agents'));
      writeFileSync(legacyAgent, oldText);
      writeFileSync(config, configText);
      const options = { codexHome: home, env: { DSH_HOME: join(home, '.dsh-test-home') }, version };
      const initial = await readCodexStatus(options);
      assert.equal(initial.legacyAgents.state, 'managed-legacy');
      const upgraded = await refreshKnownAgentTemplate(options);
      assert.deepEqual(upgraded.changed, ['agent', 'legacyAgent']);
      assert.deepEqual(upgraded.refused, []);
      assert.equal(readFileSync(skill, 'utf8'), renderAgentFile(current, version));
      assert.equal(existsSync(legacyAgent), false, 'untouched legacy subagent must be retired');
      assert.equal(readFileSync(config, 'utf8'), configText);
      assert.equal((await readCodexStatus(options)).agent.state, 'installed');
      assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);

      const editedSkill = `${readFileSync(skill, 'utf8')}\n<!-- operator change -->\n`;
      writeFileSync(skill, editedSkill);
      assert.equal((await readCodexStatus(options)).agent.state, 'modified');
      assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);
      assert.equal(readFileSync(skill, 'utf8'), editedSkill);

      const editedLegacy = `${oldText}\n# operator change\n`;
      writeFileSync(legacyAgent, editedLegacy);
      assert.equal((await readCodexStatus(options)).legacyAgents.state, 'modified-legacy');
      assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);
      assert.equal(readFileSync(legacyAgent, 'utf8'), editedLegacy);
      assert.equal(readFileSync(config, 'utf8'), configText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
