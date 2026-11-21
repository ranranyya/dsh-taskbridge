import { Fragment, useMemo } from 'react';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';

import { formatTime, TREE_STATUS_LABELS, TREE_STATUS_TONES } from './api.js';

function recordTitle({ chain, node }) {
  return chain.displayTitle || chain.title || (node.kind === 'task' ? node.displayTitle : null) || '未记录标题';
}

function SelectionCell({ row, table }) {
  const { cleanup, candidates } = table.options.meta;
  const candidate = candidates.get(row.id);
  if (!candidate) return null;
  return (
    <div className="dshdg-record-selection" data-dshdg-cleanup-row={row.id}>
      <input
        type="checkbox"
        aria-label={`勾选整条执行链（${candidate.taskIds.length} 轮）：${recordTitle(row.original)}`}
        data-dshdg-cleanup-check={row.id}
        checked={row.getIsSelected()}
        disabled={!row.getCanSelect()}
        onChange={() => cleanup.onToggle(candidate)}
      />
      {candidate.selectable ? null : (
        <span className="dshdg-faint" data-dshdg-cleanup-blocked={row.id}>{candidate.reason}</span>
      )}
    </div>
  );
}

function RecordTitleCell({ row, table }) {
  const { chain, node } = row.original;
  // Expanding a row is the row's "详情" entry: the same handler the project tree's
  // round 详情 uses, so the newest round's EXISTING inline detail (and its 打开会话
  // control) opens below the row. Collapsing never reads a task.
  const { onToggleExpand } = table.options.meta;
  const toggle = () => {
    const willExpand = !row.getIsExpanded();
    row.toggleExpanded();
    if (willExpand) onToggleExpand?.(chain);
  };
  return (
    <div className="dshdg-record-name">
      <button type="button" className="dshdg-record-toggle" onClick={toggle}
        data-dshdg-record-toggle={row.id} aria-expanded={row.getIsExpanded()}>
        <span aria-hidden="true">{row.getIsExpanded() ? '▾' : '▸'}</span>
        {recordTitle(row.original)}
      </button>
      {node.kind === 'plan' && node.title && node.title !== recordTitle(row.original) ? (
        <small className="dshdg-faint">{node.title}</small>
      ) : null}
      {Number.isFinite(chain.roundCount) ? <small className="dshdg-faint">{chain.roundCount} 轮</small> : null}
    </div>
  );
}

function RecordStatusCell({ getValue }) {
  const status = getValue();
  const tone = TREE_STATUS_TONES[status] ?? 'off';
  return <span className={'dshdg-badge dshdg-badge-' + tone}>{TREE_STATUS_LABELS[status] ?? status}</span>;
}

/**
 * A row's 最近活动 time: ONE derived value, used by both the column and the comparator.
 *
 * `updatedAt || createdAt || 0` is the projection's own latest activity. The fallback
 * is only for a record that never recorded an update — it is the same value the cell
 * prints, so the column can never display one number while sorting by another.
 * @param {object} chain - one execution chain.
 * @returns {number} epoch milliseconds, `0` when nothing was recorded.
 */
function activityOf(chain) {
  return Number(chain?.updatedAt) || Number(chain?.createdAt) || 0;
}

/** Compare two numbers into -1/0/1 (a raw difference overflows once it is huge). */
function signed(value) {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/**
 * The comparator for every sortable column.
 *
 * TanStack 8.21 builds rows WITHOUT a back-reference to the table (`createRow` takes
 * only `original`/`getValue`/`index`), so a comparator cannot read the current sort
 * direction. What it can rely on is TanStack's own rule: a sortingFn always answers in
 * ASCENDING terms and the sorted model applies `desc` to that answer afterwards.
 *
 * The order is therefore made TOTAL on ascending terms — equal times never compare
 * equal — and the model's own flip then yields an exact mirror. Ties are broken by the
 * SAME keys for every column:
 *   1. the column's own value (`最近活动` = the host's `updatedAt || createdAt`),
 *   2. the chain's creation time — a chain that started later is the newer record,
 *   3. the recorded execution-chain id — a stable identity the host issues, never the
 *      array position, a title or a workspace path.
 * No timestamp is invented: the identity key only decides rows whose recorded times are
 * exactly equal, and it decides them the same way on every re-read, so any API order
 * draws the same table and ascending is the exact reverse of descending.
 * @param {object} left - row being compared.
 * @param {object} right - the other row.
 * @param {string} columnId - the sorted column.
 * @returns {number} ascending comparison of the two rows.
 */
function compareRecords(left, right, columnId) {
  const a = left.original.chain;
  const b = right.original.chain;
  const valueOf = (row, chain) => {
    if (columnId === 'title') return String(recordTitle({ chain, node: row.original.node }));
    if (columnId === 'project') return String(row.original.project?.name ?? '');
    if (columnId === 'status') return String(chain.nodeStatus ?? row.original.node?.nodeStatus ?? 'unknown');
    return activityOf(chain);
  };
  const leftValue = valueOf(left, a);
  const rightValue = valueOf(right, b);
  const primary = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  const created = signed((Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const leftId = String(a.chainId ?? left.id);
  const rightId = String(b.chainId ?? right.id);
  const byIdentity = leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  return primary || created || byIdentity;
}

const SELECTION_COLUMN = { id: 'selection', header: '清理', enableSorting: false, cell: SelectionCell };
const OTHER_COLUMNS = [
  { id: 'title', header: '任务', accessorFn: recordTitle, sortingFn: compareRecords, cell: RecordTitleCell },
  { id: 'project', header: '项目', accessorFn: ({ project }) => project.name, sortingFn: compareRecords,
    cell: ({ row }) => <span title={row.original.project.shortPath ?? undefined}>{row.original.project.name}</span> },
  { id: 'status', header: '状态', accessorFn: ({ chain, node }) => chain.nodeStatus ?? node.nodeStatus ?? 'unknown',
    enableSorting: false, cell: RecordStatusCell },
  { id: 'updatedAt', header: '最近活动', accessorFn: ({ chain }) => activityOf(chain),
    sortDescFirst: true, sortingFn: compareRecords, cell: ({ getValue }) => getValue() > 0 ? formatTime(getValue()) : '—' },
];
const DEFAULT_SORT = [{ id: 'updatedAt', desc: true }];
const EMPTY_SELECTION = Object.freeze({});
const ALL_COLUMNS = [SELECTION_COLUMN, ...OTHER_COLUMNS];

/**
 * The 最近任务 table.
 *
 * Columns are declared ONCE (a new array per render would reset TanStack's internal
 * memos), and the 清理 column is shown by `columnVisibility` alone: hidden columns are
 * never built, so `getCoreRowModel`, the sorted model and `getAllLeafColumns` all see
 * the same set — which is what lets the sorted row model actually order the rows.
 * @param {object} props - `records`, `hasPlans`, `hasRecords`, `cleanup`, `cleanupBusy`,
 *   `renderDetails(record)`, `onToggleExpand(chain)`.
 * @returns {object} the table, or the empty line.
 */
export function TaskRecordsTable({ records, hasPlans, hasRecords, cleanup, cleanupBusy, renderDetails, onToggleExpand }) {
  const candidates = useMemo(() => new Map((cleanup?.candidates ?? []).map((item) => [item.chainId, item])), [cleanup?.candidates]);
  const rowSelection = useMemo(() => Object.fromEntries(
    Object.entries(cleanup?.selection ?? EMPTY_SELECTION).map(([id, taskIds]) => [id, Array.isArray(taskIds)]),
  ), [cleanup?.selection]);
  const columnVisibility = useMemo(() => ({ selection: cleanup !== null }), [cleanup]);
  const table = useReactTable({
    data: records,
    columns: ALL_COLUMNS,
    getRowId: (record) => record.chain.chainId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowCanExpand: () => true,
    autoResetExpanded: false,
    autoResetPageIndex: false,
    enableMultiSort: false,
    enableSortingRemoval: false,
    enableRowSelection: (row) => cleanup !== null && !cleanupBusy && candidates.get(row.id)?.selectable === true,
    initialState: { sorting: DEFAULT_SORT },
    state: { rowSelection, columnVisibility },
    meta: { cleanup, candidates, onToggleExpand },
  });
  if (records.length === 0) {
    return <p className="dshdg-faint" data-dshdg-records-empty="">
      {hasRecords ? '没有符合当前条件的任务。' : hasPlans ? '暂无执行记录。未执行的计划可在项目树查看。' : '还没有执行记录。'}
    </p>;
  }
  return (
    <div className="dshdg-records-overflow">
      <table className="dshdg-records-table" aria-label="任务记录" data-dshdg-records-table="">
        <thead>
          {table.getHeaderGroups().map(({ id, headers }) => (
            <tr key={id}>
              {headers.map(({ id: headerId, column, getContext }) => {
                const sort = column.getIsSorted();
                return (
                  <th key={headerId} scope="col" data-column={column.id}
                    aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}>
                    {column.getCanSort() ? (
                      <button type="button" className="dshdg-record-sort" onClick={column.getToggleSortingHandler()}>
                        {flexRender(column.columnDef.header, getContext())}
                        <span aria-hidden="true">{sort === 'asc' ? '↑' : sort === 'desc' ? '↓' : '↕'}</span>
                      </button>
                    ) : flexRender(column.columnDef.header, getContext())}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <tr data-dshdg-record={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} data-column={cell.column.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
              {row.getIsExpanded() ? (
                <tr className="dshdg-record-expanded"><td colSpan={row.getVisibleCells().length}>{renderDetails(row.original)}</td></tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
