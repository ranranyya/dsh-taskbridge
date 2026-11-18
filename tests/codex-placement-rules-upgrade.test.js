import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const current = readFileSync(join(ROOT, 'codex/dsh-taskbridge.toml'), 'utf8');
const version = '1.5.4';

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

test('the placement rules keep the exact published 1.5.3 identities upgradeable', () => {
  const lf = previous.replace(/\r\n/gu, '\n');
  assert.equal(digest(previous), 'd26428333420f6e37d6a2ed5b953268bb99642eec4c08d46c402002ca6793df8');
  assert.equal(digest(lf), '12c1caac42d461b143e23b0b1e1218e32a735ee665ce13ac56ebef7c0f46cfd3');
  assert.notEqual(current.replace(/\r\n/gu, '\n'), lf);
  for (const text of [previous, lf]) {
    assert.equal(isKnownPriorTemplate(text), true);
    assert.equal(isKnownPriorTemplate(`${text}\n# operator change\n`), false);
  }
});

test('a real temporary Codex home upgrades only known rules and preserves custom edits and config', async () => {
  for (const oldText of [previous, previous.replace(/\r\n/gu, '\n')]) {
    const home = mkdtempSync(join(tmpdir(), 'taskbridge-placement-rules-'));
    try {
      const agent = join(home, 'agents/dsh-taskbridge.toml');
      const config = join(home, 'config.toml');
      const configText = '# operator settings\r\nmodel = "operator-model"\r\n';
      mkdirSync(join(home, 'agents'));
      writeFileSync(agent, oldText);
      writeFileSync(config, configText);
      const options = { codexHome: home, env: {}, version };
      assert.equal((await readCodexStatus(options)).agent.state, 'outdated');
      const upgraded = await refreshKnownAgentTemplate(options);
      assert.deepEqual(upgraded.changed, ['agent']);
      assert.deepEqual(upgraded.refused, []);
      assert.equal(readFileSync(agent, 'utf8'), renderAgentFile(current, version));
      assert.equal(readFileSync(config, 'utf8'), configText);
      assert.equal((await readCodexStatus(options)).agent.state, 'installed');
      assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);

      const edited = `${oldText}\n# operator change\n`;
      writeFileSync(agent, edited);
      assert.equal((await readCodexStatus(options)).agent.state, 'modified');
      assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);
      assert.equal(readFileSync(agent, 'utf8'), edited);
      assert.equal(readFileSync(config, 'utf8'), configText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
