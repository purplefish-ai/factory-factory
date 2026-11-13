// Keeps tRPC hooks and cache helpers for named procedures inside owner modules.
// Each entry in the `groups` option lists procedures, the module callers should
// `use`, its `owners` (that module and its helpers), the reason, and which
// helpers it covers: `cache` covers helpers that install options or write data
// (`useQuery`, `fetch`, `setData` and similar) plus `getQueryKey`, and `all`
// covers every hook, cache helper and key helper, including `useMutation`.
//
// `workspace.get` and `workspace.listForProject` use `cache`, so every read
// installs the snapshot reconciler (docs/architecture/workspace-state.md).
// `userSettings.get` and `userSettings.update` use `all`: settings are read and
// written only through `useUserSettings` and `useUpdateUserSettings` in
// src/client/lib/user-settings-queries.ts, which own the optimistic cache
// strategy and error toast. `userSettings.getProviderOptions` uses `cache` and
// is read through `useProviderOptions` in the same module, so every reader of
// the live model catalog shares one stale time. Tests are exempt so they can
// seed caches.
import { memberName } from '../lib/ast.mjs';
import { isListedFile } from '../lib/exceptions.mjs';

// tRPC React helpers that install query options or commit data for a key.
// Invalidation, cancellation, reset and cache reads reuse installed options.
const QUERY_CACHE_METHODS = new Set([
  'useQuery',
  'useSuspenseQuery',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
  'usePrefetchQuery',
  'usePrefetchInfiniteQuery',
  'queryOptions',
  'infiniteQueryOptions',
  'fetch',
  'fetchInfinite',
  'prefetch',
  'prefetchInfinite',
  'ensureData',
  'setData',
  'setInfiniteData',
  'setQueriesData',
]);

// tRPC helpers that build a key from a procedure reference.
const KEY_HELPERS = new Set(['getQueryKey', 'getMutationKey']);

/** Whether `node` is `<any>.<router>.<procedure>` for a dotted `path`, matched from the end. */
function isProcedure(node, path) {
  let current = node;
  for (const segment of path.split('.').toReversed()) {
    if (memberName(current) !== segment) {
      return false;
    }
    current = current.object;
  }
  return true;
}

export default {
  meta: {
    docs: {
      description:
        'Keep tRPC hooks and cache helpers for the procedures named in the groups option inside their owner modules.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                procedures: {
                  type: 'array',
                  items: { type: 'string', minLength: 1 },
                  minItems: 1,
                },
                // The module callers should use; other owners may be its helpers.
                use: { type: 'string', minLength: 1 },
                owners: {
                  type: 'array',
                  items: { type: 'string', minLength: 1 },
                  minItems: 1,
                },
                // `cache`: only helpers that install options or write data.
                // `all`: every hook and cache helper, including mutations.
                helpers: { enum: ['cache', 'all'] },
                reason: { type: 'string', minLength: 1 },
              },
              required: ['procedures', 'use', 'owners', 'helpers', 'reason'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    // Each group names procedures whose reads and writes must go through
    // one owner module, e.g. so every workspace read installs the snapshot
    // reconciler (docs/architecture/workspace-state.md).
    const groups = (context.options[0]?.groups ?? []).filter(
      (group) => !isListedFile(context, group.owners)
    );
    if (groups.length === 0) {
      return {};
    }
    const owningGroup = (node) => {
      for (const group of groups) {
        const procedure = group.procedures.find((path) => isProcedure(node, path));
        if (procedure) {
          return { group, procedure };
        }
      }
      return undefined;
    };
    const report = (node, { group, procedure }) =>
      context.report({
        node,
        message: `Use ${group.use} for ${procedure}; ${group.reason}.`,
      });
    return {
      MemberExpression(node) {
        const match = owningGroup(node.object);
        if (match && (match.group.helpers === 'all' || QUERY_CACHE_METHODS.has(memberName(node)))) {
          report(node, match);
        }
      },
      CallExpression(node) {
        const match = node.arguments[0] && owningGroup(node.arguments[0]);
        if (
          match &&
          node.callee.type === 'Identifier' &&
          KEY_HELPERS.has(node.callee.name) &&
          (match.group.helpers === 'all' || node.callee.name === 'getQueryKey')
        ) {
          report(node, match);
        }
      },
    };
  },
};
