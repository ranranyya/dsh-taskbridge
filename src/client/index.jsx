// dsh-delegate — native DSH bundle-configuration page (browser half of the plugin).
//
// This file is the whole operator GUI. It is a *client plugin*, not a standalone
// dashboard and not a Codex surface: it registers the dsh-delegate bundle's
// configuration in the native **Plugins manager** (`plugins.bundle.config`,
// keyed by the bundle's npm package name), so it renders on this bundle's own
// details page inside that manager and disappears when the plugin is disabled.
// Desktop and Web both compose the same client-plugin/module system, so one
// `platform: "web"` client declaration serves both shells.
//
// Contract facts this file is written against (installed
// `@deepseek-ai/dsh-client-ui-plugin-manager` 0.2.1-rc.2,
// `lib/types/client/slot-contract.d.ts`):
//
//   * `plugins.bundle.config` is `kind: 'keyed'`, `scope: 'root'`, keyed by the
//     bundle package name, and is rendered only with `view: 'page'` (the manager's
//     bundle detail page calls `renderSlot(..., { view: 'page' }, { entryKey })`).
//     The slot's `owner` is `{ view }` plus an optional host `form`; this page
//     keeps its own controls and does not use the host form.
//   * `ctx.slots.inject(name, register)` runs `register` once the slot name is
//     declared by its owning entry and disposes the registration when it is not.
//     `ctx.slots.register(options, Component)` returns that disposer.
//   * A slot registration declaring `locale` receives a `t` seat and requires an
//     installed locale face. This page is deliberately Chinese-only and declares
//     no `locale`, so it does not depend on the locale plugin being composed; all
//     operator copy is written here once, in Chinese.
//   * `inject` on a registration is either a plain props object or a
//     `{ hooks, keyedHooks }` face. We return a plain object holding the store, so
//     the component subscribes to the store itself with `useSyncExternalStore`.
//   * A registrant merges the slot contract with `import type` and registers
//     through `ctx.slots`; it never imports the plugin-manager package at
//     runtime. Ordering comes from `dsh.client.inject` in package.json, which
//     names `@deepseek-ai/dsh-client-ui-plugin-manager` so its factory is
//     registered (and its slot declared) before this registration materializes.
//
// Security properties that must survive any edit of this file:
//
//   * No `dangerouslySetInnerHTML` anywhere: model output, diffs and host
//     diagnostics are rendered as text nodes only.
//   * Provider credentials are not entered here. New selections come from DSH's
//     registered provider list, so their existing credential configuration stays
//     inside DSH.
//   * Nothing here submits a task. The GUI controls local MCP access and settings;
//     the MCP host submits. The task panel offers cancel and retry guidance.
//
// React and `react/jsx-runtime` are the only module requests this bundle makes
// beyond `@deepseek-ai/*` platform modules, which is why the native loader can
// resolve every external against its frozen platform table.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  ANTIGRAVITY_ACTIONS,
  CODEX_ACTIONS,
  CONVERSATION_POLICY_LABEL,
  EFFORT_LABELS,
  EFFORT_UNSET,
  ISOLATION_LABELS,
  ISOLATION_MODES,
  LIMITS,
  PERMISSION_DECISION_LABELS,
  PERMISSION_OUTCOME_LABELS,
  PERMISSION_STATE_LABELS,
  REVIEW_STATE_LABELS,
  REVIEW_VERDICT_LABELS,
  ROUTES,
  TASK_STATES,
  TREE_ORPHAN_LABELS,
  TREE_STATUS_LABELS,
  TREE_STATUS_TONES,
  antigravityTargetView,
  boundedText,
  changedFiles,
  clone,
  codexMcpDriftText,
  codexTargetView,
  createApi,
  createStore,
  describeAntigravityOutcome,
  describeCodexOutcome,
  describeError,
  documentFromDraft,
  draftFromSettings,
  exportDocument,
  formatTime,
  isAwaitingPermission,
  isCancellable,
  executionOf,
  AGENT_TEAMS_ORIGIN_LABELS,
  hasLiveTasks,
  formatDuration,
  hostReviewLine,
  RECORD_REFRESH_INTERVAL_MS,
  recordRefreshPlan,
  startRecordsReadLoop,
  reviewNotePreview,
  hasChangingRecords,
  isLiveTask,
  minutesToSeconds,
  monitoringDraftOf,
  monitoringOf,
  monitoringText,
  pendingPermission,
  permissionSummary,
  planCreateRequest,
  precheckDraft,
  precheckMonitoring,
  previewEffective,
  repeatFailureLine,
  secondsToMinutes,
  SELF_CHECK_LABELS,
  taskActivity,
  taskOutcome,
  taskPhaseLabel,
  taskProgress,
  taskStateLabel,
  WAIT_REASON_LABELS,
} from './api.js';
import { injectStyles } from './styles.js';
import {
  locateSession, resolveService, resolveUiWorkspace, resolveWorkspaces, taskSessionId,
} from './sidebar.jsx';
import { registerSessionRowMarker } from './workspaces-browser.jsx';
import {
  cleanupCandidates,
  cleanupConfirmText,
  cleanupProjection,
  cleanupSelectionSummary,
  cleanupWarningText,
  selectCleanupCandidatesByPreset,
  toggleCleanupSelection,
  withSelectionState,
} from './task-cleanup.js';
import { projectTaskView } from './task-view.js';
import { TaskRecordsTable } from './task-records-table.jsx';
import { registerWorkspacesBrowser } from './workspaces-browser.jsx';

/** Plugins-manager config slot this page occupies. */
export const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config';

/**
 * Key of this bundle's configuration entry: exactly the bundle's npm package
 * name. The Plugins manager looks the entry up by `pkg.name`, so any other key
 * registers a page that never renders.
 */
export const PLUGIN_BUNDLE_KEY = 'dsh-taskbridge';

/** Required client services: slot registration only. */
export const inject = ['slots'];

const SessionNavigation = createContext(null);

/**
 * Register the bundle configuration page on a client context.
 *
 * Split out from {@link apply} so a test can drive it with a fake `ctx` and
 * assert the registration contract (slot name, key, inject face) without a
 * browser.
 * @param {object} ctx - client Cordis context providing `slots`.
 * @param {object} options - `store`.
 * @returns {Function} disposer releasing the registration.
 */
export function registerBundleConfiguration(ctx, options) {
  const { store, uiWorkspace, workspaces } = options;
  const injectFace = () => ({ store, uiWorkspace, workspaces });
  return ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
    name: PLUGIN_CONFIG_SLOT,
    key: PLUGIN_BUNDLE_KEY,
    inject: injectFace,
  }, DelegateConfigPage));
}

/**
 * Client plugin body.
 * @param {object} ctx - client Cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => injectStyles(globalThis.document), 'dsh-delegate: settings styles');
  const store = createStore({ api: createApi(), cleanup: cleanupProjection() });
  ctx.effect(() => () => store.dispose(), 'dsh-delegate: settings store');
  const navigation = {
    store,
    uiWorkspace: () => resolveUiWorkspace(ctx),
    workspaces: () => resolveWorkspaces(ctx),
  };
  ctx.effect(() => registerBundleConfiguration(ctx, navigation), 'dsh-delegate: bundle configuration');
  // NO standalone sidebar row for task records.
  //
  // `registerTasksNavigation` registers TWO entries at once — the content panel on `main` AND the
  // row on `sidebar.panellist` — so the row cannot be removed while the panel is kept by any
  // smaller change. Both are therefore not mounted: the operator reaches the task records through
  // the plugin's own settings page (`plugins.bundle.config` → 「任务记录」tab), which is the
  // single, already-shipped entry point, and the sidebar keeps ONLY the host's native workspace
  // tree (工作区 → TaskBridge → 隔离任务工作区 → 对话). The module stays exported and tested, so a
  // later host that wants the row back needs one line, not a rewrite.
  // The TaskBridge sidebar integration. The shell's workspace region stays the HOST's: this
  // registers only the published per-row child slot (`sidebar.workspaces.session.row.action`), so
  // every native row, name, order, search box, menu and action is exactly as shipped, and a
  // dispatched conversation gains one quiet marker inside its own native row.
  ctx.effect(() => registerSessionRowMarker(ctx, { store }), 'dsh-delegate: dispatched session marker');
}

/**
 * The host's own `sidebar.workspaces` entry, when this build can reach it.
 *
 * The shell keeps the shipped registration in its slot ledger, and a lower-priority entry can
 * render that component itself instead of re-implementing (or replacing) it. What is reachable
 * depends on the host: the shipped entry exposes no component through a published contract, so
 * this returns `null` unless a host offers one. `null` is the honest answer — the section is then
 * drawn alone, and the host browser is not claimed.
 * @param {object} ctx - client context.
 * @returns {Function | null} the shipped component, or null.
 */
export function resolveNativeWorkspaceEntry(ctx) {
  const get = ctx !== null && typeof ctx === 'object' ? ctx.get : null;
  if (typeof get !== 'function') return null;
  for (const name of ['uiWorkspace', 'workspaces']) {
    let service = null;
    try {
      service = get.call(ctx, name);
    } catch {
      service = null;
    }
    const entry = service?.nativeEntry ?? service?.WorkspaceBrowser ?? null;
    if (typeof entry === 'function') return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} */
function Badge({ tone = 'off', children }) {
  return <span className={`dshdg-badge dshdg-badge-${tone}`}>{children}</span>;
}

/** @param {object} props @returns {object} */
function Field({ label, hint, htmlFor, children }) {
  return (
    <div className="dshdg-field">
      {label === undefined ? null : <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint === undefined ? null : <span className="dshdg-hint">{hint}</span>}
    </div>
  );
}

/**
 * Integer input bounded by the host validator's limits.
 * @param {object} props - `label`, `value`, `min`, `max`, `onChange`, `hint`, `disabled`.
 * @returns {object} a numeric field.
 */
function IntegerField({ label, value, min, max, onChange, hint, disabled = false, id }) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={Number.isFinite(Number(value)) ? String(value) : ''}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? '' : Number(raw));
        }}
      />
    </Field>
  );
}

/**
 * Provider/model/effort selector triple.
 *
 * The effort list is derived from the *selected model's declared* capabilities,
 * never from a global list, so an unsupported combination cannot be produced by
 * the form in the first place. A model that declares no efforts shows only "不指定".
 * @param {object} props - `providers`, `value`, `onChange`, `idPrefix`, `modelCatalog`.
 * @returns {object} three fields.
 */
function SelectionFields(props) {
  const { providers, value, onChange, idPrefix } = props;
  const provider = providers.find((entry) => entry.id === value.providerId) ?? null;
  const models = provider === null ? [] : (provider.models ?? []);
  const model = models.find((entry) => entry.id === value.model) ?? null;
  const efforts = model === null ? [] : (model.efforts ?? []);
  return (
    <div className="dshdg-grid">
      <Field label="提供方" htmlFor={`${idPrefix}-provider`}>
        <select
          id={`${idPrefix}-provider`}
          value={value.providerId ?? ''}
          onChange={(event) => {
            onChange({ providerId: event.target.value === '' ? null : event.target.value, model: null, reasoningEffort: null });
          }}
        >
          <option value="">（未选择）</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name === '' ? entry.id : `${entry.name}（${entry.id}）`}</option>
          ))}
        </select>
      </Field>
      <Field label="模型" htmlFor={`${idPrefix}-model`}>
        <select
          id={`${idPrefix}-model`}
          value={value.model ?? ''}
          disabled={provider === null}
          onChange={(event) => {
            const nextModel = event.target.value === '' ? null : event.target.value;
            const declared = (models.find((entry) => entry.id === nextModel)?.efforts ?? []);
            const keep = value.reasoningEffort === null || declared.includes(value.reasoningEffort)
              ? value.reasoningEffort
              : null;
            onChange({ providerId: value.providerId ?? null, model: nextModel, reasoningEffort: keep });
          }}
        >
          <option value="">（未选择）</option>
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.id}</option>
          ))}
        </select>
      </Field>
      <Field
        label="推理强度"
        htmlFor={`${idPrefix}-effort`}
        hint={model === null
          ? '选择模型后显示该模型声明的推理强度'
          : (efforts.length === 0 ? '该模型未声明推理强度，只能不指定' : '仅列出该模型声明的能力')}
      >
        <select
          id={`${idPrefix}-effort`}
          value={value.reasoningEffort ?? EFFORT_UNSET}
          disabled={model === null || efforts.length === 0}
          onChange={(event) => {
            onChange({ ...value, reasoningEffort: event.target.value === EFFORT_UNSET ? null : event.target.value });
          }}
        >
          <option value={EFFORT_UNSET}>（不指定）</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>{`${EFFORT_LABELS[effort] ?? effort}（${effort}）`}</option>
          ))}
        </select>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object|null} the notice strip. */
function Notices({ store, notices }) {
  if (notices.length === 0) return null;
  return (
    <div className="dshdg-notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={String(notice.id)} className={`dshdg-notice dshdg-notice-${notice.level}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => store.dismissNotice(notice.id)} aria-label="关闭提示">关闭</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Authorization (rendered above the four areas)
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} the authorization card. */
function AuthorizationPanel({ store, snapshot }) {
  const enabled = snapshot.status?.delegation?.mode === 'switch'
    ? snapshot.status.delegation.authorized === true
    : snapshot.settings?.delegationEnabled === true;
  const busy = snapshot.loading?.delegationSwitch === true;
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-auth-title">
      <div className="dshdg-row">
        <h3 id="dshdg-auth-title">本机调用授权</h3>
        <span className="dshdg-spacer" />
        <Badge tone={enabled ? 'on' : 'off'}>{enabled ? '已开启' : '已关闭'}</Badge>
      </div>
      <div className="dshdg-row">
        <label className="dshdg-switch" htmlFor="dshdg-delegation-switch">
          <input
            id="dshdg-delegation-switch"
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy || snapshot.status === null}
            onChange={(event) => { void store.setDelegationEnabled(event.target.checked); }}
          />
          允许本机 MCP 调用 DSH 委派
        </label>
        <span className="dshdg-spacer" />
        <span className="dshdg-hint">{busy ? '正在更新…' : (enabled ? '关闭后会拒绝新任务并停止运行中的任务' : '关闭状态会拒绝所有委派请求')}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// API management
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} the API management panel. */
function ProvidersPanel({ store, snapshot }) {
  const providers = snapshot.draft?.providers ?? [];
  const selectedIds = new Set(providers.map((provider) => provider.id));
  const available = (snapshot.nativeProviders ?? []).filter((provider) => !selectedIds.has(provider.id));
  const [candidateId, setCandidateId] = useState('');
  const nativeProviders = snapshot.nativeProviders ?? [];

  function isUsed(id) {
    const draft = snapshot.draft ?? {};
    const selections = [draft.worker, ...(draft.presets ?? []).map((preset) => preset.worker)];
    for (const block of Object.values(draft.projectOverrides ?? {})) {
      selections.push(block?.worker);
    }
    return selections.some((selection) => selection?.providerId === id);
  }

  return (
    <div className="dshdg-panel">
      <div className="dshdg-row">
        <Field label="DSH 已启用的接口" htmlFor="dshdg-native-provider">
          <select id="dshdg-native-provider" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}>
            <option value="">（选择已有接口）</option>
            {available.map((provider) => <option key={provider.id} value={provider.id}>{`${provider.name} (${provider.id})`}</option>)}
          </select>
        </Field>
        <button
          type="button"
          className="dshdg-primary"
          disabled={candidateId === ''}
          onClick={() => {
            const provider = nativeProviders.find((entry) => entry.id === candidateId);
            if (provider === undefined) return;
            store.editDraft((draft) => {
              if (draft.providers.some((entry) => entry.id === provider.id)) return;
              draft.providers.push({
                id: provider.id,
                name: provider.name,
                source: 'native',
                protocol: null,
                baseUrl: null,
                credentialRef: null,
                models: (provider.models ?? []).map((model) => ({ ...model, efforts: [...(model.efforts ?? [])] })),
              });
            });
            setCandidateId('');
          }}
        >
          添加所选接口
        </button>
        <button type="button" disabled={snapshot.loading?.nativeProviders === true} onClick={() => { void store.loadNativeProviders(); }}>
          {snapshot.loading?.nativeProviders === true ? '刷新中…' : '刷新接口列表'}
        </button>
      </div>
      {snapshot.nativeProvidersError ? <p className="dshdg-fail">{snapshot.nativeProvidersError}</p> : null}
      {nativeProviders.length === 0 ? <p className="dshdg-muted">DSH 当前没有可选的已启用接口。先在 DSH 的模型设置中配置并启用接口。</p> : null}
      {providers.length === 0 ? <p className="dshdg-muted">尚未选择委派可用的接口。</p> : null}
      {providers.map((provider) => {
        const current = nativeProviders.find((entry) => entry.id === provider.id);
        const legacy = provider.source !== 'native';
        const used = isUsed(provider.id);
        return (
          <div className="dshdg-item" key={provider.id}>
            <div className="dshdg-item-head">
              <strong>{provider.name}</strong>
              <span className="dshdg-mono dshdg-faint">{provider.id}</span>
              <Badge tone={legacy ? 'warn' : 'on'}>{legacy ? '旧版自定义接口' : 'DSH 接口'}</Badge>
              <span className="dshdg-spacer" />
              {current !== undefined && !legacy ? (
                <button
                  type="button"
                  disabled={snapshot.loading?.nativeProviders === true || (current.models ?? []).length === 0}
                  onClick={() => store.editDraft((draft) => {
                    const target = draft.providers.find((entry) => entry.id === provider.id);
                    if (target === undefined) return;
                    target.name = current.name;
                    target.models = current.models.map((model) => ({ ...model, efforts: [...(model.efforts ?? [])] }));
                  })}
                >
                  同步模型
                </button>
              ) : null}
              <button
                type="button"
                className="dshdg-danger"
                disabled={used}
                title={used ? '先将执行、审查和预设中的该接口改为其他接口' : undefined}
                onClick={() => store.editDraft((draft) => { draft.providers = draft.providers.filter((entry) => entry.id !== provider.id); })}
              >
                移除
              </button>
            </div>
            {legacy ? <p className="dshdg-hint">此接口来自旧版插件配置。新接口请从上方 DSH 列表选择。</p> : null}
            {current?.error ? <p className="dshdg-fail">{current.error}</p> : null}
            <div className="dshdg-list">
              {(current?.models ?? provider.models ?? []).map((model) => (
                <div className="dshdg-item-head" key={model.id}>
                  <span className="dshdg-mono">{model.id}</span>
                  <span className="dshdg-spacer" />
                  <span className="dshdg-hint">{(model.efforts ?? []).map((effort) => EFFORT_LABELS[effort] ?? effort).join('、') || '未声明思考强度'}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution settings
// ---------------------------------------------------------------------------

/**
 * Read-only view of the configuration a job would actually use.
 * @param {object} props - `label`, `effective`, `note`.
 * @returns {object} a description list.
 */
function EffectiveSummary({ label, effective, note }) {
  const worker = effective?.worker ?? {};
  return (
    <div className="dshdg-card">
      <h4>{label}</h4>
      <dl className="dshdg-kv">
        <dt>执行提供方</dt>
        <dd className="dshdg-mono">{worker.providerId ?? worker.providerRoute ?? '（未配置）'}</dd>
        <dt>执行模型</dt>
        <dd className="dshdg-mono">{worker.model ?? '（未配置）'}</dd>
        <dt>执行推理强度</dt>
        <dd className="dshdg-mono">{worker.reasoningEffort ?? '（不指定）'}</dd>
        <dt>执行时长</dt>
        <dd>
          {effective?.worker?.executionTimeoutSeconds === null || effective?.worker?.executionTimeoutSeconds === undefined
            ? '不设上限（只由你主动取消）'
            : `本任务显式上限 ${formatDuration(effective.worker.executionTimeoutSeconds * 1000)}`}
        </dd>
        <dt>最大并发</dt>
        <dd>{worker.maxParallelism ?? '—'}</dd>
        <dt>工作区隔离</dt>
        <dd>{ISOLATION_LABELS[worker.isolation] ?? worker.isolation ?? '—'}</dd>
        <dt>对话</dt>
        <dd>{CONVERSATION_POLICY_LABEL}</dd>
        <dt>静默监控</dt>
        <dd>
          {effective?.monitoring === null || effective?.monitoring === undefined
            ? '未采集到'
            : [
              `自检 ${monitoringText(effective.monitoring.selfCheckSeconds)}`,
              `运行进度检查 ${monitoringText(effective.monitoring.attentionSeconds)}`,
            ].join(' · ')}
        </dd>
      </dl>
      {note === undefined ? null : <p className="dshdg-hint">{note}</p>}
    </div>
  );
}

/**
 * Presets, non-secret export and project overrides.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the sharing card.
 */
function PresetsCard({ store, snapshot }) {
  const draft = snapshot.draft;
  const presets = draft?.presets ?? [];
  const overrides = draft?.projectOverrides ?? {};
  const [presetName, setPresetName] = useState('');
  const [presetId, setPresetId] = useState('');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [exportCopied, setExportCopied] = useState('');
  const [overridePath, setOverridePath] = useState('');
  const [overrideJson, setOverrideJson] = useState('');
  const [overrideError, setOverrideError] = useState('');
  const [editingPath, setEditingPath] = useState('');

  const exportText = useMemo(() => (draft === null ? '' : exportDocument(draft)), [draft]);

  return (
    <div className="dshdg-card">
      <h4>预设、导出与项目覆盖</h4>
      <p className="dshdg-hint">
        预设保存执行设置，导出的配置不含密钥。
        正在运行的任务保留它自己的生效快照，之后的修改不会改写历史。
      </p>

      <div className="dshdg-row">
        <input
          type="text"
          aria-label="预设名称"
          placeholder="预设标识，例如 fast-local"
          value={presetId}
          onChange={(event) => setPresetId(event.target.value.trim().toLowerCase())}
        />
        <input
          type="text"
          aria-label="预设显示名"
          placeholder="显示名"
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
        />
        <button
          type="button"
          disabled={presetId === ''}
          onClick={() => {
            store.editDraft((current) => {
              const existing = current.presets.find((entry) => entry.id === presetId);
              const snapshotWorker = clone(current.worker);
              if (existing === undefined) {
                current.presets.push({
                  id: presetId,
                  name: presetName === '' ? presetId : presetName,
                  worker: snapshotWorker,
                });
              } else {
                existing.name = presetName === '' ? existing.name : presetName;
                existing.worker = snapshotWorker;
              }
            });
            setPresetId('');
            setPresetName('');
          }}
        >
          用当前设置保存预设
        </button>
      </div>

      {presets.length === 0 ? <p className="dshdg-faint">还没有预设。</p> : (
        <div className="dshdg-list">
          {presets.map((preset) => (
            <div className="dshdg-item" key={preset.id}>
              <div className="dshdg-item-head">
                <strong>{preset.name}</strong>
                <span className="dshdg-mono dshdg-faint">{preset.id}</span>
                <span className="dshdg-spacer" />
                <button
                  type="button"
                  onClick={() => {
                    store.editDraft((current) => {
                      if (preset.worker !== null && preset.worker !== undefined) current.worker = { ...preset.worker };
                    });
                  }}
                >
                  应用到草稿
                </button>
                <button
                  type="button"
                  className="dshdg-danger"
                  onClick={() => {
                    store.editDraft((current) => {
                      current.presets = current.presets.filter((entry) => entry.id !== preset.id);
                    });
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Field label="导出（非敏感）" htmlFor="dshdg-export" hint="复制这段文本即可备份或在另一台机器恢复。">
        <textarea id="dshdg-export" readOnly rows={6} value={exportText} />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          onClick={async () => {
            try {
              await globalThis.navigator?.clipboard?.writeText(exportText);
              setExportCopied('已复制');
            } catch {
              setExportCopied('无法访问剪贴板，请手动复制');
            }
          }}
        >
          复制导出内容
        </button>
        {exportCopied === '' ? null : <span className="dshdg-hint">{exportCopied}</span>}
        <span className="dshdg-spacer" />
        <button
          type="button"
          onClick={async () => {
            try {
              const text = await globalThis.navigator?.clipboard?.readText?.();
              if (typeof text === 'string') setImportText(text);
            } catch {
              setExportCopied('无法访问剪贴板，请手动粘贴');
            }
          }}
        >
          从剪贴板粘贴
        </button>
      </div>

      <Field
        label="导入（覆盖草稿，保存后才生效）"
        htmlFor="dshdg-import"
        hint="只接受本插件导出的非敏感文档；包含密钥的字段会被宿主拒绝。"
      >
        <textarea
          id="dshdg-import"
          rows={6}
          value={importText}
          onChange={(event) => { setImportText(event.target.value); setImportError(''); }}
        />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          onClick={() => {
            try {
              const parsed = JSON.parse(importText);
              const next = draftFromSettings(parsed);
              store.editDraft((current) => {
                current.providers = next.providers;
                current.worker = next.worker;
                current.authorization = next.authorization;
                current.projectOverrides = next.projectOverrides;
                current.presets = next.presets;
              });
              setImportError('');
            } catch (error) {
              setImportError(`无法解析：${String(error?.message ?? error).slice(0, 160)}`);
            }
          }}
          disabled={importText.trim() === ''}
        >
          解析并应用到草稿
        </button>
        {importError === '' ? null : <span className="dshdg-fail">{importError}</span>}
      </div>

      <h4>项目覆盖</h4>
      <p className="dshdg-hint">为某个绝对路径单独指定执行/审查覆盖；任务生效值会显示实际用了哪一层。</p>
      {Object.keys(overrides).length === 0 ? <p className="dshdg-faint">还没有项目覆盖。</p> : (
        <div className="dshdg-list">
          {Object.entries(overrides).map(([path, block]) => (
            <div className="dshdg-item" key={path}>
              <div className="dshdg-item-head">
                <span className="dshdg-mono">{path}</span>
                <span className="dshdg-spacer" />
                <button
                  type="button"
                  onClick={() => {
                    setEditingPath(path);
                    setOverridePath(path);
                    setOverrideJson(`${JSON.stringify(block, null, 2)}\n`);
                    setOverrideError('');
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="dshdg-danger"
                  onClick={() => {
                    store.editDraft((current) => {
                      const copy = { ...current.projectOverrides };
                      delete copy[path];
                      current.projectOverrides = copy;
                    });
                    if (editingPath === path) setEditingPath('');
                  }}
                >
                  删除
                </button>
              </div>
              <pre className="dshdg-pre">{boundedText(block, 4000)}</pre>
            </div>
          ))}
        </div>
      )}
      <Field
        label={editingPath === '' ? '新增覆盖：绝对路径' : `编辑覆盖：${editingPath}`}
        htmlFor="dshdg-override-path"
      >
        <input
          id="dshdg-override-path"
          type="text"
          value={overridePath}
          readOnly={editingPath !== ''}
          placeholder="C:\\work\\project"
          onChange={(event) => setOverridePath(event.target.value)}
        />
      </Field>
      <Field
        label="执行覆盖内容（JSON）"
        htmlFor="dshdg-override-json"
        hint={'例如 {"worker":{"model":"deepseek-chat","reasoningEffort":"high"}}'}
      >
        <textarea
          id="dshdg-override-json"
          rows={5}
          value={overrideJson}
          onChange={(event) => { setOverrideJson(event.target.value); setOverrideError(''); }}
        />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          disabled={overridePath.trim() === ''}
          onClick={() => {
            let parsed;
            try {
              parsed = overrideJson.trim() === '' ? {} : JSON.parse(overrideJson);
            } catch (error) {
              setOverrideError(`无法解析：${String(error?.message ?? error).slice(0, 160)}`);
              return;
            }
            const unknown = Object.keys(parsed).filter((key) => key !== 'worker');
            if (unknown.length > 0) {
              setOverrideError(`不支持的字段：${unknown.join('、')}`);
              return;
            }
            setOverrideError('');
            const path = overridePath.trim().replace(/[\\/]+$/, '');
            store.editDraft((current) => {
              const copy = { ...current.projectOverrides };
              if (editingPath !== '' && editingPath !== path) delete copy[editingPath];
              copy[path] = parsed;
              current.projectOverrides = copy;
            });
            setEditingPath('');
            setOverrideJson('');
            setOverridePath('');
          }}
        >
          {editingPath === '' ? '添加覆盖' : '保存覆盖'}
        </button>
        {editingPath === '' ? null : (
          <button type="button" onClick={() => { setEditingPath(''); setOverrideJson(''); setOverridePath(''); setOverrideError(''); }}>
            取消编辑
          </button>
        )}
        {overrideError === '' ? null : <span className="dshdg-fail">{overrideError}</span>}
      </div>
    </div>
  );
}

/**
 * Monitoring controls: the start-elapsed local self-check, the commander delivery
 * progress check, and the repeated-failure reminder.
 *
 * `selfCheckSeconds` runs one read-only local inspection after execution starts
 * (default 10 minutes; active work does not postpone it). `attentionSeconds` reports a
 * run progress check to the commander when nothing new has been returned for that span
 * (default 40 minutes; internal activity, heartbeats, and self-checks do not reset it).
 * Neither reminder is a total-runtime cap and neither can cancel, restart, or resubmit
 * a task.
 *
 * What this card deliberately does NOT do: it does not submit work, does not read a
 * task, does not call a model, and does not create a monitoring process of its own. It
 * edits numbers that ride the ordinary settings draft, and everything it says about the
 * behaviour is a statement about the engine, not a control here. Neither reminder can
 * cancel, restart or resubmit a task.
 *
 * Units: the operator thinks in minutes, the document stores whole seconds. Each
 * duration field converts on the way in and out (`minutesToSeconds` / `secondsToMinutes`),
 * so a stored value of 600 s shows as 10 and a value of 90 s shows as 1.5 rather than
 * being rounded into a different setting. `0` is a real, expressible decision — "this
 * reminder is off" — and is both displayed and written as `0`.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the monitoring card.
 */
function MonitoringCard({ store, snapshot }) {
  const draft = snapshot.draft;
  // The RAW block is what the inputs display and what the save validates. Binding the
  // inputs to the display-normalized block instead would make a cleared field
  // immediately re-render as the documented default, hiding the edit.
  const raw = monitoringDraftOf(draft);
  const saved = monitoringOf(snapshot.settings);
  const problems = precheckMonitoring(raw);
  const dirty = raw.selfCheckSeconds !== saved.selfCheckSeconds
    || raw.attentionSeconds !== saved.attentionSeconds
    || raw.repeatFailureThreshold !== saved.repeatFailureThreshold;

  /**
   * Write one field, converting minutes back to the stored unit. The block is spread
   * from the RAW draft, not from `monitoringOf`: normalizing here would rewrite the
   * operator's other half-typed fields (for example a cleared count) back to their
   * defaults on every keystroke.
   * @param {'selfCheckSeconds' | 'attentionSeconds'} field - target field.
   * @param {unknown} rawMinutes - operator input, in minutes.
   * @returns {void}
   */
  const edit = (field, rawMinutes) => {
    store.editDraft((current) => {
      current.monitoring = { ...monitoringDraftOf(current), [field]: minutesToSeconds(rawMinutes) };
    });
  };

  /**
   * Write the repeated-failure count. A blank field becomes `''`, which the precheck
   * reports rather than turning into an accidental default.
   * @param {unknown} value - operator input, a count.
   * @returns {void}
   */
  const editFailureCount = (value) => {
    store.editDraft((current) => {
      current.monitoring = {
        ...monitoringDraftOf(current),
        repeatFailureThreshold: value === '' ? '' : Number(value),
      };
    });
  };

  /**
   * One duration control, in minutes, with `0` meaning "off".
   *
   * Extracted so the two durations cannot drift apart in units, bounds or wording.
   * @param {object} props - `id`, `label`, `field`, `value`, `min`, `max`, `hint`.
   * @returns {object} the field.
   */
  const DurationField = ({ id, label, field, value, min, max, hint }) => {
    const minutes = Number.isFinite(secondsToMinutes(value)) ? secondsToMinutes(value) : '';
    return (
      <Field
        label={label}
        htmlFor={id}
        hint={`${min / 60}–${max / 60} 分钟，填 0 表示关闭；存成整秒（当前 ${value === '' ? '未填' : (Number(value) === 0 ? '已关闭' : `${value} 秒`) }）${hint === undefined ? '' : `；${hint}`}`}
      >
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={max / 60}
          step={0.5}
          value={String(minutes)}
          onChange={(event) => {
            const next = event.target.value;
            // A blank field stays blank (the precheck reports it) instead of becoming
            // the default or an accidental zero.
            edit(field, next === '' ? '' : next);
          }}
        />
      </Field>
    );
  };

  return (
    <div className="dshdg-card" data-dshdg-monitoring="">
      <h4>进度与静默监控</h4>
      <p className="dshdg-hint">
        这两个时长量的是<strong>两件不同的事</strong>。
        <strong>程序自检</strong>从 DSH <strong>真正开始执行</strong>算起：排队、创建会话、请求受理都不算；
        模型和工具再活跃也不会推迟它，整个运行只自检一次。
        <strong>运行进度检查</strong>从<strong>最近一次真正回传给派工方的新成果</strong>算起（第一段基准是运行开始），
        不是"没有进展"，也不是运行总时长：DSH 内部的模型输出、思考步骤、工具调用与结果，心跳、空轮询、页面刷新、
        等待授权或等待问题答复、重复失败提醒、检查本身，以及本机自检的结论，<strong>都不算新成果</strong>。
        当前等待通道只在任务结束时交付成果，所以运行一开始就长时间没有新交付的任务，会在到达你设定的「运行进度检查」间隔时被提醒一次。
        <strong>这些检查完全在本机进行，不会调用任何大模型，也不消耗 token；提醒只是提示，绝不取消、重启或重新提交任务。</strong>
        任一间隔填 <strong>0</strong> 即关闭对应提醒，两项可以分别关闭。
      </p>
      <div className="dshdg-grid">
        <DurationField
          id="dshdg-monitoring-selfcheck"
          label="程序自检间隔（分钟）"
          field="selfCheckSeconds"
          value={raw.selfCheckSeconds}
          min={LIMITS.selfCheckSecondsMin}
          max={LIMITS.selfCheckSecondsMax}
          hint="DSH 开始执行后满这么久，本机只读检查一次，不需要你在看页面"
        />
        <DurationField
          id="dshdg-monitoring-attention"
          label="运行进度检查（分钟）"
          field="attentionSeconds"
          value={raw.attentionSeconds}
          min={LIMITS.attentionSecondsMin}
          max={LIMITS.attentionSecondsMax}
          hint="从最近一次真实回传的新成果起算；两项都开启时必须大于自检间隔"
        />
        <Field
          label="重复失败提醒（次）"
          htmlFor="dshdg-monitoring-repeat"
          hint={`同一工具、同一操作、同一失败连续这么多次时提醒一次；${LIMITS.repeatFailureThresholdMin} 表示关闭（当前 ${raw.repeatFailureThreshold === '' ? '未填' : `${raw.repeatFailureThreshold} 次`}）`}
        >
          <input
            id="dshdg-monitoring-repeat"
            type="number"
            inputMode="numeric"
            min={LIMITS.repeatFailureThresholdMin}
            max={LIMITS.repeatFailureThresholdMax}
            step={1}
            value={String(raw.repeatFailureThreshold)}
            onChange={(event) => { editFailureCount(event.target.value); }}
          />
        </Field>
      </div>
      {problems.length === 0 ? null : <p className="dshdg-fail">{problems.join('；')}</p>}
      <ul className="dshdg-hint">
        <li>「没有新成果回传」本身不等于失败：插件不会因为安静、也不会因为单个工具跑得久就判定任务失败。</li>
        <li>只有<strong>连续</strong>没有新成果回传、并且超过「运行进度检查」之后，才会把这件事报告给派工方核对一次目标；同一段间隔最多报告一次，真实回传新成果后会重新计时。</li>
        <li>提醒不依赖任务总运行时长：跑上几小时但一直在回传新成果，就不会有提醒；也没有「总执行超时」这种按总时长中止的设置。</li>
        <li>重复失败提醒与上面两个间隔<strong>互相独立</strong>：它数的是同一操作连续失败了几次，而不是多久没有回传，所以正在忙碌地反复失败也会被提醒。它只提醒一次，不会自动取消任务或更换模型。</li>
        <li>修改只影响<strong>之后新提交</strong>的任务；已经运行的任务保留它开始时的那份间隔快照。</li>
        <li>程序自检只读取本机已有的事实（任务是否还在、当前阶段、有没有待决定的调用、正在跑哪个工具，以及"未回传多久"和"DSH 正在做什么"），不读取代码差异，也不会读取你的文件内容；即使没有人正在等待，任务详情也能看到它已做的自检。读到自检结论只是读诊断，不会重置运行进度检查的计时。</li>
      </ul>
      <div className="dshdg-row" data-dshdg-monitoring-status="">
        <span className="dshdg-hint" role="status" aria-live="polite">
          {dirty
            ? '与已保存的值不同，正在自动保存（与整份设置走同一个串行保存队列）。'
            : `已保存：自检 ${saved.selfCheckSeconds} 秒，运行进度检查 ${saved.attentionSeconds} 秒。`}
        </span>
      </div>
      <p className="dshdg-hint">
        这几项也是整份设置文档的一部分，随其它设置一起自动保存；没有单独的保存按钮。
      </p>
    </div>
  );
}

/**
 * The operator's control over the Agent Teams default for NEW tasks.
 *
 * This is NOT DSH's global switch and it does not pretend to be: it decides only what a
 * NEW delegated task does when its dispatcher stated no per-task choice. Three facts the
 * card states, because each one is a place an operator could otherwise be surprised:
 *
 *  1. a per-task choice from the dispatcher always wins over this default;
 *  2. a follow-up (`continueFromTaskId`) keeps the mode of the task it continues, so this
 *     default never flips a chain mid-way;
 *  3. it changes only later submissions — a task that already started keeps the decision
 *     it froze at admission.
 *
 * A choice that CANNOT be applied (an older DSH without the service) is refused before
 * the worker is prompted, and the task detail says why; the card says so instead of
 * implying that "on" always means "on".
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the agent-teams card.
 */
function AgentTeamsCard({ store, snapshot }) {
  const draft = snapshot.draft;
  const raw = executionOf(draft).agentTeamsDefault;
  const saved = executionOf(snapshot.settings).agentTeamsDefault;
  const dirty = raw !== saved;
  const enabled = raw === true;
  /**
   * Write the switch as a discrete decision.
   *
   * A checkbox is one decision, not typing, so the draft edit is saved immediately
   * instead of waiting out the text debounce. The shared save queue keeps it serialized
   * with any other pending edit.
   * @param {boolean} next - the new default.
   * @returns {void}
   */
  const edit = (next) => {
    store.editDraft((current) => {
      current.execution = { ...executionOf(current), agentTeamsDefault: next };
    }, { immediate: true });
  };
  return (
    <div className="dshdg-card" data-dshdg-agent-teams="">
      <h4>智能体协作（Agent Teams）</h4>
      <p className="dshdg-hint">
        这一项只决定<strong>新派工在看不出单次选择时</strong>用哪种协作方式，不是 DSH 的全局开关：
        插件只写这条任务自己的会话，不会打开 DSH 的全局「默认开启」，也不会影响你在 DSH 里手动改过设置的会话。
      </p>
      <label className="dshdg-row" htmlFor="dshdg-agent-teams-default">
        <input
          id="dshdg-agent-teams-default"
          type="checkbox"
          checked={enabled}
          onChange={(event) => { edit(event.target.checked); }}
        />
        <span>新任务默认开启智能体协作</span>
      </label>
      <p className="dshdg-hint">
        当前已保存：<strong>{saved ? '新任务默认开启' : '新任务默认关闭'}</strong>。
        升级安装和首次安装都是<strong>关闭</strong>，插件不会替你打开。
      </p>
      <ul className="dshdg-hint">
        <li>派工方在单次派工里明确开/关时，<strong>以单次选择为准</strong>，这里的默认不生效。</li>
        <li>只影响<strong>之后新提交</strong>的任务；已经开始的任务保留它开始时冻结的选择，改这里不会改动它。</li>
        <li>
          续接已有任务（<code>continueFromTaskId</code>）且没有新的单次选择时：
          原任务记录过协作选择就<strong>沿用那条记录</strong>；
          原任务没有记录过（旧记录），插件<strong>不套用这里的默认、也不写入任何协作值</strong>，
          那条原生会话当前的选择保持不变。
        </li>
        <li>
          当前 DSH 没有智能体协作能力时，<strong>明确的开/关都会在发送提示词之前被拒绝并写明原因</strong>，
          不会悄悄按会话原有模式跑起来。只有「默认隐式关闭」这一种情况会继续执行，
          并如实报告<strong>未应用</strong>（不是「已关闭」），这样旧版本的普通派工仍然可用。
        </li>
        <li>一个外层任务始终只占<strong>一个会话和一个并发名额</strong>：子智能体由 DSH 大会话内部管理，不会额外占用本插件的名额。</li>
        <li>取消任务照常可用：随时可以取消运行中的任务，协作选择不影响取消。</li>
      </ul>
      <div className="dshdg-row" data-dshdg-agent-teams-status="">
        <span className="dshdg-hint" role="status" aria-live="polite">
          {dirty
            ? '与已保存的值不同，正在自动保存（与整份设置走同一个串行保存队列）。'
            : `已保存：新任务默认${saved ? '开启' : '关闭'}智能体协作。`}
        </span>
      </div>
    </div>
  );
}

/** @param {object} props @returns {object} the execution settings panel. */
function ExecutionPanel({ store, snapshot }) {
  const draft = snapshot.draft;
  const providers = draft?.providers ?? [];
  const worker = draft?.worker ?? {};
  // There is no conversation-mode control any more: the policy is per submission
  // (new by default, continue only the task named by `continueFromTaskId`), so the
  // panel states it instead of offering a setting that no longer exists.
  // Global preview only: which project a task will run in is decided at submit
  // time, so previewing against an arbitrary override key would be a guess.
  const preview = draft === null ? null : previewEffective(draft, null);
  const served = snapshot.catalog?.effective ?? null;
  if (draft === null) return <p className="dshdg-faint">正在读取设置…</p>;
  return (
    <div className="dshdg-panel">
      <SelectionFields
        providers={providers}
        idPrefix="dshdg-worker"
        value={{ providerId: worker.providerId ?? null, model: worker.model ?? null, reasoningEffort: worker.reasoningEffort ?? null }}
        onChange={(next) => {
          // Provider / model / effort are SELECTS: each change is one discrete
          // decision, so it is saved at once instead of waiting out the text debounce.
          store.editDraft((current) => {
            current.worker.providerId = next.providerId;
            current.worker.model = next.model;
            current.worker.reasoningEffort = next.reasoningEffort;
          }, { immediate: true });
        }}
      />
      <div className="dshdg-grid">
        <IntegerField
          id="dshdg-worker-parallelism"
          label="最大并发"
          value={worker.maxParallelism}
          min={LIMITS.maxParallelismMin}
          max={LIMITS.maxParallelismMax}
          hint={`${LIMITS.maxParallelismMin}–${LIMITS.maxParallelismMax}，超出会被拒绝而不是自动调整。限制的是本插件同时接纳的派工数：按到达顺序争取名额，超出会被拒绝而不是排队；准备中、运行中和等待授权的任务都算占用，执行器确认结束后才让位。每个独立工作包各占一个名额；同一来源的隔离任务可开成独立会话并行，共享目录一次只跑一个；智能体协作的子智能体只在会话内部，不计入名额。`}
          onChange={(value) => {
            store.editDraft((current) => { current.worker.maxParallelism = value; });
          }}
        />
        <Field label="工作区隔离" htmlFor="dshdg-worker-isolation" hint="默认独立工作树；共享工作区需要你明确选择。两种模式均要求目标目录为已初始化且至少有 1 次 commit 的 Git 仓库根目录。">
          <select
            id="dshdg-worker-isolation"
            value={worker.isolation ?? ISOLATION_MODES[0]}
            onChange={(event) => {
              // A SELECT is one discrete decision: save it at once instead of waiting
              // for the text debounce.
              store.editDraft((current) => { current.worker.isolation = event.target.value; }, { immediate: true });
            }}
          >
            {ISOLATION_MODES.map((mode) => (
              <option key={mode} value={mode}>{ISOLATION_LABELS[mode]}</option>
            ))}
          </select>
        </Field>
        <Field
          label="对话"
          htmlFor="dshdg-conversation-policy"
          hint="固定的按任务策略：每个新提交在执行目录对应的 Workspace 里新开一条会话；只有显式带 continueFromTaskId 的跟进任务才续接那一条会话。"
        >
          <p id="dshdg-conversation-policy" className="dshdg-hint">
            {CONVERSATION_POLICY_LABEL}
          </p>
        </Field>
      </div>
      <p className="dshdg-hint">
        任务<strong>没有总执行时长上限</strong>：不会因为跑得久被自动中止，只有你主动取消才会停止。
        长时间没有进展由下面的「进度与静默监控」提醒你判断，提醒本身不会取消、重启或重新提交任务。
        旧版本存下的「超时」值仍会被读取，但不再限制新任务。
      </p>
      <p className="dshdg-hint">
        不会自动回退到别的模型，也不会隐式使用 Harness 默认模型：选中的组合不可路由时任务直接拒绝。
      </p>
      <p className="dshdg-hint">
        目录级的「复用上一对话」设置已移除：它曾经让同目录的第二个任务自动接续上一次会话，现在不会发生。
        需要续接时由派工方在 <code>delegate_submit</code> 里带上 <code>continueFromTaskId</code>，
        指向要继续的那条任务历史；隔离工作树的跟进任务必须回到同一棵工作树，否则会被拒绝。
      </p>
      {preview === null ? null : (
        <EffectiveSummary
          label="保存后生效（当前草稿预览）"
          effective={preview}
          note={preview.applied.length === 0
            ? '未命中项目覆盖。'
            : `已应用：${preview.applied.join('；')}`}
        />
      )}
      <MonitoringCard store={store} snapshot={snapshot} />
      <AgentTeamsCard store={store} snapshot={snapshot} />
      {served === null ? (
        <p className="dshdg-faint">宿主尚未回报实际生效值（模型目录不可用或尚未加载）。</p>
      ) : (
        <EffectiveSummary
          label="宿主当前实际生效"
          effective={served}
          note="这是任务真正会用的配置快照；模型目录无法解析时会在这里显示拒绝原因。"
        />
      )}
      <PresetsCard store={store} snapshot={snapshot} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task records
// ---------------------------------------------------------------------------

/**
 * One readable sentence about a task's Agent Teams decision, for the detail panel.
 *
 * The THREE facts are kept apart here on purpose, because collapsing them is how a
 * record starts lying about what happened:
 *
 *  * the CHOICE that was frozen on the task (`agentTeams`) and where it came from
 *    (`agentTeamsOrigin`) — a per-task request, an inherited chain, or the operator's
 *    new-task default;
 *  * what DSH actually CONFIRMED (`team.applied` / `team.enabled`);
 *  * why it could not be applied (`team.reason`), which is a refusal, not a downgrade.
 *
 * A record written before the origin existed has no origin and is reported as such
 * rather than being attributed to anybody.
 * @param {object} task - task view.
 * @returns {string} the line.
 */
function teamLine(task) {
  const requested = typeof task?.agentTeams === 'boolean' ? task.agentTeams : null;
  if (requested === null) {
    // The honest "nothing was decided here" answer. It is what a continuation of a task
    // that recorded no choice looks like: the plugin applied nothing, so the native
    // Session keeps whatever mode it already had. Saying "off" would be a claim nobody
    // observed.
    return '本次未指定协作方式：原任务没有记录过选择，插件没有写入任何协作值，该会话保持它当前的选择。';
  }
  const origin = AGENT_TEAMS_ORIGIN_LABELS[task.agentTeamsOrigin] ?? '来源未记录';
  const choice = `选择「${requested ? '开启' : '关闭'}」· ${origin}`;
  const team = task.team;
  if (team === null || team === undefined) {
    return `${choice}；本次运行尚未回报实际生效结果。`;
  }
  if (team.applied === true) {
    return `${choice}；DSH 已确认本次会话实际为「${team.enabled === true ? '开启' : '关闭'}」。`;
  }
  if (team.reason === 'service-absent-default-off') {
    // The one case that proceeds without the capability: the operator's implicit off
    // default on a host that has no agent-teams service. It must NOT read as "off".
    return `${choice}；当前 DSH 没有智能体协作能力，未应用（也没有声称该会话已关闭），任务照常执行。`;
  }
  const reason = typeof team.reason === 'string' && team.reason !== '' ? team.reason : '未说明原因';
  return `${choice}；未能生效（${reason}），该任务不会在旧模式下继续执行。`;
}

/**
 * The full recorded review note of one task, expandable and copyable.
 *
 * The note itself is never shortened — the list shows a preview, this shows the whole text —
 * and a copy that fails says so instead of pretending the clipboard holds it.
 *
 * A COMPACT answer (`noteOmitted`) carries the length but not the body. That case used to
 * dead-end in a sentence that told the operator to read the note "somewhere", with no way
 * to do it — the "查看完整审查意见" click appeared to do nothing. It now reads the whole
 * task through the store and shows the body, with the loading and refusal states visible.
 * @param {object} props - `task`, `store`.
 * @returns {object} the detail control.
 */
function ReviewNoteDetail({ task, store }) {
  const [copyState, setCopyState] = useState(null);
  const [readState, setReadState] = useState('idle');
  const preview = reviewNotePreview(task);
  const noteBody = typeof task?.hostAcceptance?.note === 'string' ? task.hostAcceptance.note : '';
  /**
   * Read the whole task so a compact answer's omitted note becomes readable here.
   * @returns {Promise<void>} resolves after the read (the store publishes the result).
   */
  const readFull = async () => {
    if (store === undefined || store === null || preview === null) return;
    setReadState('loading');
    const outcome = await store.openTask(task.taskId);
    setReadState(outcome?.ok === true ? 'loaded' : 'failed');
  };
  if (preview === null) return '未记录（插件不会自行验收）';
  if (preview.omitted === true) {
    // The body is not in this task object. `store.openTask` fetches the full task, whose
    // `hostAcceptance.note` is the whole text; the same object is re-read on the next
    // render because the page subscribes to the store.
    return (
      <div className="dshdg-note" data-dshdg-note-omitted="">
        <div className="dshdg-row">
          <span className="dshdg-hint">{`审查意见已保存（${preview.chars} 字符），此处省略正文。`}</span>
          <span className="dshdg-spacer" />
          <button type="button" disabled={readState === 'loading'} onClick={() => { void readFull(); }}>
            {readState === 'loading' ? '读取中…' : '读取完整正文'}
          </button>
        </div>
        {readState === 'failed' ? (
          <p className="dshdg-warn">
            {`读取完整审查意见失败（${describeError(store?.getSnapshot?.().taskDetailError ?? null)}）。可再点一次重试。`}
          </p>
        ) : null}
        {readState === 'loading' ? <p className="dshdg-hint">正在读取完整审查意见…</p> : null}
      </div>
    );
  }
  if (preview.chars === 0) return '（无审查意见正文）';
  const full = noteBody;
  const copy = () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      setCopyState('复制失败：浏览器不支持写入剪贴板，请手动选择文本。');
      return;
    }
    void Promise.resolve().then(() => clipboard.writeText(full)).then(
      () => { setCopyState('已复制完整审查意见'); },
      () => { setCopyState('复制失败：浏览器未允许写入剪贴板，请手动选择文本。'); },
    );
  };
  return (
    // The FULL body is rendered in one step: no second "展开全文" click. The operator
    // already asked for the whole note by opening the detail from that button.
    <div className="dshdg-note" data-dshdg-note-full="">
      <div className="dshdg-row">
        <span className="dshdg-hint">{preview.chars} 字符</span>
        <span className="dshdg-spacer" />
        <button type="button" onClick={copy}>复制全文</button>
      </div>
      {copyState === null ? null : <p className="dshdg-hint">{copyState}</p>}
      <pre className="dshdg-mono dshdg-note-full">{full}</pre>
    </div>
  );
}

function OpenTaskSession({ store, taskId }) {
  const navigation = useContext(SessionNavigation);
  const [opening, setOpening] = useState(false);
  const [feedback, setFeedback] = useState(null);
  // The list can restore a legacy record's session through its saved identity.
  const recorded = store.getSnapshot().tasks?.find((row) => row.taskId === taskId);
  const sessionId = taskSessionId(recorded);
  if (navigation === null) return null;

  async function open() {
    setOpening(true);
    setFeedback(null);
    try {
      const outcome = await locateSession(
        resolveService(navigation.uiWorkspace), sessionId, resolveService(navigation.workspaces),
      );
      if (!outcome.ok) setFeedback(outcome.message);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="dshdg-row">
      <button type="button" data-dshdg-open-session={taskId} disabled={opening || sessionId === null}
        onClick={() => { void open(); }}>
        打开会话
      </button>
      {sessionId === null ? <span className="dshdg-hint">这条记录没有可定位的会话。</span> : null}
      {feedback === null ? null : <span className="dshdg-warn" role="status">{feedback}</span>}
    </div>
  );
}

/**
 * One task's details: effective config, diff, evidence, usage, review outcome.
 * @param {object} props - `store`, `task`.
 * @returns {object} the detail card.
 */
function TaskDetail({ store, task }) {
  const outcome = taskOutcome(task);
  const files = changedFiles(task);
  // A bounded read of the task's own activity metadata. `available: false` means the
  // record carries none (an old record, or a task that never reached execution), and
  // that is stated as "未采集到" rather than as "idle" or "healthy".
  const progress = taskProgress(task);
  const activity = taskActivity(task);
  // `view()` freezes the configuration that actually ran; a later settings edit
  // does not retroactively change what a finished task reports.
  const worker = task.effective?.worker ?? {};
  const legacyReview = task.review;
  const legacyReviewState = legacyReview?.state;
  const legacyVerdict = typeof legacyReview?.verdict === 'string' ? legacyReview.verdict : legacyReview?.verdict?.verdict;
  const showLegacyReview = legacyReviewState === 'completed' || legacyReviewState === 'failed'
    || legacyReviewState === 'cancelled';
  const diff = task.diff ?? null;
  const execution = task.execution ?? null;
  const error = task.error ?? execution?.error ?? null;
  const permission = permissionSummary(task);
  const pending = pendingPermission(task);
  const evidence = Array.isArray(task.permission?.evidence) ? task.permission.evidence : [];
  // The detail header uses the SAME headline as the list, so a task that was reviewed
  // never still says "等待宿主审查" here while the list says "审查通过".
  const badgeTone = isAwaitingPermission(task) ? 'warn' : outcome.tone;
  return (
    <div className="dshdg-item">
      <div className="dshdg-item-head">
        <strong>{task.title || task.taskId}</strong>
        <Badge tone={badgeTone}>
          {outcome.label}
        </Badge>
        {isAwaitingPermission(task) ? <Badge tone="warn">{PERMISSION_STATE_LABELS.pending}</Badge> : null}
        <span className="dshdg-spacer" />
        <button
          type="button"
          className="dshdg-danger"
          disabled={!isCancellable(task.state)}
          onClick={() => { void store.cancelTask(task.taskId); }}
        >
          取消任务
        </button>
      </div>
      <p className="dshdg-muted">{outcome.note}</p>
      <OpenTaskSession key={task.taskId} store={store} taskId={task.taskId} />

      <div className="dshdg-card" data-dshdg-task-progress="">
        <h4>进展</h4>
        <p className="dshdg-mono">{progress.headline}</p>
        <p className="dshdg-hint">{progress.detail}</p>
      </div>

      <dl className="dshdg-kv">
        <dt>生效提供方</dt>
        <dd className="dshdg-mono">{worker.providerId ?? '—'}</dd>
        <dt>生效模型</dt>
        <dd className="dshdg-mono">{worker.model ?? '—'}</dd>
        <dt>推理强度</dt>
        <dd className="dshdg-mono">{worker.reasoningEffort ?? '（不指定）'}</dd>
        <dt>工作区</dt>
        <dd className="dshdg-mono">{task.workspacePath ?? '—'}</dd>
        <dt>隔离</dt>
        <dd>{ISOLATION_LABELS[task.isolation ?? worker.isolation] ?? task.isolation ?? worker.isolation ?? '—'}</dd>
        <dt>对话</dt>
        <dd>
          {execution?.conversation === null || execution?.conversation === undefined
            ? (task.continueFromTaskId === null || task.continueFromTaskId === undefined
              ? '（未放置对话）'
              : `（未放置对话；本任务声明续接 ${task.continueFromTaskId}）`)
            : (execution.conversation.reused === true
              ? `续接 ${execution.conversation.continuedFromTaskId ?? '上一任务'} · 工作区 ${execution.conversation.workspaceId ?? '—'}`
              : `新开 · 工作区 ${execution.conversation.workspaceId ?? '—'}`)}
        </dd>
        <dt>阶段</dt>
        <dd>
          {/* A finished/reviewed run never says "waiting for host review" here: that is the
              headline's job. What remains true is that the execution is over. */}
          {outcome.decided || task.state === 'awaiting-host-review' ? '执行已结束' : taskPhaseLabel(task.phase)}
        </dd>
        <dt>最近进展</dt>
        <dd>
          {activity === null || activity.lastActivityAt === null
            ? '未采集到'
            : `${formatTime(activity.lastActivityAt)}（距上次进展 ${formatDuration(activity.idleForMs)}）`}
        </dd>
        <dt>当前工具</dt>
        <dd>
          {activity === null || activity.currentTool === null
            ? (activity === null ? '未采集到' : '当前没有正在运行的工具')
            : `${activity.currentTool.name} · 已运行 ${formatDuration(activity.currentTool.elapsedMs)}`}
        </dd>
        <dt>无进展诊断</dt>
        <dd>
          {activity === null || activity.selfCheck === null || activity.selfCheck.verdict === null
            ? (activity === null ? '未采集到' : '尚未触发程序自检（开始运行时间还没到自检间隔，或已关闭自检）')
            : `${SELF_CHECK_LABELS[activity.selfCheck.verdict] ?? activity.selfCheck.verdict}`
              + (activity.selfCheck.checkedAt === null ? '' : `（${formatTime(activity.selfCheck.checkedAt)}）`)}
        </dd>
        <dt>监控间隔</dt>
        <dd>
          {activity === null || activity.selfCheckSeconds === null
            ? '未采集到'
            : `自检 ${formatDuration(activity.selfCheckSeconds * 1000)} · 提醒 ${formatDuration((activity.attentionSeconds ?? 0) * 1000)}`}
        </dd>
        <dt>重复失败提醒</dt>
        <dd>{repeatFailureLine(activity)}</dd>
        <dt>智能体协作</dt>
        <dd data-dshdg-task-team="">
          {teamLine(task)}
        </dd>
        <dt>创建</dt>
        <dd>{formatTime(task.createdAt)}</dd>
        <dt>结束</dt>
        <dd>{formatTime(task.endedAt)}</dd>
        <dt>用量</dt>
        <dd>{execution?.usage === null || execution?.usage === undefined ? '不可用' : boundedText(execution.usage, 600)}</dd>
        <dt>宿主验收</dt>
        <dd>{hostReviewLine(task, formatTime)}</dd>
        <dt>完整审查意见</dt>
        <dd><ReviewNoteDetail key={task.taskId} task={task} store={store} /></dd>
      </dl>

      <h4>改动文件</h4>
      {files === null
        ? <p className="dshdg-faint">宿主未回报可识别的文件摘要，请以下方原始 diff 为准。</p>
        : <ul className="dshdg-mono">{files.map((file) => <li key={file}>{file}</li>)}</ul>}
      {diff?.patchWithheld === true
        ? <p className="dshdg-fail">宿主判定这批改动不宜展示内容（命中敏感路径或超出上限），只给出说明。</p>
        : null}
      {diff?.patchTruncated === true ? <p className="dshdg-hint">diff 已截断。</p> : null}

      <h4>diff</h4>
      <pre className="dshdg-pre">{boundedText(diff?.patchText ?? '（无 diff 内容）')}</pre>

      <h4>验证证据</h4>
      <pre className="dshdg-pre">{boundedText(execution?.text ?? execution ?? '（无验证证据）')}</pre>

      {error === null ? null : (
        <>
          <h4>错误</h4>
          <pre className="dshdg-pre">{boundedText(error, 4000)}</pre>
        </>
      )}

      {showLegacyReview ? (
        <details>
          <summary>历史模型复审 · {REVIEW_STATE_LABELS[legacyReviewState] ?? legacyReviewState}</summary>
          {legacyVerdict ? <p>{REVIEW_VERDICT_LABELS[legacyVerdict] ?? legacyVerdict}</p> : null}
          {legacyReview.text ? <pre className="dshdg-pre">{boundedText(legacyReview.text, 8000)}</pre> : null}
        </details>
      ) : null}

      <h4>本次调用授权</h4>
      <p className={isAwaitingPermission(task) ? 'dshdg-hint' : 'dshdg-faint'}>{permission.note}</p>
      {permission.detail === '' ? null : <p className="dshdg-faint dshdg-mono">{permission.detail}</p>}
      {pending === null ? null : (
        <dl className="dshdg-kv">
          <dt>工具</dt>
          <dd className="dshdg-mono">{pending.toolName ?? '—'}</dd>
          <dt>调用编号</dt>
          <dd className="dshdg-mono">{pending.callId ?? '—'}</dd>
          <dt>请求的权限</dt>
          <dd className="dshdg-mono">{pending.requestedAccess?.mode ?? '（该工具自身的调用）'}</dd>
          <dt>实际参数（已脱敏）</dt>
          <dd className="dshdg-mono">{boundedText(pending.arguments ?? '（不可读）', 2000)}</dd>
          <dt>工作进程给出的理由</dt>
          <dd>{pending.reason ?? '（未给出）'}（这是工作进程自己的说法，不是被决定的操作本身）</dd>
          <dt>截止</dt>
          <dd>{formatTime(pending.deadlineAt)}</dd>
        </dl>
      )}
      {evidence.length === 0 ? null : (
        <>
          <h4>授权决定记录</h4>
          <ul className="dshdg-mono">
            {evidence.slice().reverse().map((entry) => (
              <li key={entry.requestId}>
                {`${entry.requestId} · ${entry.toolName ?? '—'} · `
                  + `${PERMISSION_STATE_LABELS[entry.state] ?? entry.state ?? '—'} · `
                  + `${PERMISSION_OUTCOME_LABELS[entry.outcome] ?? entry.outcome ?? '—'}`
                  + `${entry.decidedBy === 'commander' ? ` · ${PERMISSION_DECISION_LABELS[entry.outcome === 'allowed-once' ? 'allow-once' : 'reject'] ?? '宿主端'}` : ''}`}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="dshdg-hint">
        逐次授权只覆盖当前调用。后续调用如需扩大权限，须重新核对参数并审批。它不能创建或扩大任何跨任务或长期有效的授权（“长期有效”指跨会话持久的授权），不能修改设置、凭据、本机调用开关、提供方、模型或隔离方式；
        工作进程的常规沙箱权限始终保持 workspace-write。此界面不提供手工批准按钮，决定由宿主端通过
        delegate_permission_decide 作出。
      </p>

      <p className="dshdg-hint">
        重试前请确认顶部的本机调用开关已开启，然后在 MCP 宿主重新提交任务。本界面不会直接提交任务。
      </p>
    </div>
  );
}

/** @param {object} props @returns {object} the task records panel. */
/** Refresh the task list while this panel is mounted and the document is visible. */
function useTaskAutoRefresh({ store, snapshot }) {
  const plan = recordRefreshPlan({ tasks: snapshot.tasks, selectedTask: snapshot.taskDetail });
  const latest = useRef({
    tasks: snapshot.tasks,
    selectedTask: snapshot.taskDetail,
    loading: snapshot.loading?.tasks === true,
    hydrated: snapshot.tasksLoaded === true,
  });
  latest.current = {
    tasks: snapshot.tasks,
    selectedTask: snapshot.taskDetail,
    loading: snapshot.loading?.tasks === true,
    hydrated: snapshot.tasksLoaded === true,
  };
  const [refreshError, setRefreshError] = useState(null);

  useEffect(() => {
    // The SAME loop the sidebar view uses: one policy for every surface showing the
    // shared task records, so neither can miss a task dispatched from outside.
    return startRecordsReadLoop({
      store,
      readState: () => latest.current,
      onError: (error) => { setRefreshError(error === null ? null : describeError(error)); },
    });
  }, [store]);
  return { ...plan, refreshError };
}

/**
 * The one line that tells the operator what the automatic save is doing.
 *
 * A failure is never hidden behind "已保存": the refusals are shown verbatim (the host
 * is the authority, and the local precheck names the exact field), and an invalid
 * draft says plainly that the LAST VALID document is still in force.
 * @param {object} snapshot - store snapshot.
 * @param {string[]} problems - current local precheck problems.
 * @returns {string} operator-facing status line.
 */
function autosaveLine(snapshot, problems) {
  const state = snapshot.saveState ?? 'idle';
  const problemText = problems.length === 0
    ? ''
    : ` 待修正：${problems[0]}${problems.length > 1 ? ` 等 ${problems.length} 项` : ''}`;
  switch (state) {
    case 'saving':
      return '保存中…';
    case 'saved':
      return '已保存。';
    case 'invalid':
      return `未保存：${(snapshot.saveProblems ?? problems).slice(0, 2).join('；')}。上次有效配置仍然生效。${problemText}`;
    case 'failed': {
      const described = snapshot.saveError === null || snapshot.saveError === undefined
        ? '未知错误'
        : describeError(snapshot.saveError);
      return `保存失败：${described}。草稿已保留，可继续修正或重试。${problemText}`;
    }
    case 'pending':
      return snapshot.dirty === true ? '有改动，准备保存…' : '所有修改已保存。';
    default:
      return snapshot.dirty === true ? '有未保存的修改。' : '所有修改已保存。';
  }
}

/**
 * The review-note preview of one task row: at most 200 code points, plus a clear way to
 * read the whole note. The preview is a display cut; the saved body is untouched.
 *
 * `onOpen` takes the TASK ID, exactly like every other "open the detail" entry point on
 * this page. The row passes its own id (a bound call), so the link can never end up
 * reading whatever detail happens to be selected at click time.
 * @param {object} props - `task`, `onOpen(taskId)`.
 * @returns {object | null} the preview line, or null when there is no conclusion.
 */
function TaskListNote({ task, onOpen }) {
  const preview = reviewNotePreview(task);
  if (preview === null) return null;
  if (preview.omitted === true) {
    return (
      <p className="dshdg-hint">
        {`审查意见已保存（${preview.chars} 字符），此处省略正文。`}
        <button type="button" className="dshdg-link" onClick={onOpen}>查看完整审查意见</button>
      </p>
    );
  }
  if (preview.chars === 0) return null;
  return (
    <p className="dshdg-hint dshdg-note-preview">
      {`审查意见：${preview.text}${preview.truncated ? '…' : ''}（${preview.chars} 字符）`}
      {preview.truncated
        ? <button type="button" className="dshdg-link" onClick={onOpen}>查看完整审查意见</button>
        : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Task tree (G09: visualise the host's projection) and plan creation (G02/G05)
// ---------------------------------------------------------------------------
//
// Everything below renders the host's `/tasks` projection. It is deliberately a
// READER: no relation is re-derived from titles, times, prompts or list order, and
// no status is computed here — `nodeStatus`, `orphan`, `depth`, `executions` and
// each chain's `rounds` all arrive from `src/jobs/task-tree.js` on the server. The
// only additions are display text, and a Set of node ids the operator expanded.
//
// The one interaction the tree offers is a per-round "详情"/"取消", which reuse the
// EXISTING store actions and the EXISTING `TaskDetail` panel. Every click carries a
// stable `taskId`, so a later background refresh (which replaces the whole tree)
// cannot re-point a button at a different task.
//
// "清理记录" adds ONE more: selection mode. While it is on, every execution chain
// of the tree gets a checkbox whose state comes from the host's own `cleanup` block
// (`eligible` + `blockers`). The selection holds the chain's EXACT task ids, the bar
// counts them before anything is sent, and only a confirmed batch is written. Cancel
// sends nothing, and the panel never deletes on render, on refresh or on open.

/** How many rounds of one chain are listed without expanding that chain further. */
const CHAIN_ROUNDS_VISIBLE = 3;

/**
 * Whether `node` is visible, given the set of COLLAPSED keys.
 *
 * The model is "expanded by default, minus what the operator collapsed", not "a
 * fresh set of open ids". A background refresh replaces every node object, so an
 * expansion state kept as "open ids" would silently re-collapse everything the
 * operator had opened (the bug this shape prevents): a retained set of CLOSED keys
 * survives the replacement and keeps the tree exactly as the operator left it.
 * @param {object} node - projected node (its `nodeId` is the identity).
 * @param {Set<string>} collapsed - keys the operator closed.
 * @returns {boolean} true when the node itself should be drawn.
 */
function isNodeVisible(node, collapsed) {
  return !collapsed.has(node.nodeId);
}

/** Display title of one node: the host's own (a missing one is already labelled upstream). */
function treeNodeTitle(node) {
  if (typeof node.displayTitle === 'string' && node.displayTitle !== '') return node.displayTitle;
  if (typeof node.title === 'string' && node.title !== '') return node.title;
  return '未命名节点';
}

/**
 * The node ids a create form may offer as a parent, in tree order.
 *
 * It lists exactly what the host returned: a node id from the projection, with its
 * title as the label. The SELECTED value is the real id, so "same title in two
 * projects" stays two distinct choices, and nothing is inferred from a title.
 * @param {object | null} view - `taskTreeView(...)`.
 * @returns {object[]} `{ nodeId, label, depth }` entries.
 */
function planParentChoices(view) {
  if (view === null || view === undefined) return [];
  const choices = [];
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || typeof node.nodeId !== 'string') return;
    if (node.kind === 'plan') choices.push({ nodeId: node.nodeId, label: treeNodeTitle(node), depth });
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, depth + 1);
  };
  for (const root of Array.isArray(view.roots) ? view.roots : []) walk(root, 0);
  return choices;
}

function chainsOfTreeNode(node) {
  if (node.kind === 'plan') return node.executions ?? [];
  return node.chain ? [node.chain] : [];
}

/**
 * One execution chain: its rounds, plus — in selection mode — its cleanup checkbox.
 *
 * The checkbox is the ONLY control that changes the cleanup selection, and it is
 * driven entirely by the host's `cleanup` block on this chain: a chain the host says
 * is ineligible is drawn disabled with the reason, so a refusal can never be produced
 * by a row the page offered as removable.
 * @param {object} props - `chain`, `store`, `snapshot`, `onOpen`, `expanded`, `onToggle`,
 *   `cleanup` (`{ active, selection, candidates, onToggle }` or null), `forceExpanded`,
 *   `newestFirst` (draw the last round, i.e. the one carrying the live session, first).
 * @returns {object} the chain block.
 */
function ChainRounds({ chain, store, snapshot, onOpen, expanded, onToggle, cleanup, forceExpanded, newestFirst = false }) {
  const ordered = chain.rounds ?? [];
  // The NEWEST round is the only one that can still own a live native session, so the
  // 最近任务 detail lists it first; the PROJECT TREE keeps the recorded order (first
  // round, then rectification rounds), which is what the operator reads there.
  const rounds = newestFirst ? [...ordered].reverse() : ordered;
  const roundOf = (task) => (ordered.findIndex((entry) => entry.taskId === task.taskId) + 1);
  const candidate = cleanup?.candidates?.find((entry) => entry.chainId === chain.chainId) ?? null;
  const checked = candidate !== null
    && Array.isArray(cleanup?.selection?.[chain.chainId]);
  return (
    <div className="dshdg-tree-execution" data-dshdg-chain={chain.chainId}>
      {cleanup?.active === true && candidate !== null ? (
        <div className="dshdg-cleanup-row" data-dshdg-cleanup-row={chain.chainId}>
          <label className="dshdg-cleanup-check">
            <input
              type="checkbox"
              data-dshdg-cleanup-check={chain.chainId}
              checked={checked}
              disabled={!candidate.selectable || snapshot.loading?.cleanup === true}
              onChange={() => cleanup.onToggle(candidate)}
            />
            {`勾选整条执行链（${candidate.taskIds.length} 轮）`}
          </label>
          {candidate.selectable ? null : (
            <span className="dshdg-faint" data-dshdg-cleanup-blocked={chain.chainId}>{candidate.reason}</span>
          )}
        </div>
      ) : null}
      <ul className="dshdg-tree-rounds">
        {rounds.map((task, index) => (newestFirst
          || expanded || forceExpanded || index >= rounds.length - CHAIN_ROUNDS_VISIBLE
          || task.taskId === snapshot.taskDetail?.taskId ? (
            <ChainRoundRow key={task.taskId} store={store} round={{ task, round: roundOf(task),
              position: roundOf(task) === 1 ? 'first' : 'rectification' }} snapshot={snapshot} onOpen={onOpen} />
          ) : null))}
      </ul>
      {!forceExpanded && !newestFirst && rounds.length > CHAIN_ROUNDS_VISIBLE ? <button type="button" data-dshdg-chain-more={chain.chainId}
        onClick={onToggle} aria-expanded={expanded}>
        {expanded ? '只看最近三轮' : '显示全部 ' + rounds.length + ' 轮'}
      </button> : null}
    </div>
  );
}

function InlineTaskDetail({ store, task, view, onClose }) {
  const detailRef = useRef(null);
  useLayoutEffect(() => {
    const element = detailRef.current;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [view]);
  return (
    <div ref={detailRef} tabIndex={-1} data-dshdg-task-detail="" aria-label="任务详情">
      <div className="dshdg-row">
        <button type="button" onClick={onClose}>收起详情</button>
      </div>
      <TaskDetail store={store} task={task} />
    </div>
  );
}

function ChainRoundRow({ store, round, snapshot, onOpen }) {
  const task = round.task ?? {};
  const outcome = taskOutcome(task);
  const progress = taskProgress(task);
  const model = task.route?.model ?? task.effective?.worker?.model ?? null;
  const activityAt = task.activity?.lastActivityAt;
  const detailButton = useRef(null);
  const detail = snapshot.taskDetail?.taskId === task.taskId ? snapshot.taskDetail : null;
  return (
    <li className="dshdg-tree-round" data-dshdg-round={`${task.taskId ?? ''}`}>
      <div className="dshdg-tree-round-head">
        <span className="dshdg-faint dshdg-mono">{`第 ${round.round} 轮`}</span>
        <span>{task.title || task.taskId || '未记录标题'}</span>
        <Badge tone={isAwaitingPermission(task) ? 'warn' : outcome.tone}>{outcome.label}</Badge>
        <span className="dshdg-spacer" />
        {round.position === 'first' ? <span className="dshdg-faint">首轮</span> : <span className="dshdg-faint">整改轮次</span>}
        <button
          type="button"
          ref={detailButton}
          aria-expanded={detail !== null}
          data-dshdg-round-detail={task.taskId ?? ''}
          disabled={snapshot.taskDetailLoading === true}
          onClick={() => { void onOpen(task.taskId); }}
        >
          详情
        </button>
        <button
          type="button"
          className="dshdg-danger"
          data-dshdg-round-cancel={task.taskId ?? ''}
          disabled={!isCancellable(task.state)}
          onClick={() => { void store.cancelTask(task.taskId); }}
        >
          取消
        </button>
      </div>
      {detail ? null : (
        <p className="dshdg-hint">
          {[progress.headline, model, Number.isFinite(activityAt) ? `最近活动 ${formatTime(activityAt)}` : null].filter(Boolean).join(' · ')}
        </p>
      )}
      {typeof task.hostAcceptance?.note === 'string' && task.hostAcceptance.note !== ''
        ? <p className="dshdg-hint dshdg-note-preview">{`审查意见：${boundedText(task.hostAcceptance.note, 200)}`}</p>
        : null}
      {detail === null ? null : (
        <InlineTaskDetail store={store} task={detail} view={snapshot.taskDetailView} onClose={() => {
          store.closeTask();
          detailButton.current?.focus({ preventScroll: true });
        }} />
      )}
    </li>
  );
}

/**
 * One projected node: header, goals, completion, children and every chain round.
 *
 * Accessibility/behaviour choices that are load-bearing:
 *   * the expand/collapse control is a real `<button>` with `aria-expanded` and
 *     `aria-controls`, so it is reachable and operable by keyboard; Enter and Space
 *     both reach it through the native button behaviour;
 *   * the indented child list is a `<ul role="group">`, which is the structure a
 *     screen reader announces as a nested group;
 *   * nothing focuses itself on render, so a refresh cannot steal focus;
 *   * a `plan` node with no execution and no execution anywhere below it is drawn
 *     as unexecuted, and the page never labels it "done".
 * @param {object} props - `node`, `store`, `snapshot`, `collapsed`, `setCollapsed`,
 *   `expandedRounds`, `setExpandedRounds`, `onOpen`.
 * @returns {object} the node.
 */
function TaskTreeItem({ node, store, snapshot, collapsed, setCollapsed, expandedRounds, setExpandedRounds, onOpen, onArchive, forceOpen, cleanup }) {
  const children = Array.isArray(node.children) ? node.children : [];
  const key = node.nodeId;
  const open = forceOpen || !collapsed.has(key);
  const status = typeof node.nodeStatus === 'string' ? node.nodeStatus : 'unknown';
  const chains = chainsOfTreeNode(node);
  const orphanLabel = node.orphan === null || node.orphan === undefined
    ? null
    : (TREE_ORPHAN_LABELS[node.orphan.kind] ?? '关系不完整，暂列在此');
  const goal = typeof node.goalDescription === 'string' && node.goalDescription.trim() !== ''
    ? node.goalDescription.trim()
    : null;
  const completion = typeof node.completionSummary === 'string' && node.completionSummary.trim() !== ''
    ? node.completionSummary.trim()
    : null;
  const toggle = () => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };
  return (
    <li className="dshdg-tree-node" data-dshdg-tree-node={key} data-dshdg-node-kind={node.kind ?? 'unknown'}>
      <div className="dshdg-tree-row">
        <button
          type="button"
          className="dshdg-tree-toggle"
          data-dshdg-tree-toggle={key}
          aria-expanded={open}
          aria-controls={`dshdg-tree-children-${key}`}
          disabled={forceOpen}
          onClick={toggle}
        >
          {open ? '收起' : '展开'}
        </button>
        <span className="dshdg-tree-title">{treeNodeTitle(node)}</span>
        <Badge tone={TREE_STATUS_TONES[status] ?? 'off'}>{TREE_STATUS_LABELS[status] ?? status}</Badge>
        {node.kind === 'plan' && node.executed !== true
          ? <span className="dshdg-faint">尚未执行</span>
          : null}
        {node.kind === 'task' && node.standalone === true ? <span className="dshdg-faint">独立任务</span> : null}
        {node.childProgress?.total > 0 ? <span className="dshdg-faint">{`子任务 ${node.childProgress.total} · ${node.childProgress.accepted} 已通过`}</span> : null}
        {onArchive && !node.displayArchiveInherited && (node.displayArchived || status === 'accepted') ? (
          <button type="button" disabled={snapshot.loading?.displayArchive === true}
            onClick={() => { void onArchive(node, !node.displayArchived); }}>
            {node.displayArchived ? '恢复显示' : '归档'}
          </button>
        ) : null}
        {typeof node.roundCount === 'number' && node.roundCount > 0
          ? <span className="dshdg-faint">{`${node.roundCount} 轮`}</span>
          : null}
      </div>
      {orphanLabel === null ? null : <p className="dshdg-warn">{orphanLabel}</p>}
      {open ? (
        <div id={`dshdg-tree-children-${key}`} className="dshdg-tree-body">
          {goal === null ? null : <p className="dshdg-hint">{`目标：${boundedText(goal, 400)}`}</p>}
          {completion === null ? null : <p className="dshdg-hint">{`已完成：${boundedText(completion, 400)}`}</p>}
          {chains.map((chain) => <ChainRounds key={chain.chainId} chain={chain} store={store} snapshot={snapshot}
            onOpen={onOpen} expanded={expandedRounds.has(chain.chainId)} forceExpanded={forceOpen}
            cleanup={cleanup} onToggle={() => setExpandedRounds((old) => {
              const next = new Set(old);
              if (next.has(chain.chainId)) next.delete(chain.chainId);
              else next.add(chain.chainId);
              return next;
            })} />)}
          {children.length === 0 ? null : (
            <ul className="dshdg-tree-children" role="group" aria-label={`${treeNodeTitle(node)} 的子节点`}>
              {children.map((child) => (
                <TaskTreeItem
                  key={child.nodeId}
                  node={child}
                  store={store}
                  snapshot={snapshot}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                  expandedRounds={expandedRounds}
                  setExpandedRounds={setExpandedRounds}
                  onOpen={onOpen}
                  onArchive={onArchive}
                  forceOpen={forceOpen}
                  cleanup={cleanup}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function TaskTreePanel({ store, snapshot, onOpen }) {
  const nav = useContext(SessionNavigation);
  const view = snapshot.tree ?? null;
  const [recordView, setRecordView] = useState('recent');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [expandedRounds, setExpandedRounds] = useState(() => new Set());
  const [projectKey, setProjectKey] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [archiveError, setArchiveError] = useState(null);
  // Selection mode. `cleanupSelection` maps a chain id to the EXACT task ids that
  // were ticked; `cleanupConfirm` opens the confirmation, which is the only place a
  // batch is sent. Leaving the mode (or cancelling) clears both.
  const [cleanupMode, setCleanupMode] = useState(false);
  const [cleanupSelection, setCleanupSelection] = useState({});
  const [cleanupConfirm, setCleanupConfirm] = useState(false);
  const [cleanupOptions, setCleanupOptions] = useState({
    archiveSessions: false,
    removeWorktrees: false,
    cleanPlans: false,
  });
  if (view === null) {
    return <p className="dshdg-faint" data-dshdg-tree-unavailable="">
      {snapshot.tasksError ? '任务树读取失败，下面显示已有记录。' : '当前宿主按列表显示任务。'}
    </p>;
  }
  const counts = view.counts ?? {};
  const canArchive = view.displayArchiveAvailable === true;
  const dateRange = { from: fromDay, to: toDay };
  const { groups, recent, archiveCount, dateError, dateRangeText } = projectTaskView(view, {
    projectKey, filter: canArchive ? filter : (filter === 'archive' ? 'all' : filter), search,
    selectedTaskId: snapshot.taskDetail?.taskId ?? null,
    dateRange,
  });
  // A reversed range is stated and NOT applied: the page keeps showing what it
  // showed before rather than answering a different question than the one asked.
  // The projection has already applied exactly the same rule to the same values.
  const rangeActive = dateError === null && (dateRange.from !== '' || dateRange.to !== '');
  const roots = recordView === 'recent'
    ? recent.map(({ chain, node }) => ({ nodeId: node.nodeId, kind: node.kind, chain }))
    : groups.flatMap((group) => group.roots);
  const candidates = cleanupCandidates({ roots });
  const canCleanup = view.cleanupAvailable === true && (view.counts?.taskChains ?? 0) > 0;
  const canSweepOrphans = view.cleanupAvailable === true && typeof store?.cleanupOrphans === 'function';
  const cleanupActive = cleanupMode && canCleanup;
  const cleanupBusy = snapshot.loading?.cleanup === true;
  const orphanSweepBusy = snapshot.loading?.cleanupOrphans === true;
  const summary = cleanupSelectionSummary(cleanupSelection, candidates);
  const mayDelete = dateError === null && !cleanupBusy && summary.executable;
  function clearSelection() {
    setCleanupSelection({});
    setCleanupConfirm(false);
  }
  function applyPresetSelection(preset) {
    setCleanupSelection(selectCleanupCandidatesByPreset(candidates, preset));
    setCleanupConfirm(false);
  }
  function toggleCleanupOption(key) {
    setCleanupOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    setCleanupConfirm(false);
  }
  async function runOrphanSweep() {
    if (orphanSweepBusy || cleanupBusy) return;
    await store.cleanupOrphans({ hostWorkspaces: nav?.workspaces });
  }
  const updateFilter = (setter) => (event) => {
    setter(event.target.value);
    clearSelection();
    store.closeTask();
  };
  const clearDays = () => {
    setFromDay('');
    setToDay('');
    clearSelection();
    store.closeTask();
  };
  async function archive(node, archived) {
    setArchiveError(null);
    const result = await store.setDisplayArchive(node.nodeId, archived);
    if (!result.ok) setArchiveError(describeError(result.error));
    else if (archived && snapshot.taskDetail) store.closeTask();
  }
  function leaveCleanup() {
    setCleanupMode(false);
    clearSelection();
    setCleanupOptions({ archiveSessions: false, removeWorktrees: false, cleanPlans: false });
  }
  function onToggleChain(candidate) {
    setCleanupSelection((old) => toggleCleanupSelection(old, withSelectionState(candidate, old[candidate.chainId])));
    setCleanupConfirm(false);
  }
  async function confirmCleanup() {
    if (!mayDelete) return;
    const result = await store.cleanupTasks(cleanupSelection, {
      ...cleanupOptions,
      hostWorkspaces: nav?.workspaces,
    });
    if (result.ok) leaveCleanup();
    setCleanupConfirm(false);
  }
  const cleanup = cleanupActive ? { active: true, selection: cleanupSelection, candidates, onToggle: onToggleChain } : null;
  function changeView(next) {
    if (recordView === next) return;
    setRecordView(next);
    clearSelection();
    store.closeTask();
  }
  /**
   * A 最近任务 row was just expanded: read ITS most recent round through the same
   * `store.openTask` every other 详情 entry uses, so the row's detail block shows the
   * existing `TaskDetail` — including the existing 打开会话 control and the rounds a
   * continuation chain has. A collapsed row reads nothing.
   * @param {object} chain - the row's execution chain.
   * @returns {void}
   */
  function openRecentDetail(chain) {
    const rounds = Array.isArray(chain?.rounds) ? chain.rounds : [];
    const latest = rounds[rounds.length - 1];
    const taskId = latest?.taskId;
    if (typeof taskId === 'string' && taskId !== '') void store.openTask(taskId);
  }
  function renderRecordDetails({ chain, node, archiveInherited }) {
    const mayArchive = canArchive && node.kind === 'task' && !archiveInherited
      && (node.displayArchived || chain.nodeStatus === 'accepted');
    return (
      <div className="dshdg-record-detail">
        {chain.goalDescription ? <p className="dshdg-hint">{'目标：' + boundedText(chain.goalDescription, 400)}</p> : null}
        {chain.completionSummary ? <p className="dshdg-hint">{'已完成：' + boundedText(chain.completionSummary, 400)}</p> : null}
        {/* The chain's rounds, newest LAST round first so 打开会话 is in reach without
            scrolling past every older round; the row above already shows the count. */}
        <ChainRounds chain={chain} store={store} snapshot={snapshot} onOpen={onOpen} forceExpanded newestFirst />
        {mayArchive ? (
          <button type="button" disabled={snapshot.loading?.displayArchive === true}
            onClick={() => { void archive(node, !node.displayArchived); }}>
            {node.displayArchived ? '恢复显示' : '归档'}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-tree-title" data-dshdg-task-tree="">
      <div className="dshdg-row">
        <h3 id="dshdg-tree-title">任务记录</h3>
        <span className="dshdg-spacer" />
        <div className="dshdg-record-views" role="group" aria-label="显示方式">
          <button type="button" aria-pressed={recordView === 'recent'} onClick={() => changeView('recent')} data-dshdg-record-view="recent">
            最近任务
          </button>
          <button type="button" aria-pressed={recordView === 'tree'} onClick={() => changeView('tree')} data-dshdg-record-view="tree">
            项目树
          </button>
        </div>
        {canSweepOrphans ? (
          <button
            type="button"
            data-dshdg-cleanup-orphans=""
            disabled={orphanSweepBusy || cleanupBusy}
            title="扫描并清理任务记录已删除后残留的隔离工作树目录、DSH 临时工作区及已删记录对应的派工对话（绝不触碰共享工作区与源码）"
            onClick={() => { void runOrphanSweep(); }}
          >
            {orphanSweepBusy ? '正在清理残留…' : '清理残留工作区与对话'}
          </button>
        ) : null}
        {canCleanup ? (
          <button
            type="button"
            className={cleanupActive ? 'dshdg-danger' : undefined}
            data-dshdg-cleanup-toggle=""
            aria-pressed={cleanupActive}
            disabled={cleanupBusy || (!cleanupActive && dateError !== null)}
            onClick={() => {
              if (cleanupActive) leaveCleanup();
              else {
                setCleanupMode(true);
                setCleanupConfirm(false);
              }
            }}
          >
            {cleanupActive ? '退出清理' : '清理记录'}
          </button>
        ) : null}
      </div>
      <div className="dshdg-tree-filters">
        <label>项目<select value={projectKey} onChange={updateFilter(setProjectKey)}>
          <option value="">所有项目</option>
          {view.projects.map((p) => <option key={p.projectKey} value={p.projectKey}>{p.shortPath ? `${p.name} · ${p.shortPath}` : p.name}</option>)}
        </select></label>
        <label>状态<select value={filter} onChange={updateFilter(setFilter)}>
          <option value="all">全部</option>
          <option value="attention">需要处理</option>
          <option value="active">执行中</option>
          <option value="done">已完成</option>
          {canArchive ? <option value="archive">{`已归档（${archiveCount}）`}</option> : null}
        </select></label>
        <label>搜索<input type="search" value={search} onChange={updateFilter(setSearch)} placeholder="项目、标题或任务编号" /></label>
        <label>创建日期（起）<input type="date" value={fromDay} data-dshdg-tree-day-from="" max={toDay === '' ? undefined : toDay}
          aria-invalid={dateError !== null} onChange={updateFilter(setFromDay)} /></label>
        <label>创建日期（止）<input type="date" value={toDay} data-dshdg-tree-day-to="" min={fromDay === '' ? undefined : fromDay}
          aria-invalid={dateError !== null} onChange={updateFilter(setToDay)} /></label>
        <span className="dshdg-tree-day-actions">
          <button type="button" data-dshdg-tree-day-clear="" disabled={!rangeActive && dateError === null}
            onClick={clearDays}>清除日期</button>
        </span>
      </div>
      <p className="dshdg-hint" data-dshdg-tree-day-hint="">
        {rangeActive
          ? `按创建日期筛选：${dateRangeText.from ?? '不限'} 至 ${dateRangeText.to ?? '不限'}（两端都含当天；任一整改轮次创建于该范围时保留整条链）`
          : '按创建日期筛选：可只填开始或结束日期。两端相同时查询当天。'}
      </p>
      {dateError === null ? null : <p className="dshdg-warn" role="alert" data-dshdg-tree-day-error="">{`${dateError}。日期筛选未生效，任务树仍按其它条件显示。`}</p>}
      {filter === 'archive' ? <p className="dshdg-hint">归档只影响任务的显示。会话和历史仍按原规则保留。</p> : null}
      {view.displayArchiveError ? <p className="dshdg-warn" role="alert">归档记录暂不可读，已显示全部任务。</p> : null}
      {archiveError ? <p className="dshdg-warn" role="alert">{`更新归档失败。${archiveError}`}</p> : null}
      {view.cleanupError && view.cleanupError !== 'CLEANUP_UNAVAILABLE' ? (
        <p className="dshdg-warn" role="alert">清理状态暂不可用，任务树照常显示。</p>
      ) : null}
      {cleanupActive ? (
        <div className="dshdg-cleanup-bar" data-dshdg-cleanup-bar="">
          <p className="dshdg-hint" data-dshdg-cleanup-counts="">
            {`已选 ${summary.chains} 条执行链 / 共 ${summary.rounds} 轮`}
          </p>
          <div className="dshdg-row" data-dshdg-cleanup-presets="">
            <span className="dshdg-hint">快捷选择（当前筛选视图）：</span>
            <button
              type="button"
              data-dshdg-cleanup-preset="all"
              disabled={cleanupBusy}
              onClick={() => applyPresetSelection('all')}
            >
              全选可清理
            </button>
            <button
              type="button"
              data-dshdg-cleanup-preset="accepted"
              disabled={cleanupBusy}
              onClick={() => applyPresetSelection('accepted')}
            >
              全选已审查通过
            </button>
            <button
              type="button"
              data-dshdg-cleanup-preset="failed-cancelled"
              disabled={cleanupBusy}
              onClick={() => applyPresetSelection('failed-cancelled')}
            >
              全选已失败/已取消
            </button>
          </div>
          <div className="dshdg-cleanup-options" data-dshdg-cleanup-options="">
            <label className="dshdg-check">
              <input
                type="checkbox"
                data-dshdg-cleanup-opt="archiveSessions"
                checked={cleanupOptions.archiveSessions}
                disabled={cleanupBusy}
                onChange={() => toggleCleanupOption('archiveSessions')}
              />
              <span>同时归档对应的 DSH 派工对话（共享与隔离模式均适用，不影响你自己的普通对话）</span>
            </label>
            <label className="dshdg-check">
              <input
                type="checkbox"
                data-dshdg-cleanup-opt="removeWorktrees"
                checked={cleanupOptions.removeWorktrees}
                disabled={cleanupBusy}
                onChange={() => toggleCleanupOption('removeWorktrees')}
              />
              <span>同时删除隔离任务的工作树目录与 DSH 临时工作区（仅作用于独立工作树，绝不删除共享工作区与源文件）</span>
            </label>
            <label className="dshdg-check">
              <input
                type="checkbox"
                data-dshdg-cleanup-opt="cleanPlans"
                checked={cleanupOptions.cleanPlans}
                disabled={cleanupBusy}
                onChange={() => toggleCleanupOption('cleanPlans')}
              />
              <span>同时清理已无关联任务的空规划节点</span>
            </label>
          </div>
          {cleanupConfirm ? null : <p className="dshdg-warn">{cleanupWarningText()}</p>}
          {Object.keys(cleanupSelection).length === 0 ? null : summary.problems.map((problem) => (
            <p className="dshdg-warn" role="alert" key={problem} data-dshdg-cleanup-problem="">{problem}</p>
          ))}
          {cleanupConfirm ? (
            <div className="dshdg-row" data-dshdg-cleanup-confirm-dialog="" role="alertdialog" aria-label="确认永久删除记录">
              <span>
                {cleanupConfirmText(summary, cleanupOptions)}
              </span>
              <button
                type="button"
                className="dshdg-danger"
                data-dshdg-cleanup-confirm=""
                disabled={!mayDelete}
                onClick={() => { void confirmCleanup(); }}
              >
                {snapshot.loading?.cleanup === true ? '正在删除…' : '确认删除'}
              </button>
              <button type="button" data-dshdg-cleanup-cancel="" disabled={cleanupBusy} onClick={() => setCleanupConfirm(false)}>取消</button>
            </div>
          ) : (
            <div className="dshdg-row">
              <button
                type="button"
                className="dshdg-danger"
                data-dshdg-cleanup-review=""
                disabled={!mayDelete}
                onClick={() => setCleanupConfirm(true)}
              >
                下一步：确认删除
              </button>
              <button type="button" data-dshdg-cleanup-reset="" onClick={clearSelection}>
                清空选择
              </button>
            </div>
          )}
        </div>
      ) : null}
      {recordView === 'recent' ? (
        <TaskRecordsTable records={recent} hasPlans={counts.planNodes > 0} hasRecords={counts.taskChains > 0}
          cleanup={cleanup} cleanupBusy={cleanupBusy} renderDetails={renderRecordDetails} onToggleExpand={openRecentDetail} />
      ) : groups.length === 0 ? (
        <p className="dshdg-faint" data-dshdg-tree-empty="">{view.roots.length === 0 ? '还没有规划节点或执行记录。' : '没有符合当前条件的任务。'}</p>
      ) : groups.map((group) => (
        <section className="dshdg-tree-project" key={group.projectKey} data-dshdg-project={group.projectKey}>
          <h4>{group.name} {group.shortPath ? <small>{group.shortPath}</small> : null}</h4>
          <p className="dshdg-hint">{`任务 ${group.count.total} · 需要处理 ${group.count.attention}`}</p>
          <ul className="dshdg-tree-roots">
            {group.roots.map((node) => <TaskTreeItem key={node.nodeId} node={node} store={store} snapshot={snapshot}
              collapsed={collapsed} setCollapsed={setCollapsed} expandedRounds={expandedRounds} setExpandedRounds={setExpandedRounds}
              onOpen={onOpen} onArchive={canArchive ? archive : null}
              forceOpen={search.trim() !== '' || filter !== 'all' || rangeActive || cleanupActive}
              cleanup={cleanup} />)}
          </ul>
        </section>
      ))}
    </section>
  );
}

/**
 * One editable batch row of the creation form.
 *
 * `parent` is one of:
 *   * `''`                  — a root row (a top-level node, unless the form's own
 *                             "关联父节点" selector attaches the batch);
 *   * `'row:<n>'`           — an EARLIER row of the same batch (by position);
 *   * a real plan `nodeId`  — an existing node the host returned.
 * Nothing else is expressible, which is what keeps a parent reference an identity
 * rather than a guess from a title.
 */
function emptyPlanRow(overrides = {}) {
  return {
    title: '',
    goalDescription: '',
    parent: '',
    ...overrides,
  };
}

/**
 * The plan-creation form (G09 batch create).
 *
 * Rules it keeps:
 *   * the parent selector offers ONLY real ids the host returned (a plan node id) or
 *     a row position from the SAME batch — never a title, never a guessed parent;
 *   * a row may name another row as its parent (`parentKey` after projection), which
 *     is what makes "add one deeper level" possible without a second round trip;
 *   * the batch is created in ONE request, so the host's atomic validation decides:
 *     either every row exists or none does;
 *   * a refusal keeps every field exactly as typed and shows the host's reason;
 *   * success reads the records back through the normal refresh, so nothing here
 *     invents ids, order or statuses;
 *   * it never dispatches, authorizes or approves execution — the text says so.
 * @param {object} props - `store`, `snapshot`, `view`.
 * @returns {object} the form.
 */
function PlanCreateForm({ store, snapshot, view }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({
    title: '',
    goal: '',
    parentNodeId: '',
    workspacePath: '',
    rows: [emptyPlanRow()],
  }));
  const [problems, setProblems] = useState([]);
  const [saved, setSaved] = useState(null);
  const openerRef = useRef(null);
  const formRef = useRef(null);
  const error = snapshot.planCreateError ?? null;
  const busy = snapshot.loading?.planCreate === true;
  const choices = planParentChoices(view);
  // A parent picked from the tree keeps offering exactly that id even when the node is
  // currently COLLAPSED (and therefore absent from the visible choices), so collapsing
  // a subtree can never silently clear the parent the operator selected. The entry is
  // still an id the host returned, never a title.
  const selectedParent = draft.parentNodeId === '' || choices.some((choice) => choice.nodeId === draft.parentNodeId)
    ? null
    : { nodeId: draft.parentNodeId };
  const close = () => {
    setOpen(false);
    // Focus returns to the button that opened the form, so a keyboard operator is
    // never dropped back to the top of a long page (Escape does the same).
    openerRef.current?.focus?.();
  };
  const openForm = () => {
    setOpen(true);
    setSaved(null);
    setProblems([]);
  };
  const edit = (patchDraft) => setDraft((current) => ({ ...current, ...patchDraft }));
  const updateRow = (index, patchRow) => {
    setDraft((current) => ({
      ...current,
      rows: current.rows.map((row, at) => (at === index ? { ...row, ...patchRow } : row)),
    }));
  };
  const addRow = () => {
    setDraft((current) => (current.rows.length >= 32
      // A new row is a CHILD of the row above by default: that is the "add a deeper
      // level in one batch" gesture, and it is always expressed as a real row link.
      ? current
      : { ...current, rows: [...current.rows, emptyPlanRow({ parent: `row:${current.rows.length - 1}` })] }));
  };
  const removeRow = (index) => {
    setDraft((current) => (current.rows.length <= 1
      ? current
      : {
        ...current,
        // Positions shift after a removal, so a link into a removed (or renumbered)
        // row is dropped rather than left pointing at a different node.
        rows: current.rows
          .filter((_row, at) => at !== index)
          .map((row) => (row.parent.startsWith('row:') && Number.parseInt(row.parent.slice(4), 10) >= index
            ? { ...row, parent: '' }
            : row)),
      }));
  };
  const submit = async () => {
    const request = planCreateRequest(draft);
    setProblems(request.problems);
    if (request.problems.length > 0) return;
    const outcome = await store.createPlans(request.body);
    if (outcome?.ok !== true) return;
    // ONLY a confirmed create clears the form. A refusal keeps everything, so the
    // operator fixes the one field the host objected to instead of retyping a batch.
    setDraft({ title: '', goal: '', parentNodeId: '', workspacePath: '', rows: [emptyPlanRow()] });
    setSaved(outcome.nodes ?? []);
    setOpen(false);
    openerRef.current?.focus?.();
  };
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-plan-create-title" data-dshdg-plan-create="">
      <div className="dshdg-row">
        <h3 id="dshdg-plan-create-title">规划任务节点</h3>
        <span className="dshdg-spacer" />
        <button
          type="button"
          ref={openerRef}
          data-dshdg-plan-create-open=""
          aria-expanded={open}
          aria-controls="dshdg-plan-create-form"
          disabled={busy}
          onClick={() => { if (open) close(); else openForm(); }}
        >
          {open ? '关闭' : '新建规划'}
        </button>
      </div>
      <p className="dshdg-hint">
        这里只记录计划：创建节点不会派发任务、不会授权执行，也不会替你验收。
      </p>
      {saved === null ? null : (
        <p className="dshdg-hint" role="status" data-dshdg-plan-create-result="">
          {`已创建 ${saved.length} 个规划节点，可在上方任务树中查看。`}
        </p>
      )}
      {error === null ? null : (
        <p className="dshdg-warn" role="alert" data-dshdg-plan-create-error="">
          {`创建失败：${describeError(error)} 已保留你填写的全部内容；整批没有保存任何节点。`}
        </p>
      )}
      {problems.length === 0 ? null : (
        <p className="dshdg-warn" role="alert" data-dshdg-plan-create-problems="">
          {`请先修正：${problems.join('；')}。`}
        </p>
      )}
      {open ? (
        <div
          id="dshdg-plan-create-form"
          ref={formRef}
          className="dshdg-card"
          role="group"
          aria-label="新建规划节点"
          onKeyDown={(event) => {
            // Escape closes the form from ANY field inside it, which is what a
            // keyboard operator expects; the input is kept, only the form closes.
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="dshdg-grid">
            <Field label="标题" htmlFor="dshdg-plan-title" hint="第一个根节点的名称（1–120 个字）">
              <input
                id="dshdg-plan-title"
                type="text"
                value={draft.title}
                data-dshdg-plan-title=""
                onChange={(event) => edit({ title: event.target.value })}
              />
            </Field>
            <Field label="目标" htmlFor="dshdg-plan-goal" hint="可选：这个根节点要达成什么">
              <input
                id="dshdg-plan-goal"
                type="text"
                value={draft.goal}
                data-dshdg-plan-goal=""
                onChange={(event) => edit({ goal: event.target.value })}
              />
            </Field>
            {draft.parentNodeId === '' ? <Field label="所属项目" htmlFor="dshdg-plan-project">
              <select id="dshdg-plan-project" value={draft.workspacePath}
                onChange={(event) => edit({ workspacePath: event.target.value })}>
                <option value="">暂不指定</option>
                {(view?.projects ?? []).filter((project) => project.sourcePath && !project.unverified).map((project) => (
                  <option key={project.projectKey} value={project.sourcePath}>{project.name} {project.shortPath}</option>
                ))}
              </select>
            </Field> : null}
            <Field label="关联父节点" htmlFor="dshdg-plan-parent">
              <select
                id="dshdg-plan-parent"
                value={draft.parentNodeId}
                data-dshdg-plan-parent=""
                onChange={(event) => edit({ parentNodeId: event.target.value, workspacePath: '' })}
              >
                <option value="">（不关联，作为顶层）</option>
                {selectedParent === null ? null : (
                  <option value={selectedParent.nodeId}>{`（已选，当前不可见）${selectedParent.nodeId}`}</option>
                )}
                {choices.map((choice) => (
                  <option key={choice.nodeId} value={choice.nodeId}>
                    {`${'　'.repeat(Math.min(choice.depth, 6))}${choice.label}（${choice.nodeId}）`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <h4>同批节点</h4>
          <ul className="dshdg-list">
            {draft.rows.map((row, index) => (
              <li className="dshdg-item" key={`plan-row-${index}`}>
                <div className="dshdg-row">
                  <span className="dshdg-faint dshdg-mono">{`第 ${index + 1} 行`}</span>
                  <span className="dshdg-spacer" />
                  <button type="button" disabled={draft.rows.length <= 1} onClick={() => removeRow(index)}>
                    移除
                  </button>
                </div>
                <div className="dshdg-grid">
                  <Field label="节点标题" htmlFor={`dshdg-plan-row-title-${index}`}>
                    <input
                      id={`dshdg-plan-row-title-${index}`}
                      type="text"
                      value={row.title}
                      data-dshdg-plan-row-title={index}
                      onChange={(event) => updateRow(index, { title: event.target.value })}
                    />
                  </Field>
                  <Field label="节点目标" htmlFor={`dshdg-plan-row-goal-${index}`}>
                    <input
                      id={`dshdg-plan-row-goal-${index}`}
                      type="text"
                      value={row.goalDescription}
                      data-dshdg-plan-row-goal={index}
                      onChange={(event) => updateRow(index, { goalDescription: event.target.value })}
                    />
                  </Field>
                  <Field label="父节点" htmlFor={`dshdg-plan-row-parent-${index}`} hint="可选：选本批的另一行，可一次建出更深一级">
                    <select
                      id={`dshdg-plan-row-parent-${index}`}
                      value={row.parent}
                      data-dshdg-plan-row-parent={index}
                      onChange={(event) => updateRow(index, { parent: event.target.value })}
                    >
                      <option value="">{index === 0 ? '（不关联，作为顶层）' : '（与第一行同级）'}</option>
                      {draft.rows.map((_candidate, at) => (at === index ? null : (
                        <option key={`row-option-${at}`} value={`row:${at}`}>{`第 ${at + 1} 行`}</option>
                      )))}
                    </select>
                  </Field>
                </div>
              </li>
            ))}
          </ul>
          <div className="dshdg-row">
            <button type="button" data-dshdg-plan-add-row="" disabled={busy || draft.rows.length >= 32} onClick={addRow}>
              再加一行（作为上一行的子节点）
            </button>
            <span className="dshdg-spacer" />
            <button type="button" onClick={close}>取消</button>
            <button
              type="button"
              className="dshdg-primary"
              data-dshdg-plan-create-submit=""
              disabled={busy}
              onClick={() => { void submit(); }}
            >
              {busy ? '创建中…' : '创建规划'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TasksPanel({ store, snapshot }) {
  const tasks = snapshot.tasks ?? [];
  const detail = snapshot.taskDetail;
  const plan = useTaskAutoRefresh({ store, snapshot });
  const liveCount = tasks.filter(isLiveTask).length;
  const detailRef = useRef(null);
  /**
   * Open one task's detail from ANYWHERE in this panel (tree round, flat row, note).
   *
   * One handler for every entry point, so the tree cannot grow a second, subtly
   * different way of opening a task. It is the store's existing action: the same
   * request, the same refusal reporting, the same focus/scroll counter.
   * @param {string} taskId - stable task identity from the projection.
   * @returns {void}
   */
  const openTask = useCallback((taskId) => {
    if (typeof taskId !== 'string' || taskId === '') return;
    void store.openTask(taskId);
  }, [store]);
  const treeView = snapshot.tree ?? null;
  const flatOnly = treeView === null;
  // The dependency is the count of SUCCESSFUL opens, not the task object: a background
  // list refresh recomposes `taskDetail` (same task, merged row) and must NOT steal the
  // operator's focus. A first open, a repeat open of the SAME task and a switch to a
  // DIFFERENT task each bump the counter, so each one focuses and scrolls.
  const detailView = snapshot.taskDetailView ?? 0;
  useLayoutEffect(() => {
    if (detailView === 0 || !flatOnly) return;
    const node = detailRef.current;
    if (node === null || node === undefined) return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      // A non-focusable environment (or a test double) is not a reason to break render.
    }
    try {
      node.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    } catch {
      // Scrolling is best-effort; focus already moved the operator's reading point.
    }
  }, [detailView, flatOnly]);
  const changing = hasChangingRecords([
    ...tasks,
    ...(detail === null || detail === undefined ? [] : [detail]),
  ]);
  return (
    <div className="dshdg-panel">
      <div className="dshdg-row">
        <p className="dshdg-muted">这里只记录执行事实。执行完成不等于被接受：“等待宿主审查”要由宿主端单独给出结论。</p>
        <span className="dshdg-spacer" />
        <span className="dshdg-hint" data-dshdg-refresh-hint="">
          {changing !== true
            ? '当前没有会变化的记录。页面打开且可见时，每 15 秒只读检查一次，新派发的任务会自动出现；切回本页会立即刷新。'
            : `${liveCount > 0 ? `有 ${liveCount} 个进行中的任务；` : ''}有记录可能变化（待审或结论保存中），页面可见时每 5 秒只读刷新一次（不调用模型）。`}
        </span>
        <button type="button" disabled={snapshot.loading?.tasks === true} onClick={() => { void store.refreshTasks('manual'); }}>
          {snapshot.loading?.tasks === true ? '读取中…' : '刷新'}
        </button>
      </div>
      {plan.refreshError !== null && plan.refreshError !== undefined ? (
        <p className="dshdg-warn">
          自动刷新失败（{String(plan.refreshError)}），下面仍是上次读取的内容；可点“刷新”重试。
        </p>
      ) : null}
      {/* A read that FAILED is stated once, here, right above what it could not
          refresh. It is separate from "no records": an empty list must never stand in
          for a refused read. */}
      {snapshot.tasksError !== null && snapshot.tasksError !== undefined ? (
        <p className="dshdg-warn" role="alert" data-dshdg-tasks-error="">
          {`读取任务记录失败：${describeError(snapshot.tasksError)}。下面仍是上次读取的内容，可能已经过时；可点“刷新”重试。`}
        </p>
      ) : null}
      {snapshot.taskDetailError !== null && snapshot.taskDetailError !== undefined ? (
        <p className="dshdg-warn" role="alert">
          {`打开任务详情失败：${describeError(snapshot.taskDetailError)}。可再点一次“详情”重试。`}
        </p>
      ) : null}
      {detail === null && snapshot.taskDetailLoading === true ? (
        <p className="dshdg-hint" role="status">正在读取任务详情…</p>
      ) : null}
      {/* Legacy hosts keep the list's original detail presentation. */}
      {detail === null || !flatOnly ? null : (
        <div
          ref={detailRef}
          tabIndex={-1}
          data-dshdg-task-detail=""
          aria-label="任务详情"
        >
          <TaskDetail store={store} task={detail} />
        </div>
      )}
      <TaskTreePanel store={store} snapshot={snapshot} onOpen={openTask} />
      <PlanCreateForm store={store} snapshot={snapshot} view={treeView} />
      {flatOnly && tasks.length === 0 ? <p className="dshdg-faint">还没有任务记录。</p> : null}
      {flatOnly ? (
        <div className="dshdg-list" data-dshdg-flat-list="">
          {tasks.map((task) => {
            const progress = taskProgress(task);
            // The ONE headline for this task: it already reflects a recorded review, so
            // the raw state label can never sit next to a "审查通过" badge contradicting it.
            const outcome = taskOutcome(task);
            // Only a phase that says something DIFFERENT is shown (a live run); a finished
            // or reviewed task would otherwise repeat its own headline.
            const phase = outcome.phaseLabel;
            return (
              <div className="dshdg-item" key={task.taskId}>
                <div className="dshdg-item-head">
                  <span>{task.title || task.taskId}</span>
                  <Badge tone={isAwaitingPermission(task) ? 'warn' : outcome.tone}>
                    {outcome.label}
                  </Badge>
                  {phase === null ? null : <Badge tone={progress.tone}>{phase}</Badge>}
                  {isAwaitingPermission(task) ? <Badge tone="warn">{PERMISSION_STATE_LABELS.pending}</Badge> : null}
                  <span className="dshdg-mono dshdg-faint">
                    {task.config?.worker?.model ?? task.effective?.worker?.model ?? '—'}
                    {' / '}
                    {task.config?.worker?.reasoningEffort ?? task.effective?.worker?.reasoningEffort ?? '不指定'}
                  </span>
                  <span className="dshdg-spacer" />
                  <span className="dshdg-faint">{formatTime(task.createdAt)}</span>
                  <button
                    type="button"
                    disabled={snapshot.taskDetailLoading === true}
                    onClick={() => openTask(task.taskId)}
                  >
                    {snapshot.taskDetailLoading === true && snapshot.taskDetail?.taskId !== task.taskId
                      ? '读取中…'
                      : '详情'}
                  </button>
                  <button
                    type="button"
                    className="dshdg-danger"
                    disabled={!isCancellable(task.state)}
                    onClick={() => { void store.cancelTask(task.taskId); }}
                  >
                    取消
                  </button>
                </div>
                <p className="dshdg-hint">{progress.headline}</p>
                <TaskListNote task={task} onOpen={() => openTask(task.taskId)} />
                {isAwaitingPermission(task)
                  ? <p className="dshdg-hint">{permissionSummary(task).note}</p>
                  : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="dshdg-faint">{`状态集合：${TASK_STATES.map(taskStateLabel).join(' / ')}`}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Codex integration
// ---------------------------------------------------------------------------

/**
 * One target row: a single fact, with its own badge.
 *
 * The three targets are separate rows because they are separate facts. The page
 * must never let an operator read "agent installed" as "delegation authorized".
 * @param {object} props - `view`, a value from `codexTargetView`.
 * @returns {object} the row.
 */
function CodexTargetRow({ view }) {
  const paths = Array.isArray(view.paths) ? view.paths : [];
  return (
    <div className="dshdg-item">
      <div className="dshdg-item-head">
        <strong>{view.label}</strong>
        <Badge tone={view.tone}>{view.detail}</Badge>
        <span className="dshdg-spacer" />
        <span className="dshdg-mono dshdg-faint">{paths[0] ?? ''}</span>
      </div>
      {paths.length > 1 ? <p className="dshdg-mono dshdg-faint">{paths.slice(1).join('；')}</p> : null}
    </div>
  );
}

/**
 * The Codex integration card.
 *
 * Only explicit clicks write anything: `install` / `repair` / `remove` are the
 * plugin's own buttons and nothing else in `init()` or a save calls them. The card
 * also states, in the panel itself, what Codex has to do afterwards (reload) and
 * that the plugin does not claim any particular `@`-selection behaviour for a Codex
 * surface.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the card.
 */
function CodexPanel({ store, snapshot }) {
  const codex = snapshot.codex ?? null;
  const error = snapshot.codexError ?? null;
  const busy = snapshot.loading?.codexAction === true;
  const refreshing = snapshot.loading?.codexStatus === true;
  const agentView = codexTargetView(codex, null, 'agent');
  const mcpView = codexTargetView(codex, null, 'mcp');
  // The switch is reported from the delegation posture the page already reads. It
  // is displayed here so "files installed" is never confused with "dispatch allowed";
  // this card never turns it on.
  const switchAuthorized = snapshot.status?.delegation?.authorized === true
    || snapshot.settings?.delegationEnabled === true;
  const switchView = codexTargetView(codex, { authorized: switchAuthorized }, 'switch');
  const ready = codex?.ready === true;
  const notes = Array.isArray(codex?.notes) ? codex.notes : [];
  const disabled = busy || refreshing || codex === null;
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-codex-title">
      <div className="dshdg-row">
        <h3 id="dshdg-codex-title">Codex 集成（技能 Skill + MCP）</h3>
        <span className="dshdg-spacer" />
        <Badge tone={ready ? 'on' : 'off'}>{ready ? '已就绪' : '未就绪'}</Badge>
      </div>
      <p className="dshdg-muted">
        {'点下面的按钮，把原生技能 '}
        <span className="dshdg-mono">skills/dsh-taskbridge/SKILL.md</span>
        {' 装进 Codex 目录，并在 Codex 的 '}
        <span className="dshdg-mono">config.toml</span>
        {' 里登记本插件的 stdio MCP 服务（全套 11 个 delegate_* 工具：delegate_status / delegate_preflight / delegate_plan / delegate_submit / delegate_wait / delegate_permission_decide / delegate_question_answer / delegate_result / delegate_review / delegate_cancel / delegate_metrics）。'
          + '首次安装只会由你点击触发：打开本页、安装或升级本插件都不会自动创建技能文件或 MCP 条目。'
          + '若目录里存在早期版本写入且未经你改动的旧子智能体文件（agents/dsh-taskbridge.toml / agents/dsh-delegate.toml），'
          + '插件会在升级或安装时自动迁移为原生技能并安全移除旧文件；你手动改过的旧文件会原样保留不删。'
          + '已经安装过的情况下，插件下次启动也会把本插件自己写入的过期托管 MCP 条目就地更新（例如补上 tool_timeout_sec），'
          + '不触碰非托管条目或 Codex 的其他设置。'}
      </p>
      {error === null ? null : <p className="dshdg-fail">{error}</p>}
      {codex === null ? (
        <p className="dshdg-faint">正在读取 Codex 状态…</p>
      ) : (
        <>
          <p className="dshdg-faint">
            {'Codex 目录：'}
            <span className="dshdg-mono">{String(codex.codexHome ?? '')}</span>
            {'（设置环境变量 CODEX_HOME 可改到别处）'}
          </p>
          <div className="dshdg-list" data-dshdg-codex-targets="">
            <CodexTargetRow view={agentView} />
            <CodexTargetRow view={mcpView} />
            <CodexTargetRow view={switchView} />
          </div>
          {codex.mcp?.state === 'outdated' ? (
            <p className="dshdg-hint" data-dshdg-codex-drift="">
              {'这个托管 MCP 条目已经过期：'}
              {codexMcpDriftText(codex.mcp)}
              {'。插件下次启动会自动在原地更新；也可以点上面的「安装 / 更新 TaskBridge 技能」。'}
            </p>
          ) : null}
          {notes.length === 0 ? null : (
            <ul className="dshdg-hint">
              {notes.map((note) => <li key={note.code}>{note.text}</li>)}
            </ul>
          )}
          <div className="dshdg-row">
            <button type="button" disabled={busy || refreshing} onClick={() => { void store.refreshCodexStatus(); }}>
              {refreshing ? '读取中…' : '刷新状态'}
            </button>
            <button type="button" className="dshdg-primary" disabled={disabled} onClick={() => { void store.runCodexAction('install'); }}>
              {busy ? '处理中…' : '安装 / 更新 TaskBridge 技能'}
            </button>
            <button type="button" disabled={disabled} onClick={() => { void store.runCodexAction('repair'); }}>
              仅修复 MCP 配置
            </button>
            <button type="button" className="dshdg-danger" disabled={disabled} onClick={() => { void store.runCodexAction('remove'); }}>
              移除插件托管项
            </button>
          </div>
          {snapshot.codexOutcome === null || snapshot.codexOutcome === undefined
            ? null
            : <p className="dshdg-hint">{describeCodexOutcome(snapshot.codexOutcome)}</p>}
        </>
      )}
      <p className="dshdg-hint">
        {'安装后需要让 Codex 重新载入：新开会话或重启 Codex，才会读到新的原生技能和 MCP 条目。'
          + 'Codex 会话在明确指派时（例如 $dsh-taskbridge 或明确要求交给 DSH / TaskBridge）会按技能规则由当前会话直接调用 delegate_submit 与单链 delegate_wait（利用 tool_timeout_sec = 3660 静默长等，不再派生子智能体并做 wait_agent 短轮询）。'
          + '技能只在明确指派时派发任务，并在提交前先检查上面的本机调用开关；本页不会替你打开该开关。'
          + '同名的自定义技能文件或你手动改过的旧 agents/*.toml 都会被保留而不被覆盖或删除；没有本插件托管标记注释的同名 MCP 条目也视为你自己写的，不会被覆盖或删除。'}
      </p>
    </section>
  );
}

/**
 * The Antigravity integration card: manages the self-contained plugin bundle under
 * `<ANTIGRAVITY_CONFIG_DIR>/plugins/dsh-taskbridge/` without touching global config.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the card.
 */
function AntigravityPanel({ store, snapshot }) {
  const antigravity = snapshot.antigravity ?? null;
  const error = snapshot.antigravityError ?? null;
  const busy = snapshot.loading?.antigravityAction === true;
  const refreshing = snapshot.loading?.antigravityStatus === true;
  const pluginView = antigravityTargetView(antigravity, null, 'plugin');
  const mcpView = antigravityTargetView(antigravity, null, 'mcp');
  const switchAuthorized = snapshot.status?.delegation?.authorized === true
    || snapshot.settings?.delegationEnabled === true;
  const switchView = antigravityTargetView(antigravity, { authorized: switchAuthorized }, 'switch');
  const ready = antigravity?.ready === true;
  const notes = Array.isArray(antigravity?.notes) ? antigravity.notes : [];
  const disabled = busy || refreshing || antigravity === null;
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-antigravity-title">
      <div className="dshdg-row">
        <h3 id="dshdg-antigravity-title">Antigravity 集成（插件包 + Skill + 子智能体 + MCP）</h3>
        <span className="dshdg-spacer" />
        <Badge tone={ready ? 'on' : 'off'}>{ready ? '已就绪' : '未就绪'}</Badge>
      </div>
      <p className="dshdg-muted">
        {'点下面的按钮，把独立的 TaskBridge 插件装进 Antigravity 插件目录（'}
        <span className="dshdg-mono">plugins/dsh-taskbridge/</span>
        {'），内含 '}
        <span className="dshdg-mono">plugin.json</span>
        {'、按需加载的 '}
        <span className="dshdg-mono">skills/dsh-taskbridge/SKILL.md</span>
        {'、后台派工子智能体 '}
        <span className="dshdg-mono">agents/dsh-taskbridge.md</span>
        {' 以及插件内独立 '}
        <span className="dshdg-mono">mcp_config.json</span>
        {'。不会修改 Antigravity 全局 '}
        <span className="dshdg-mono">mcp_config.json</span>
        {' 或 '}
        <span className="dshdg-mono">config.json</span>
        {'。首次安装只会由你点击触发；已安装且未被手动修改的文件会在插件升级后自动刷新。'}
      </p>
      {error === null ? null : <p className="dshdg-fail">{error}</p>}
      {antigravity === null ? (
        <p className="dshdg-faint">正在读取 Antigravity 状态…</p>
      ) : (
        <>
          <p className="dshdg-faint">
            {'Antigravity 配置目录：'}
            <span className="dshdg-mono">{String(antigravity.antigravityHome ?? '')}</span>
            {'（设置环境变量 ANTIGRAVITY_CONFIG_DIR 可改到别处）'}
          </p>
          <div className="dshdg-list" data-dshdg-antigravity-targets="">
            <CodexTargetRow view={pluginView} />
            <CodexTargetRow view={mcpView} />
            <CodexTargetRow view={switchView} />
          </div>
          {notes.length === 0 ? null : (
            <ul className="dshdg-hint">
              {notes.map((note) => <li key={note.code}>{note.text}</li>)}
            </ul>
          )}
          <div className="dshdg-row">
            <button type="button" disabled={busy || refreshing} onClick={() => { void store.refreshAntigravityStatus(); }}>
              {refreshing ? '读取中…' : '刷新状态'}
            </button>
            <button type="button" className="dshdg-primary" disabled={disabled} onClick={() => { void store.runAntigravityAction('install'); }}>
              {busy ? '处理中…' : '安装 / 更新 Antigravity 插件'}
            </button>
            <button type="button" disabled={disabled} onClick={() => { void store.runAntigravityAction('repair'); }}>
              仅修复 MCP 配置
            </button>
            <button type="button" className="dshdg-danger" disabled={disabled} onClick={() => { void store.runAntigravityAction('remove'); }}>
              移除插件托管项
            </button>
          </div>
          {snapshot.antigravityOutcome === null || snapshot.antigravityOutcome === undefined
            ? null
            : <p className="dshdg-hint">{describeAntigravityOutcome(snapshot.antigravityOutcome)}</p>}
        </>
      )}
      <p className="dshdg-hint">
        {'安装后 Antigravity 会自动发现插件（或在重启 / 新开对话后加载新的 MCP 工具与技能）。'
          + '你可以在 Antigravity 对话中通过 @dsh-taskbridge 或明确要求“交给 DSH 执行”触发派工，也可由主智能体通过后台子智能体并行盯梢多个独立隔离任务。'
          + '本页不会替你打开顶部的本机调用开关；被你手动编辑过的 SKILL.md、子智能体或 MCP 配置会被保留并报告，不会被覆盖或删除。'}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

/** Tab definitions: authorization is not a tab — it renders above all five. */
const TABS = Object.freeze([
  { key: 'providers', label: '接口管理' },
  { key: 'execution', label: '执行设置' },
  { key: 'tasks', label: '任务记录' },
  { key: 'codex', label: 'Codex 集成' },
  { key: 'antigravity', label: 'Antigravity 集成' },
]);

/**
 * The page registered as this bundle's configuration in the Plugins manager.
 *
 * Props arrive from the slot registration's `inject` face: `{ store }`, plus the
 * slot owner props `{ view }` (always `'page'` here) and the optional host
 * `form`, which this page deliberately ignores — its save control belongs to
 * the plugin's own user-plane store, not to the host config form.
 * @param {object} props - `store`, and the slot owner props.
 * @returns {object} the page.
 */
export function DelegateConfigPage(props) {
  const store = props.store;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
  const [tab, setTab] = useState(TABS[0].key);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void store.init();
  }, [store]);

  const problems = useMemo(
    () => (snapshot.draft === null ? [] : precheckDraft(snapshot.draft)),
    [snapshot.draft],
  );
  const tabRefs = useRef(new Map());

  return (
    <div className="dshdg-root">
      <Notices store={store} notices={snapshot.notices ?? []} />

      <AuthorizationPanel store={store} snapshot={snapshot} />

      <div className="dshdg-tabs" role="tablist" aria-label="DSH 委托设置">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            className="dshdg-tab"
            id={`dshdg-tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`dshdg-panel-${entry.key}`}
            tabIndex={tab === entry.key ? 0 : -1}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(entry.key);
              else tabRefs.current.set(entry.key, node);
            }}
            onClick={() => setTab(entry.key)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = TABS.findIndex((candidate) => candidate.key === tab);
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = TABS[(index + step + TABS.length) % TABS.length];
              setTab(next.key);
              tabRefs.current.get(next.key)?.focus?.();
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        className="dshdg-panel"
        role="tabpanel"
        id={`dshdg-panel-${tab}`}
        aria-labelledby={`dshdg-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'providers' ? <ProvidersPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'execution' ? <ExecutionPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'tasks' ? (
          <SessionNavigation.Provider value={props.uiWorkspace || props.workspaces ? props : null}>
            <TasksPanel store={store} snapshot={snapshot} />
          </SessionNavigation.Provider>
        ) : null}
        {tab === 'codex' ? <CodexPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'antigravity' ? <AntigravityPanel store={store} snapshot={snapshot} /> : null}
      </div>

      <div className="dshdg-row" data-dshdg-autosave="">
        <span className="dshdg-hint" role="status" aria-live="polite">
          {autosaveLine(snapshot, problems)}
        </span>
        <span className="dshdg-spacer" />
        <button
          type="button"
          disabled={snapshot.dirty !== true || snapshot.loading?.save === true}
          title={snapshot.loading?.save === true ? '正在保存，稍后可放弃修改' : undefined}
          onClick={() => { store.resetDraft(); }}
        >
          放弃修改
        </button>
      </div>
      <p className="dshdg-faint">
        修改会自动保存：开关与下拉立即保存，文本输入停顿后合并保存。保存会整体替换设置文档；正在运行的任务保留它自己的快照。密钥从不随设置保存或导出。
      </p>
    </div>
  );
}

/** Re-exported so the documented contract and tests share one name for the body document. */
export {
  ANTIGRAVITY_ACTIONS,
  CODEX_ACTIONS,
  ROUTES,
  antigravityTargetView,
  codexTargetView,
  describeAntigravityOutcome,
  describeCodexOutcome,
  describeError,
  documentFromDraft,
  exportDocument,
  planCreateRequest,
};

export {
  CLEANUP_PRESETS,
  MAX_CLEANUP_CHAINS,
  cleanupBlockerLabel,
  cleanupCandidates,
  cleanupConfirmText,
  cleanupOutcome,
  cleanupProjection,
  cleanupRequest,
  cleanupSelectionKey,
  cleanupSelectionSummary,
  cleanupWarningText,
  describeCleanupOutcome,
  describeOrphanCleanupOutcome,
  pruneCleanupSelection,
  selectCleanupCandidatesByPreset,
  toggleCleanupSelection,
  withSelectionState,
} from './task-cleanup.js';


/**
 * Re-exported so a consumer (and `lib/client.d.ts`) reaches the native navigation through the
 * one module the bundle exports, rather than a second module identity.
 *
 * `registerTasksNavigation` is kept even though `apply` no longer mounts it: it is a published
 * helper of this bundle (and `lib/client.d.ts` declares it), and a host or a future build may
 * still mount the record panel itself. The task records are reached from the plugin's own
 * settings page (`plugins.bundle.config` → 「任务记录」), not from a sidebar row.
 */
export {
  MAIN_SLOT,
  SIDEBAR_PANEL_SLOT,
  TASKS_NAV_KEY,
  TASKS_NAV_LABEL,
  archivedSourceNote,
  groupTitle,
  knownSessionIds,
  locateSession,
  navViewModel,
  projectLabel,
  registerTasksNavigation,
  resolveService,
  resolveUiWorkspace,
  resolveWorkspaces,
  sessionPlacement,
  shortSessionId,
  taskSessionId,
  workspacesSnapshot,
  TaskbridgeNavPanel,
  TaskbridgeSidebarIcon,
} from './sidebar.jsx';

/**
 * The TaskBridge sidebar integration and its pure view model.
 *
 * Re-exported for the same reason as the navigation above: one module identity, so a consumer
 * and `lib/client.d.ts` reach the same functions. `registerSessionRowMarker` is the ONLY thing
 * this bundle registers inside the shell's workspace area — a per-row marker in the host's own
 * published child slot. The parent slot stays the host's.
 */
export {
  DispatchedSessionMarker,
  SESSION_ROW_ACTION_ID,
  SESSION_ROW_ACTION_ORDER,
  SESSION_ROW_ACTION_SLOT,
  TaskbridgeGrouping,
  WORKSPACES_PRIORITY,
  WORKSPACES_SLOT,
  WORKSPACE_VIEWS,
  askConfirm,
  askText,
  dispatchProof,
  hostService,
  loadSessionMap,
  registerSessionRowMarker,
  registerWorkspacesBrowser,
  shortId,
  stableSnapshot,
  workspacesViewMode,
} from './workspaces-browser.jsx';
export {
  GROUP_KINDS,
  identityRows,
  isManagedRootPath,
  projectNameOf,
  readWorkspacesSnapshot,
  sessionIndex,
  sessionTitles,
  sourcePathKey,
  workspaceGroups,
  workspaceItems,
} from './workspace-groups.js';
