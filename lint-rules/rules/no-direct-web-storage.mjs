// Keep UI state in Web Storage with `usePersistedState`
// (src/client/hooks/use-persisted-state.ts): it reads and validates the stored
// value with Zod on the first render, writes in its stable setter, keeps every
// mounted consumer of a key in agreement, keeps working in memory when storage
// is blocked or full, and follows other tabs when asked. Module-level stores
// use the guarded helpers in src/client/lib/browser-storage.ts. Enabled for
// src/client, src/components and src/lib; tests may seed storage directly.
import { staticKeyName } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isListedFile } from '../lib/exceptions.mjs';
import exceptions from './no-direct-web-storage.exceptions.json' with { type: 'json' };

const WEB_STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);

/** `window`, `globalThis` or `self`: the objects that expose Web Storage. */
function isWebStorageGlobal(node) {
  return node?.type === 'Identifier' && ['window', 'globalThis', 'self'].includes(node.name);
}

export default {
  meta: {
    docs: {
      description:
        'Reject localStorage and sessionStorage, read directly or from window, globalThis or self (including static computed keys and destructuring; a dynamic window[key] is not detected). A field of that name on other objects is allowed.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    // `exceptions` maps repository-relative paths to the reason each file
    // may touch Web Storage directly (src/client/lib/browser-storage.ts).
    if (isListedFile(context, Object.keys(context.options[0]?.exceptions ?? exceptions))) {
      return {};
    }
    const reported = new Set();
    const report = (node) => {
      const position = node.range?.[0] ?? node.start;
      if (reported.has(position)) {
        return;
      }
      reported.add(position);
      context.report({
        node,
        message:
          'Use usePersistedState or the helpers in src/client/lib/browser-storage.ts instead of localStorage/sessionStorage.',
      });
    };
    return {
      Identifier(node) {
        if (!WEB_STORAGE_NAMES.has(node.name)) {
          return;
        }
        const parent = node.parent;
        const isName =
          // `window.localStorage` is reported as a member access; `record.localStorage` is data.
          (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          // `{ localStorage: 'local' }` names a key; `{ localStorage }` reports its value.
          (parent?.type === 'Property' && parent.key === node && !parent.computed) ||
          (['PropertyDefinition', 'MethodDefinition', 'TSPropertySignature'].includes(
            parent?.type
          ) &&
            parent.key === node &&
            !parent.computed);
        if (!isName) {
          report(node);
        }
      },
      MemberExpression(node) {
        if (
          isWebStorageGlobal(node.object) &&
          WEB_STORAGE_NAMES.has(staticKeyName(node.property, node.computed))
        ) {
          report(node);
        }
      },
      VariableDeclarator(node) {
        // `const { localStorage: store } = window`
        if (node.id.type !== 'ObjectPattern' || !isWebStorageGlobal(node.init)) {
          return;
        }
        for (const property of node.id.properties) {
          if (
            property.type === 'Property' &&
            WEB_STORAGE_NAMES.has(staticKeyName(property.key, property.computed))
          ) {
            report(property);
          }
        }
      },
    };
  },
};
