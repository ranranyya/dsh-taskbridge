#!/usr/bin/env node
/**
 * Assemble platform-specific host integration artifacts from the layered
 * single-source definitions under `integrations/`:
 *
 *   Layer 2 (`integrations/core/*.md`)      — shared cross-host commander rules
 *   Layer 1 (`integrations/adapters/*.md`)  — thin host-specific adapters
 *
 * Outputs (LF normalized):
 *   - codex/skills/dsh-taskbridge/SKILL.md + rules-reference-<sha256>.md
 *   - antigravity/skills/dsh-taskbridge/SKILL.md
 *   - antigravity/agents/dsh-taskbridge.md
 *
 * Usage:
 *   node scripts/build-integrations.mjs          # regenerate outputs
 *   node scripts/build-integrations.mjs --check  # fail if any output drifted
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_SKILL_DIR = 'codex/skills/dsh-taskbridge';
const GENERATED_REFERENCE = /^rules-reference-([0-9a-f]{64})\.md$/u;

export const INTEGRATION_TARGETS = Object.freeze([
  Object.freeze({
    id: 'codex-reference',
    adapter: 'integrations/adapters/codex-reference.adapter.md',
  }),
  Object.freeze({
    id: 'codex-skill',
    adapter: 'integrations/adapters/codex-skill.adapter.md',
    output: `${CODEX_SKILL_DIR}/SKILL.md`,
  }),
  Object.freeze({
    id: 'antigravity-skill',
    adapter: 'integrations/adapters/antigravity-skill.adapter.md',
    output: 'antigravity/skills/dsh-taskbridge/SKILL.md',
  }),
  Object.freeze({
    id: 'antigravity-subagent',
    adapter: 'integrations/adapters/antigravity-subagent.adapter.md',
    output: 'antigravity/agents/dsh-taskbridge.md',
  }),
]);

function normalizeLf(text) {
  return String(text).replace(/\r\n/gu, '\n');
}

function readPackageVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json is missing a valid version');
  }
  return pkg.version.trim();
}

export function extractNamedBlocks(fileText, sourceLabel) {
  const normalized = normalizeLf(fileText);
  const blocks = new Map();
  const re = /<!--\s*@block:\s*([a-zA-Z0-9_-]+)\s*-->\n([\s\S]*?)\n<!--\s*@endblock\s*-->/gu;
  let match;
  while ((match = re.exec(normalized)) !== null) {
    const [, blockName, body] = match;
    if (blocks.has(blockName)) {
      throw new Error(`Duplicate @block "${blockName}" in ${sourceLabel}`);
    }
    blocks.set(blockName, body.trimEnd());
  }
  if (blocks.size === 0) {
    throw new Error(`No @block sections found in ${sourceLabel}`);
  }
  return blocks;
}

// Project the existing list items into the Codex entry and reference. The selectors name
// whole items in L2; the wording and decisions stay in the shared source.
const CODEX_RULE_SPLITS = {
  '02-planning-philosophy:codex': {
    reference: ['3. For a multi-stage goal,'],
  },
  '03-dispatch-state-machine:codex-dispatch': {
    reference: [
      '   - `isolation: "block"` with `decisionRequired: true`',
      '   - `agentTeams`:',
      '   - Task threads:',
    ],
  },
  '03-dispatch-state-machine:codex-wait-reasons': {
    entry: ['   - `wait-limit`', '   - `heartbeat`', '   - `ready`:'],
    keepInReference: ['   - `wait-limit`'],
  },
};

function normalizeSplitSection(blockName, part, joined) {
  let out = joined;
  if (blockName === '02-planning-philosophy:codex') {
    if (part === 'entry') {
      let n = 0;
      out = out.replace(/^(\d+)\. /gmu, () => `${++n}. `);
    } else {
      out = out.replace(/^3\. /u, '- ').replace(/\n {3}/gu, '\n  ');
    }
  } else if (blockName === '03-dispatch-state-machine:codex-dispatch' && part === 'reference') {
    out = out.replace(/^ {3}- /gmu, '- ').replace(/^ {5}/gmu, '  ');
  } else if (blockName === '03-dispatch-state-machine:codex-wait-reasons') {
    if (part === 'entry') {
      out = out.replace(/^ {3}- /gmu, '- ').replace(/^ {5}/gmu, '  ');
    } else {
      let n = 0;
      out = out.replace(/^(\d+)\. /gmu, () => `${++n}. `);
    }
  }
  return out;
}

function partitionCodexRules(blockName, text) {
  const split = CODEX_RULE_SPLITS[blockName];
  if (split === undefined) throw new Error(`No Codex rule split for ${blockName}`);
  const selected = split.entry ?? split.reference;
  const keepBoth = new Set(split.keepInReference ?? []);
  const items = text.split(/\n(?=   - |\d+\. )/u);
  for (const start of selected) {
    if (items.filter((item) => item.startsWith(start)).length !== 1) {
      throw new Error(`Expected one ${blockName} item starting with ${JSON.stringify(start)}`);
    }
  }
  const matching = [];
  const rest = [];
  for (const item of items) {
    const isSelected = selected.some((start) => item.startsWith(start));
    if (isSelected) {
      matching.push(item);
      if (split.entry && [...keepBoth].some((start) => item.startsWith(start))) {
        rest.push(item);
      }
    } else {
      rest.push(item);
    }
  }
  const [entry, reference] = split.entry ? [matching, rest] : [rest, matching];
  return {
    entry: normalizeSplitSection(blockName, 'entry', entry.join('\n')),
    reference: normalizeSplitSection(blockName, 'reference', reference.join('\n')),
  };
}

export function renderAllIntegrations(root = DEFAULT_ROOT) {
  const version = readPackageVersion(root);
  const coreCache = new Map();

  function loadCoreBlock(coreFileStem, blockName) {
    if (!coreCache.has(coreFileStem)) {
      const rel = `integrations/core/${coreFileStem}.md`;
      const raw = readFileSync(join(root, rel), 'utf8');
      coreCache.set(coreFileStem, extractNamedBlocks(raw, rel));
    }
    const blocks = coreCache.get(coreFileStem);
    if (!blocks.has(blockName)) {
      throw new Error(`Missing @block "${blockName}" in integrations/core/${coreFileStem}.md`);
    }
    return blocks.get(blockName);
  }

  const results = [];
  let codexReferenceFile;
  for (const target of INTEGRATION_TARGETS) {
    const adapterRaw = normalizeLf(readFileSync(join(root, target.adapter), 'utf8'));
    const rendered = adapterRaw
      .replace(/\{\{PACKAGE_VERSION\}\}/gu, version)
      .replace(/\{\{CODEX_REFERENCE_FILE\}\}/gu, () => codexReferenceFile ?? '{{CODEX_REFERENCE_FILE}}')
      .replace(/\{\{CORE:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)(?::(entry|reference))?\}\}/gu, (_, stem, block, part) => {
        const body = loadCoreBlock(stem, block);
        return part ? partitionCodexRules(`${stem}:${block}`, body)[part] : body;
      });

    const unresolved = rendered.match(/\{\{[^}]+\}\}/gu);
    if (unresolved !== null) {
      throw new Error(`Unresolved template placeholder(s) in ${target.adapter}: ${unresolved.join(', ')}`);
    }

    const finalContent = rendered.endsWith('\n') ? rendered : `${rendered}\n`;
    let output = target.output;
    if (target.id === 'codex-reference') {
      const digest = createHash('sha256').update(finalContent, 'utf8').digest('hex');
      codexReferenceFile = `rules-reference-${digest}.md`;
      output = `${CODEX_SKILL_DIR}/${codexReferenceFile}`;
    }
    const bytes = Buffer.byteLength(finalContent);
    if (target.id === 'codex-skill' && bytes > 16000) {
      throw new Error(`${output} is ${bytes} bytes, over the 16,000-byte Codex entry read budget`);
    }
    if (target.id === 'codex-reference' && bytes > 24000) {
      throw new Error(`${output} is ${bytes} bytes, over the 24,000-byte Codex reference read budget`);
    }
    results.push({
      id: target.id,
      adapter: target.adapter,
      output,
      content: finalContent,
    });
  }
  return results;
}

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  const rendered = renderAllIntegrations(DEFAULT_ROOT);
  const drifted = [];
  const updated = [];

  for (const item of rendered) {
    const outPath = join(DEFAULT_ROOT, item.output);
    let existing = null;
    try {
      existing = normalizeLf(readFileSync(outPath, 'utf8'));
    } catch {
      existing = null;
    }
    if (existing === item.content) continue;
    if (checkOnly) {
      drifted.push(item.output);
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, item.content, 'utf8');
      updated.push(item.output);
    }
  }

  // The package includes the generated appendix by pattern. Retire only older artifacts whose
  // content still matches their filename. A hand-edited file is preserved and reported as drift.
  const reference = rendered.find((item) => item.id === 'codex-reference');
  const skillDir = join(DEFAULT_ROOT, CODEX_SKILL_DIR);
  const entries = existsSync(skillDir) ? readdirSync(skillDir, { withFileTypes: true }) : [];
  for (const entry of entries) {
    const named = entry.name.match(GENERATED_REFERENCE);
    if (named === null || entry.name === basename(reference.output)) continue;
    const relative = `${CODEX_SKILL_DIR}/${entry.name}`;
    const path = join(DEFAULT_ROOT, relative);
    const digest = entry.isFile()
      ? createHash('sha256').update(normalizeLf(readFileSync(path, 'utf8')), 'utf8').digest('hex')
      : null;
    if (checkOnly || digest !== named[1]) {
      drifted.push(relative);
    } else {
      unlinkSync(path);
      updated.push(relative);
    }
  }

  if (drifted.length > 0) {
    console.error(`Host integration outputs out of sync: \n  - ${drifted.join('\n  - ')}`);
    console.error(checkOnly ? 'Run: npm run build:integrations' : 'Resolve the edited or occupied generated path.');
    process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    console.log(`Host integration outputs verified (${rendered.length}/${rendered.length} in sync).`);
    return;
  }

  if (updated.length === 0) {
    console.log(`Host integration outputs already up-to-date (${rendered.length} files).`);
  } else {
    console.log(`Generated ${updated.length} host integration output(s):\n  - ${updated.join('\n  - ')}`);
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main();
}
