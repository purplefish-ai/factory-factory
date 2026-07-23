#!/usr/bin/env bash
#
# check-child-notification-duplicates.sh
#
# Diagnostic for the "duplicate parent<->child workspace messages" bug (H1 in
# docs/design/multi-child-workspace-duplicate-messages-analysis.md).
#
# It looks in the Factory Factory SQLite DB for pairs of workspace_notifications
# rows that share the same (target workspace, source workspace, direction, message
# text) but are DISTINCT rows created close together in time. That pattern is the
# smoking gun for H1: a blocked live-delivery call times out on the *external*
# agent's MCP client, the agent retries the tool call, and a second undeduplicable
# notification row is persisted -> a real duplicate agent turn (extra tokens).
#
# Usage:
#   ./scripts/check-child-notification-duplicates.sh [path-to-data.db]
#
# DB resolution order:
#   1. First CLI argument, if given
#   2. $DATABASE_PATH
#   3. $BASE_DIR/data.db
#   4. ~/factory-factory/data.db   (the documented default)
#
# Options (env vars):
#   WINDOW_SECONDS   Max gap between the two rows to count as a duplicate (default 600)
#
# Requires: sqlite3 on PATH. Opens the DB read-only, so it is safe to run against
# a live instance.

set -euo pipefail

WINDOW_SECONDS="${WINDOW_SECONDS:-600}"

# ---------------------------------------------------------------------------
# Resolve the database path
# ---------------------------------------------------------------------------
resolve_db() {
  if [[ $# -ge 1 && -n "${1:-}" ]]; then
    echo "$1"; return
  fi
  if [[ -n "${DATABASE_PATH:-}" ]]; then
    echo "$DATABASE_PATH"; return
  fi
  if [[ -n "${BASE_DIR:-}" && -f "$BASE_DIR/data.db" ]]; then
    echo "$BASE_DIR/data.db"; return
  fi
  echo "$HOME/factory-factory/data.db"
}

DB="$(resolve_db "$@")"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is not installed or not on PATH." >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "ERROR: database not found at: $DB" >&2
  echo "Pass the path explicitly:  $0 /path/to/data.db" >&2
  exit 1
fi

# Read-only connection string (safe against a running app; picks up WAL data).
URI="file:${DB}?mode=ro"

# Guard against copies that lack the notifications table, or predate the
# `direction` column (very old schema).
if ! sqlite3 "$URI" "SELECT 1 WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_notifications') AND EXISTS (SELECT 1 FROM pragma_table_info('workspace_notifications') WHERE name='direction');" | grep -q 1; then
  echo "ERROR: table 'workspace_notifications' or column 'direction' not found in $DB" >&2
  echo "This DB predates the child-workspace notification schema, or is the wrong file." >&2
  exit 1
fi

echo "=================================================================="
echo " Child-workspace duplicate-notification check"
echo " DB:            $DB"
echo " Time window:   ${WINDOW_SECONDS}s (pairs closer than this count as dupes)"
echo "=================================================================="
echo

# ---------------------------------------------------------------------------
# 0. Baseline: is there any data to analyze at all?
# ---------------------------------------------------------------------------
TOTAL="$(sqlite3 "$URI" "SELECT COUNT(*) FROM workspace_notifications;")"
echo "Total workspace_notifications rows: $TOTAL"
if [[ "$TOTAL" -eq 0 ]]; then
  echo
  echo "No notifications recorded in this DB — nothing to validate here."
  echo "(Either no parent<->child messaging happened against this file, or the"
  echo " affected run used a different DATABASE_PATH / instance.)"
  exit 0
fi

echo
echo "--- Notifications by direction ---"
sqlite3 -header -column "$URI" "
  SELECT direction, COUNT(*) AS n
  FROM workspace_notifications
  GROUP BY direction;"

# ---------------------------------------------------------------------------
# 1. THE SMOKING-GUN QUERY (Link 4): near-identical duplicate rows
# ---------------------------------------------------------------------------
echo
echo "=================================================================="
echo " Duplicate notification pairs (same source->target, same text,"
echo " distinct rows, within ${WINDOW_SECONDS}s of each other)"
echo "=================================================================="
DUPES="$(sqlite3 "$URI" "
  SELECT COUNT(*) FROM workspace_notifications a
  JOIN workspace_notifications b
    ON a.workspace_id = b.workspace_id
   AND a.source_workspace_id = b.source_workspace_id
   AND a.direction = b.direction
   AND a.message = b.message
   AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 >= 0
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 < ${WINDOW_SECONDS};")"

echo "Duplicate pairs found: $DUPES"
echo

if [[ "$DUPES" -eq 0 ]]; then
  echo "==> NO duplicate notification rows detected within the ${WINDOW_SECONDS}s window."
  echo "    This argues against H1/H3 for pairs that close-in-time — it does NOT"
  echo "    rule out H1/H3 duplication with a gap larger than WINDOW_SECONDS."
  echo "    Re-run with a larger WINDOW_SECONDS if you suspect a slower retry path."
  echo "    Any duplication you saw within this window would have to be"
  echo "    re-delivery of a single row (H2), which the id-keyed guards already"
  echo "    mostly handle."
  exit 0
fi

echo "==> DUPLICATE ROWS DETECTED — consistent with H1 (retry-after-timeout)"
echo "    and/or H3 (racing lifecycle notifications). Details below."
echo

echo "--- Duplicate pairs (id_1/id_2 distinct, gap in seconds, message truncated) ---"
sqlite3 -header -column "$URI" "
  SELECT a.direction,
         substr(a.source_workspace_id,1,10) AS src,
         substr(a.workspace_id,1,10)        AS target,
         a.id AS id_1, b.id AS id_2,
         a.created_at AS t1,
         ROUND((julianday(b.created_at) - julianday(a.created_at)) * 86400, 1) AS gap_s,
         substr(a.message,1,60) AS message_head
  FROM workspace_notifications a
  JOIN workspace_notifications b
    ON a.workspace_id = b.workspace_id
   AND a.source_workspace_id = b.source_workspace_id
   AND a.direction = b.direction
   AND a.message = b.message
   AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 >= 0
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 < ${WINDOW_SECONDS}
  ORDER BY t1;"

# ---------------------------------------------------------------------------
# 2. Gap distribution — a tight cluster implies a FIXED external timeout (H1)
# ---------------------------------------------------------------------------
echo
echo "--- Gap distribution (bucketed) ---"
echo "    A tight cluster (e.g. most gaps ~30-60s) implies a fixed external MCP"
echo "    timeout firing => strong H1 signal. A wide spread points more to H3."
sqlite3 -header -column "$URI" "
  WITH pairs AS (
    SELECT (julianday(b.created_at) - julianday(a.created_at)) * 86400 AS gap_s
    FROM workspace_notifications a
    JOIN workspace_notifications b
      ON a.workspace_id = b.workspace_id
     AND a.source_workspace_id = b.source_workspace_id
     AND a.direction = b.direction
     AND a.message = b.message
     AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
     AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 >= 0
     AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 < ${WINDOW_SECONDS}
  )
  SELECT CASE
           WHEN gap_s < 10  THEN '  0-10s'
           WHEN gap_s < 30  THEN ' 10-30s'
           WHEN gap_s < 60  THEN ' 30-60s'
           WHEN gap_s < 120 THEN ' 60-120s'
           ELSE '120s+'
         END AS gap_bucket,
         COUNT(*) AS pairs
  FROM pairs
  GROUP BY gap_bucket
  ORDER BY MIN(gap_s);"

# ---------------------------------------------------------------------------
# 3. Link 5 — did BOTH copies actually get delivered (i.e. real extra turns)?
# ---------------------------------------------------------------------------
echo
echo "--- Delivery status of duplicated rows (Link 5: real token cost?) ---"
echo "    Both rows delivered => two real agent turns => real extra tokens."
echo "    One or both rows still pending (delivered_at NULL) => delivery is incomplete."
sqlite3 -header -column "$URI" "
  SELECT
    SUM(CASE WHEN a.delivered_at IS NOT NULL AND b.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS both_delivered,
    SUM(CASE WHEN a.delivered_at IS NULL OR  b.delivered_at IS NULL THEN 1 ELSE 0 END)         AS one_or_none_delivered
  FROM workspace_notifications a
  JOIN workspace_notifications b
    ON a.workspace_id = b.workspace_id
   AND a.source_workspace_id = b.source_workspace_id
   AND a.direction = b.direction
   AND a.message = b.message
   AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 >= 0
   AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 < ${WINDOW_SECONDS};"

echo
echo "Done. See docs/design/multi-child-workspace-duplicate-messages-analysis.md"
echo "for how to read these results (H1 validation, links 4/5)."
