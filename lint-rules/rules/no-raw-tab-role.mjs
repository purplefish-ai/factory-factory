// Every tab bar shares one look and keyboard behavior through the shared
// TabList and TabButton in src/components/ui/tab-button.tsx
// (docs/keyboard-shortcuts.md). Tests are exempt.
import { staticKeyName } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';

const TAB_ROLES = new Set(['tab', 'tablist']);

/** The string values an attribute or expression can take, through conditionals. */
function staticStrings(node) {
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return node.expressions.length === 0
        ? [node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')]
        : [];
    case 'JSXExpressionContainer':
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return staticStrings(node.expression);
    case 'ConditionalExpression':
      return [...staticStrings(node.consequent), ...staticStrings(node.alternate)];
    case 'LogicalExpression':
      return [...staticStrings(node.left), ...staticStrings(node.right)];
    default:
      return [];
  }
}

export default {
  meta: {
    docs: {
      description:
        'Reject a role="tab" or role="tablist" attribute (or role prop) outside the shared TabList and TabButton.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    const report = (node, value) => {
      for (const role of staticStrings(value)) {
        if (TAB_ROLES.has(role)) {
          context.report({
            node,
            message: `Render tab bars with TabList and TabButton (src/components/ui/tab-button.tsx) or the shadcn Tabs instead of writing role="${role}", so every tab bar shares one look and keyboard behavior.`,
          });
          return;
        }
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'role') {
          report(node, node.value);
        }
      },
      // Props objects, e.g. `createElement('div', { role: 'tab' })` or a spread.
      Property(node) {
        if (staticKeyName(node.key, node.computed) === 'role') {
          report(node, node.value);
        }
      },
    };
  },
};
