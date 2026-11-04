// Project rules use Oxlint's ESLint-compatible API.
function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') {
    return undefined;
  }
  return node.computed ? node.property.value : node.property.name;
}

function isMember(node, object, property) {
  return isIdentifier(node?.object, object) && memberName(node) === property;
}

function containsUnknownType(node, visitorKeys) {
  if (!node) {
    return false;
  }
  if (node.type === 'TSUnknownKeyword') {
    return true;
  }
  return (visitorKeys[node.type] ?? []).some((key) => {
    const child = node[key];
    return Array.isArray(child)
      ? child.some((value) => containsUnknownType(value, visitorKeys))
      : containsUnknownType(child, visitorKeys);
  });
}

// Tailwind utilities that take a color, followed by a fixed palette hue and
// shade (e.g. `bg-red-500`, `dark:text-emerald-300`, `hover:border-sky-500/40`).
// A class must start the string or follow whitespace, a quote, a `:` variant
// separator or the `!` important prefix, so paths like `/api/text-red-500`
// are not mistaken for classes.
// Theme tokens (`text-success`, `bg-running/10`) and `white`/`black` pass.
const RAW_PALETTE_CLASS =
  /(?<=^|[\s'"`:!])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|text-shadow|drop-shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?![\w-])/;

function reportRawPaletteClass(context, node, text) {
  const match = typeof text === 'string' ? RAW_PALETTE_CLASS.exec(text) : null;
  if (match) {
    context.report({
      node,
      message: `Use a theme or status token instead of the fixed palette class "${match[0]}" (docs/status-colors.md).`,
    });
  }
}

function hasButtonText(node) {
  if (node.type === 'JSXText') {
    return Boolean(node.value.trim());
  }
  if (node.type === 'JSXExpressionContainer') {
    return (
      node.expression.type === 'Literal' &&
      typeof node.expression.value === 'string' &&
      Boolean(node.expression.value.trim())
    );
  }
  if (node.type === 'JSXFragment') {
    return node.children.some(hasButtonText);
  }
  if (node.type !== 'JSXElement') {
    return false;
  }
  const hidden = node.openingElement.attributes.some(
    (attribute) =>
      attribute.type === 'JSXAttribute' &&
      attribute.name.name === 'aria-hidden' &&
      (attribute.value === null ||
        attribute.value?.value === 'true' ||
        attribute.value?.expression?.value === true)
  );
  return !hidden && node.children.some(hasButtonText);
}

function hasButtonName(attribute) {
  if (
    !['aria-label', 'aria-labelledby', 'title'].includes(attribute.name.name) ||
    !attribute.value
  ) {
    return false;
  }
  const value =
    attribute.value.type === 'JSXExpressionContainer'
      ? attribute.value.expression
      : attribute.value;
  if (value.type === 'Literal') {
    return typeof value.value === 'string' && Boolean(value.value.trim());
  }
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis.some((part) => (part.value.cooked ?? part.value.raw).trim());
  }
  return !(value.type === 'Identifier' && value.name === 'undefined');
}

function jsxTagName(node) {
  return node.type === 'JSXMemberExpression'
    ? `${jsxTagName(node.object)}.${node.property.name}`
    : node.name;
}

function isButtonIcon(node) {
  if (node.type === 'JSXText') {
    return !node.value.trim();
  }
  if (node.type === 'JSXFragment') {
    return node.children.length > 0 && node.children.every(isButtonIcon);
  }
  if (node.type !== 'JSXElement') {
    return false;
  }
  const name = jsxTagName(node.openingElement.name);
  if (name === 'svg' || /Icon$/.test(name) || /(?:^|\.)Icons?\./.test(name)) {
    return true;
  }
  return (
    ['span', 'div', 'i'].includes(name) &&
    node.children.length > 0 &&
    node.children.every(isButtonIcon)
  );
}

const rules = {
  'icon-button-name': {
    create(context) {
      return {
        JSXElement(node) {
          const opening = node.openingElement;
          if (!['button', 'Button'].includes(opening.name.name)) {
            return;
          }
          const attributes = opening.attributes.filter(
            (attribute) => attribute.type === 'JSXAttribute'
          );
          const hasName = attributes.some(hasButtonName);
          if (hasName) {
            return;
          }
          const children = node.children.filter(
            (child) =>
              !(child.type === 'JSXText' && !child.value.trim()) &&
              !(
                child.type === 'JSXExpressionContainer' &&
                child.expression.type === 'JSXEmptyExpression'
              )
          );
          const iconOnly = children.length > 0 && children.every(isButtonIcon);
          const iconSize = attributes.some(
            (attribute) =>
              attribute.name.name === 'size' &&
              attribute.value?.type === 'Literal' &&
              /^icon(?:-|$)/.test(attribute.value.value)
          );
          const hasText = children.some(hasButtonText);
          const forwardsProps = opening.attributes.some(
            (attribute) => attribute.type === 'JSXSpreadAttribute'
          );
          const delegatedName =
            attributes.some((attribute) => attribute.name.name === 'asChild') &&
            children.some(
              (child) =>
                child.type === 'JSXElement' &&
                child.openingElement.attributes.some(
                  (attribute) => attribute.type === 'JSXAttribute' && hasButtonName(attribute)
                )
            );
          if (
            !delegatedName &&
            (iconOnly || (iconSize && !hasText && !(children.length === 0 && forwardsProps)))
          ) {
            context.report({
              node: opening,
              message:
                'Give icon-only buttons an aria-label, aria-labelledby, title, or screen-reader text.',
            });
          }
        },
      };
    },
  },
  'no-raw-palette-classes': {
    meta: {
      schema: [
        {
          type: 'object',
          properties: {
            exceptions: {
              type: 'object',
              additionalProperties: { type: 'string', minLength: 1 },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      // `exceptions` maps repository-relative paths to the reason each file
      // may keep fixed palette colors (see docs/status-colors.md).
      const exceptions = Object.keys(context.options[0]?.exceptions ?? {});
      const filename = context.filename.replaceAll('\\', '/');
      if (exceptions.some((path) => filename === path || filename.endsWith(`/${path}`))) {
        return {};
      }
      return {
        Literal(node) {
          reportRawPaletteClass(context, node, node.value);
        },
        TemplateElement(node) {
          reportRawPaletteClass(context, node, node.value.cooked ?? node.value.raw);
        },
      };
    },
  },
  'no-await-import': {
    create(context) {
      return {
        AwaitExpression(node) {
          if (node.argument.type === 'ImportExpression') {
            context.report({
              node,
              message:
                'Use static imports. Extract shared modules to resolve circular dependencies.',
            });
          }
        },
      };
    },
  },
  'no-native-dialogs': {
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee;
          const name =
            callee.type === 'Identifier'
              ? callee.name
              : isIdentifier(callee.object, 'window')
                ? memberName(callee)
                : undefined;
          if (['alert', 'confirm', 'prompt'].includes(name)) {
            context.report({
              node,
              message: 'Use ConfirmDialog or AlertDialog for browser dialogs.',
            });
          }
        },
      };
    },
  },
  'no-next-directives': {
    create(context) {
      return {
        ExpressionStatement(node) {
          if (['use client', 'use server'].includes(node.expression.value)) {
            context.report({
              node,
              message: 'Remove Next.js directives from this Vite application.',
            });
          }
        },
      };
    },
  },
  'no-zod-any': {
    create(context) {
      return {
        CallExpression(node) {
          if (isMember(node.callee, 'z', 'any') || isMember(node.callee, 'zod', 'any')) {
            context.report({
              node,
              message: 'Use a specific Zod schema, or z.unknown() with explicit narrowing.',
            });
          }
        },
      };
    },
  },
  'no-unsafe-json-parse-cast': {
    create(context) {
      return {
        TSAsExpression(node) {
          if (
            node.expression.type === 'CallExpression' &&
            isMember(node.expression.callee, 'JSON', 'parse')
          ) {
            context.report({
              node,
              message: 'Validate JSON.parse results with a Zod schema instead of a type assertion.',
            });
          }
        },
      };
    },
  },
  'no-unsafe-resolver-cast': {
    create(context) {
      return {
        TSAsExpression(node) {
          if (
            isIdentifier(node.expression, 'resolve') &&
            node.typeAnnotation.type === 'TSFunctionType' &&
            node.typeAnnotation.params.some((parameter) =>
              containsUnknownType(parameter, context.sourceCode.visitorKeys)
            )
          ) {
            context.report({
              node,
              message:
                'Type promise resolvers with proper generics and validate data before resolving.',
            });
          }
        },
      };
    },
  },
};

export default { meta: { name: 'factory' }, rules };
