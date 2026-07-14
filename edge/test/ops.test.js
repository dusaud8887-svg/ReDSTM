import assert from "node:assert/strict";
import test from "node:test";

import { compareBoardPriority, safeCodeLabels } from "../public/ops.js";

test("renders every safe publish rollback outcome without exposing raw detail", () => {
  for (const code of [
    "publish_report_invalid",
    "publish_smoke_confirmation_failed",
    "publish_reconciliation_limit",
    "publish_rollback_unavailable",
    "publish_rollback_failed",
    "publish_smoke_failed_rolled_back",
    "publish_rollback_smoke_failed",
    "publish_rollback_confirmation_failed",
  ]) assert.ok(safeCodeLabels[code]);
});

test("renders every bounded export and publish recovery outcome", () => {
  for (const code of [
    "incremental_base_invalid",
    "incremental_bootstrap_required",
    "incremental_state_invalid",
    "incremental_source_changed",
    "incremental_source_rewound",
    "incremental_projection_untracked",
    "incremental_snapshot_changed",
    "incremental_delta_too_large",
    "incremental_publish_bootstrap_required",
    "incremental_publish_validation_failed",
    "incremental_publish_ledger_invalid",
    "incremental_publish_smoke_marker_invalid",
    "incremental_publish_smoke_pointer_conflict",
    "incremental_publish_predecessor_unavailable",
  ]) assert.ok(safeCodeLabels[code]);
});

test("orders board attention lexicographically even with large counters", () => {
  const ordered = [
    { board_id: "pending", pending: Number.MAX_SAFE_INTEGER },
    { board_id: "retry", retry: 1 },
    { board_id: "dead", dead: 1 },
    { board_id: "warning", warning_code: "parse_drift" },
    { board_id: "running", last_outcome: "running" },
  ].sort(compareBoardPriority);

  assert.deepEqual(ordered.map((board) => board.board_id), [
    "running",
    "warning",
    "dead",
    "retry",
    "pending",
  ]);
  assert.equal(
    compareBoardPriority({ board_id: "a" }, { board_id: "b" }),
    -1,
  );
});
