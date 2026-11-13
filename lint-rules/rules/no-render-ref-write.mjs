// Refs are written in effects and handlers, not while rendering
// (docs/architecture/client-state.md). Enabled for src/client, src/components
// and src/hooks outside tests.
import { isFunction, isIdentifier, memberName } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';

// Components and hooks by name: `function Panel()`, `const useThing = () => {}`,
// and the render function passed to `memo()` or `forwardRef()`.
const COMPONENT_OR_HOOK_NAME = /^(?:use[A-Z0-9]|[A-Z])/;

function functionName(node) {
  if (node.id?.name) {
    return node.id.name;
  }
  const parent = node.parent;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (
    parent?.type === 'CallExpression' &&
    parent.arguments[0] === node &&
    ['memo', 'forwardRef'].includes(
      parent.callee.type === 'Identifier' ? parent.callee.name : memberName(parent.callee)
    )
  ) {
    return functionName(parent);
  }
  return undefined;
}

function isComponentOrHook(node) {
  return isFunction(node) && COMPONENT_OR_HOOK_NAME.test(functionName(node) ?? '');
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current && !isFunction(current)) {
    current = current.parent;
  }
  return current;
}

/** `ref.current`, `ref.current!` or `(ref.current)` for the same `ref` text. */
function readsCurrentOf(node, sourceCode, objectText) {
  let current = node;
  while (current?.type === 'TSNonNullExpression' || current?.type === 'ParenthesizedExpression') {
    current = current.expression;
  }
  return (
    current?.type === 'MemberExpression' &&
    memberName(current) === 'current' &&
    sourceCode.getText(current.object) === objectText
  );
}

/** `if (ref.current === null)`, `== null`, `=== undefined` or `!ref.current`: lazy init. */
function isLazyInitTest(test, sourceCode, objectText) {
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    return readsCurrentOf(test.argument, sourceCode, objectText);
  }
  if (test.type !== 'BinaryExpression' || !['===', '=='].includes(test.operator)) {
    return false;
  }
  const empty = (side) =>
    (side.type === 'Literal' && side.value === null) || isIdentifier(side, 'undefined');
  return (
    (readsCurrentOf(test.left, sourceCode, objectText) && empty(test.right)) ||
    (readsCurrentOf(test.right, sourceCode, objectText) && empty(test.left))
  );
}

/** `ref.current ??= value`, or a write inside the consequent of a lazy-init `if`. */
function isLazyInit(assignment, fn, sourceCode) {
  if (assignment.operator === '??=') {
    return true;
  }
  const objectText = sourceCode.getText(assignment.left.object);
  let child = assignment;
  for (let node = assignment.parent; node && node !== fn; node = node.parent) {
    if (
      node.type === 'IfStatement' &&
      node.consequent === child &&
      isLazyInitTest(node.test, sourceCode, objectText)
    ) {
      return true;
    }
    child = node;
  }
  return false;
}

// Hook callbacks that React calls while rendering, by hook name and argument.
const RENDER_PHASE_CALLBACKS = { useMemo: 0, useState: 0, useReducer: 2 };

/** The component or hook whose render runs `fn`, looking through render-phase callbacks. */
function renderingFunction(fn) {
  let current = fn;
  for (;;) {
    const call = current?.parent;
    const name =
      call?.type === 'CallExpression' &&
      (call.callee.type === 'Identifier' ? call.callee.name : memberName(call.callee));
    if (
      !(name in RENDER_PHASE_CALLBACKS) ||
      call.arguments[RENDER_PHASE_CALLBACKS[name]] !== current
    ) {
      return current;
    }
    current = enclosingFunction(call);
  }
}

export default {
  meta: {
    docs: {
      description:
        'Reject assigning or incrementing ref.current directly in a component or hook body (a function named use… or starting with a capital, including one passed to memo or forwardRef), except lazy initialisation (if (ref.current === null), !ref.current, ??=).',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    const check = (node, target) => {
      if (target.type !== 'MemberExpression' || memberName(target) !== 'current') {
        return;
      }
      const fn = renderingFunction(enclosingFunction(node));
      if (!isComponentOrHook(fn)) {
        return;
      }
      if (node.type === 'AssignmentExpression' && isLazyInit(node, fn, context.sourceCode)) {
        return;
      }
      context.report({
        node,
        message:
          'Do not write a ref while rendering. Use useLatestRef or useStableCallback (src/client/hooks/use-stable-callback.ts) for the latest value, or write it in an effect or handler.',
      });
    };
    return {
      AssignmentExpression(node) {
        check(node, node.left);
      },
      UpdateExpression(node) {
        check(node, node.argument);
      },
    };
  },
};
