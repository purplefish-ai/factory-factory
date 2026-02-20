#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const summaryPath = path.resolve(process.cwd(), 'coverage', 'coverage-summary.json');

if (!fs.existsSync(summaryPath)) {
  console.error(`[coverage] Missing coverage summary: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

const groups = [
  {
    name: 'WebSocket Critical Surface',
    threshold: 65,
    files: [
      'src/backend/server.ts',
      'src/backend/routers/websocket/chat.handler.ts',
      'src/backend/routers/websocket/terminal.handler.ts',
      'src/backend/routers/websocket/dev-logs.handler.ts',
      'src/backend/routers/websocket/snapshots.handler.ts',
    ],
  },
  {
    name: 'Resource Accessor Critical Surface',
    threshold: 65,
    files: [
      'src/backend/resource_accessors/workspace.accessor.ts',
      'src/backend/resource_accessors/project.accessor.ts',
      'src/backend/resource_accessors/agent-session.accessor.ts',
      'src/backend/resource_accessors/terminal-session.accessor.ts',
      'src/backend/resource_accessors/user-settings.accessor.ts',
      'src/backend/resource_accessors/decision-log.accessor.ts',
    ],
  },
  {
    name: 'Run Script Critical Surface',
    threshold: 60,
    files: [
      'src/backend/domains/run-script/startup-script.service.ts',
      'src/backend/domains/run-script/run-script.service.ts',
      'src/backend/services/run-script-proxy.service.ts',
    ],
  },
  {
    name: 'Workspace Runtime Surface',
    threshold: 85,
    files: [
      'src/backend/domains/workspace/query/workspace-query.service.ts',
      'src/backend/domains/workspace/state/kanban-state.ts',
      'src/backend/domains/session/session-domain.service.ts',
    ],
  },
  {
    name: 'Workspace TRPC Surface',
    threshold: 88,
    files: [
      'src/backend/trpc/workspace/init.trpc.ts',
      'src/backend/trpc/workspace/ide.trpc.ts',
      'src/backend/trpc/workspace/run-script.trpc.ts',
      'src/backend/trpc/workspace/workspace-helpers.ts',
      'src/backend/trpc/user-settings.trpc.ts',
    ],
  },
];

const perFileThresholds = [
  { file: 'src/backend/server.ts', threshold: 50 },
  { file: 'src/backend/routers/websocket/chat.handler.ts', threshold: 60 },
  { file: 'src/backend/routers/websocket/terminal.handler.ts', threshold: 60 },
  { file: 'src/backend/resource_accessors/workspace.accessor.ts', threshold: 50 },
  { file: 'src/backend/resource_accessors/project.accessor.ts', threshold: 75 },
  { file: 'src/backend/resource_accessors/agent-session.accessor.ts', threshold: 70 },
  { file: 'src/backend/domains/run-script/startup-script.service.ts', threshold: 75 },
  { file: 'src/backend/domains/run-script/run-script.service.ts', threshold: 50 },
  { file: 'src/backend/services/run-script-proxy.service.ts', threshold: 70 },
  { file: 'src/backend/domains/workspace/query/workspace-query.service.ts', threshold: 85 },
  { file: 'src/backend/domains/workspace/state/kanban-state.ts', threshold: 80 },
  { file: 'src/backend/domains/session/session-domain.service.ts', threshold: 90 },
  { file: 'src/backend/trpc/workspace/init.trpc.ts', threshold: 85 },
  { file: 'src/backend/trpc/workspace/ide.trpc.ts', threshold: 90 },
  { file: 'src/backend/trpc/workspace/run-script.trpc.ts', threshold: 90 },
  { file: 'src/backend/trpc/workspace/workspace-helpers.ts', threshold: 85 },
  { file: 'src/backend/trpc/user-settings.trpc.ts', threshold: 85 },
  { file: 'src/backend/trpc/linear.trpc.ts', threshold: 90 },
  { file: 'src/backend/trpc/pr-review.trpc.ts', threshold: 95 },
  { file: 'src/backend/trpc/decision-log.trpc.ts', threshold: 95 },
  { file: 'src/backend/services/git-ops.service.ts', threshold: 90 },
  { file: 'src/backend/services/rate-limiter.service.ts', threshold: 90 },
  { file: 'src/backend/interceptors/branch-rename.interceptor.ts', threshold: 95 },
];

function getEntry(filePath) {
  const matched = Object.keys(summary).find((key) => key.endsWith(filePath));
  if (!matched) {
    throw new Error(`Coverage entry not found for ${filePath}`);
  }
  return summary[matched];
}

function formatPct(value) {
  return `${value.toFixed(2)}%`;
}

let hasFailure = false;

for (const group of groups) {
  let covered = 0;
  let total = 0;

  for (const file of group.files) {
    const entry = getEntry(file);
    covered += entry.lines.covered;
    total += entry.lines.total;
  }

  const pct = total === 0 ? 0 : (covered / total) * 100;
  const ok = pct >= group.threshold;

  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[coverage] ${status} ${group.name}: ${formatPct(pct)} (threshold ${group.threshold}%)`);

  if (!ok) {
    hasFailure = true;
  }
}

for (const item of perFileThresholds) {
  const entry = getEntry(item.file);
  const pct = entry.lines.pct;
  const ok = pct >= item.threshold;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[coverage] ${status} ${item.file}: ${formatPct(pct)} (threshold ${item.threshold}%)`);

  if (!ok) {
    hasFailure = true;
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log('[coverage] Critical coverage checks passed.');
