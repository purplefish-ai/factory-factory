// Memoize a context value or split state from commands
// (docs/architecture/client-state.md#context-values). Enabled for src/client,
// src/components and src/hooks outside tests.
import { isIdentifier, memberName, staticKeyName } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { jsxAttribute } from '../lib/jsx.mjs';

// A context element: `<Foo.Provider>` or a React 19 `<FooContext>`.
function isContextElement(name) {
  if (name.type === 'JSXMemberExpression') {
    return name.property.name === 'Provider';
  }
  return name.type === 'JSXIdentifier' && /^[A-Z]\w*Context$/.test(name.name);
}

function isContextReference(node) {
  if (node?.type === 'MemberExpression') {
    return memberName(node) === 'Provider';
  }
  return node?.type === 'Identifier' && /^[A-Z]\w*Context$/.test(node.name);
}

const FRESH_VALUE_TYPES = new Set([
  'ObjectExpression',
  'ArrayExpression',
  'ArrowFunctionExpression',
  'FunctionExpression',
  'ClassExpression',
  'NewExpression',
  'JSXElement',
  'JSXFragment',
]);
// Hooks whose result keeps its identity until their inputs change.
const STABLE_RESULT_HOOKS = new Set([
  'useMemo',
  'useCallback',
  'useRef',
  'useStableCallback',
  'useLatestRef',
]);
const TYPE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

/**
 * Whether an expression makes a new object, array or function each time it
 * runs: a literal (including JSX), a function, `new`, or a call other than a
 * hook that keeps its result's identity (`useMemo`, `useCallback`, `useRef`,
 * `useStableCallback`, `useLatestRef`); `useState` returns a new tuple each
 * render. Conditionals and logical operators are checked branch by branch.
 */
function isFreshValue(node) {
  if (!node) {
    return false;
  }
  if (TYPE_WRAPPERS.has(node.type)) {
    return isFreshValue(node.expression);
  }
  if (FRESH_VALUE_TYPES.has(node.type)) {
    return true;
  }
  if (node.type === 'CallExpression') {
    const callee = node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee);
    return !STABLE_RESULT_HOOKS.has(callee);
  }
  if (node.type === 'ConditionalExpression') {
    return isFreshValue(node.consequent) || isFreshValue(node.alternate);
  }
  if (node.type === 'LogicalExpression') {
    return isFreshValue(node.left) || isFreshValue(node.right);
  }
  return false;
}

export default {
  meta: {
    docs: {
      description:
        'Reject a context value built in the JSX, on <Foo.Provider>, a React 19 <FooContext> or createElement(Foo.Provider, …): an object, array or JSX literal, a function, new, or a call other than useMemo, useCallback, useRef, useStableCallback and useLatestRef (useState returns a new tuple each render), including inside a conditional or logical operator.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    const report = (node) =>
      context.report({
        node,
        message:
          'A context value built while rendering is a new reference on every render, so every consumer re-renders. Memoize it (useMemo, useStableCallback) or split state from commands (docs/architecture/client-state.md).',
      });
    return {
      JSXOpeningElement(node) {
        if (!isContextElement(node.name)) {
          return;
        }
        const attribute = jsxAttribute(node, 'value');
        const expression = attribute?.value?.expression;
        if (expression && isFreshValue(expression)) {
          report(attribute);
        }
      },
      // `createElement(Context.Provider, { value: { … } }, children)`.
      CallExpression(node) {
        const [type, props] = node.arguments;
        const callee = node.callee;
        if (
          !(isIdentifier(callee, 'createElement') || memberName(callee) === 'createElement') ||
          !isContextReference(type) ||
          props?.type !== 'ObjectExpression'
        ) {
          return;
        }
        const value = props.properties.find(
          (property) =>
            property.type === 'Property' &&
            staticKeyName(property.key, property.computed) === 'value'
        );
        if (value && isFreshValue(value.value)) {
          report(value);
        }
      },
    };
  },
};
