// State known while rendering is derived, reset with `key` or adjusted during
// render, not synced in an effect (docs/architecture/client-state.md). Enabled
// for src/client, src/components and src/hooks outside tests and stories.
import { isFunction, memberName } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect']);
// `setX(...)` state setters, but not the timer globals.
const STATE_SETTER = /^set(?!Timeout$|Interval$|Immediate$)[A-Z]/;

/**
 * Whether an expression only combines values already available while
 * rendering: no calls (other than updater functions passed to a setter), no
 * ref or DOM reads through `.current`, and no `await`, `new` or `this`.
 */
function isRenderDerivable(node, visitorKeys) {
  if (!node || typeof node.type !== 'string') {
    return true;
  }
  if (isFunction(node)) {
    return isRenderDerivable(node.body, visitorKeys);
  }
  if (
    ['CallExpression', 'NewExpression', 'AwaitExpression', 'ThisExpression'].includes(node.type) ||
    (node.type === 'MemberExpression' && memberName(node) === 'current')
  ) {
    return false;
  }
  return (visitorKeys[node.type] ?? []).every((key) => {
    const child = node[key];
    return Array.isArray(child)
      ? child.every((value) => isRenderDerivable(value, visitorKeys))
      : isRenderDerivable(child, visitorKeys);
  });
}

/** A statement that only calls state setters with render-derivable values, possibly behind ifs. */
function onlySetsState(node, visitorKeys) {
  switch (node?.type) {
    case 'BlockStatement':
      return node.body.length > 0 && node.body.every((child) => onlySetsState(child, visitorKeys));
    case 'IfStatement':
      return (
        isRenderDerivable(node.test, visitorKeys) &&
        onlySetsState(node.consequent, visitorKeys) &&
        (!node.alternate || onlySetsState(node.alternate, visitorKeys))
      );
    case 'ReturnStatement':
      return node.argument === null;
    case 'ExpressionStatement':
      return onlySetsState(node.expression, visitorKeys);
    case 'CallExpression':
      return (
        node.callee.type === 'Identifier' &&
        STATE_SETTER.test(node.callee.name) &&
        node.arguments.every((argument) => isRenderDerivable(argument, visitorKeys))
      );
    default:
      return false;
  }
}

/** At least one setter call, so a body of bare returns is not reported. */
function callsSetter(node) {
  if (node?.type === 'BlockStatement') {
    return node.body.some(callsSetter);
  }
  if (node?.type === 'IfStatement') {
    return callsSetter(node.consequent) || callsSetter(node.alternate);
  }
  return node?.type === 'ExpressionStatement' || node?.type === 'CallExpression';
}

export default {
  meta: {
    docs: {
      description:
        'Reject a useEffect or useLayoutEffect with dependencies whose body only calls set… functions, possibly behind ifs, with values that contain no call, .current read, await or new.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    return {
      CallExpression(node) {
        const name = node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee);
        const [callback, dependencies] = node.arguments;
        if (
          !EFFECT_HOOKS.has(name) ||
          !isFunction(callback) ||
          dependencies?.type !== 'ArrayExpression' ||
          dependencies.elements.length === 0 ||
          !callsSetter(callback.body) ||
          !onlySetsState(callback.body, context.sourceCode.visitorKeys)
        ) {
          return;
        }
        context.report({
          node,
          message:
            'This effect only sets state from values known while rendering, so the previous state shows for one commit. Derive the value, reset with `key`, or adjust state during render (docs/architecture/client-state.md).',
        });
      },
    };
  },
};
