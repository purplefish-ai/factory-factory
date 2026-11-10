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

function propertyKey(node) {
  if (node.computed) {
    return node.key.type === 'Literal' ? node.key.value : undefined;
  }
  return node.key.type === 'Identifier' ? node.key.name : node.key.value;
}

/** `{ queries: { ... } }` or `{ mutations: { ... } }`: QueryClient defaults, not a call site. */
function isQueryClientDefault(property) {
  const owner = property.parent?.parent;
  return (
    owner?.type === 'Property' &&
    owner.value === property.parent &&
    ['queries', 'mutations'].includes(propertyKey(owner))
  );
}

function isFunction(node) {
  return ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
    node?.type
  );
}

/** Return values of a function body, not descending into nested functions. */
function returnedExpressions(node, visitorKeys, found = []) {
  if (!node || isFunction(node)) {
    return found;
  }
  if (node.type === 'ReturnStatement') {
    found.push(node.argument);
    return found;
  }
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const value of Array.isArray(child) ? child : [child]) {
      if (value && typeof value.type === 'string') {
        returnedExpressions(value, visitorKeys, found);
      }
    }
  }
  return found;
}

const COMPARISON_OPERATORS = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

/** A numeric literal that the interval can evaluate to, through branches and callbacks. */
function numericIntervalLiteral(node, visitorKeys) {
  const find = (child) => numericIntervalLiteral(child, visitorKeys);
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'number' ? node : undefined;
    case 'ConditionalExpression':
      return find(node.consequent) ?? find(node.alternate);
    case 'LogicalExpression':
      return find(node.left) ?? find(node.right);
    case 'BinaryExpression':
      // A comparison yields a boolean; its operands are never the interval.
      return COMPARISON_OPERATORS.has(node.operator)
        ? undefined
        : (find(node.left) ?? find(node.right));
    case 'UnaryExpression':
      return find(node.argument);
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return find(node.expression);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return node.body.type === 'BlockStatement'
        ? returnedExpressions(node.body, visitorKeys).map(find).find(Boolean)
        : find(node.body);
    default:
      return undefined;
  }
}

/** `input`, `input.todos`, `call.input.file_path`, `input?.["offset"]` and similar. */
function readsToolInput(node) {
  let current = node;
  while (current) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression'
    ) {
      current = current.expression;
    } else if (current.type === 'MemberExpression') {
      if (memberName(current) === 'input') {
        return true;
      }
      current = current.object;
    } else {
      return isIdentifier(current, 'input');
    }
  }
  return false;
}

// Query result fields that only say the request is unresolved or in flight, and
// the fields that say it failed (docs/architecture/client-loading.md).
const QUERY_LOADING_FIELDS = new Set(['isLoading', 'isPending', 'isInitialLoading']);
const QUERY_ERROR_FIELDS = new Set([
  'error',
  'isError',
  'status',
  'isLoadingError',
  'isRefetchError',
]);

/**
 * `useQuery`, `useInfiniteQuery` and wrapper hooks named `use…Query`, called
 * directly or on a tRPC procedure. Suspense queries throw to an error boundary.
 */
function isQueryHookCall(node) {
  if (node?.type !== 'CallExpression') {
    return false;
  }
  const name = node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee);
  return typeof name === 'string' && /^use\w*Query$/.test(name) && !name.startsWith('useSuspense');
}

/** Fields read from a query result, or `undefined` when the whole result escapes. */
function readQueryFields(context, declarator) {
  if (declarator.id.type === 'ObjectPattern') {
    const fields = [];
    for (const property of declarator.id.properties) {
      if (property.type !== 'Property' || property.computed) {
        return undefined;
      }
      fields.push(property.key.name ?? property.key.value);
    }
    return fields;
  }
  if (declarator.id.type !== 'Identifier') {
    return undefined;
  }
  const fields = [];
  for (const variable of context.sourceCode.getDeclaredVariables(declarator)) {
    for (const reference of variable.references) {
      const parent = reference.identifier.parent;
      if (parent === declarator) {
        continue;
      }
      // `const { isLoading } = query` and `const alias = query` read through another binding.
      if (parent.type === 'VariableDeclarator' && parent.init === reference.identifier) {
        const aliased = readQueryFields(context, parent);
        if (!aliased) {
          return undefined;
        }
        fields.push(...aliased);
        continue;
      }
      if (parent.type !== 'MemberExpression' || parent.object !== reference.identifier) {
        return undefined;
      }
      fields.push(memberName(parent));
    }
  }
  return fields;
}

function isListedFile(context, paths) {
  const filename = context.filename.replaceAll('\\', '/');
  return paths.some((path) => filename === path || filename.endsWith(`/${path}`));
}

// `exceptions` maps repository-relative paths to the reason each file may keep
// the reported pattern; a test fails once a listed file no longer needs it.
const EXCEPTIONS_SCHEMA = [
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
];

function isExceptedFile(context) {
  return isListedFile(context, Object.keys(context.options[0]?.exceptions ?? {}));
}

// `animate-spin` as a class, with optional variants (`motion-safe:animate-spin`).
const ANIMATE_SPIN_CLASS = /(?<=^|[\s'"`:!])animate-spin(?![\w-])/;

function hasSpinClass(text) {
  return typeof text === 'string' && ANIMATE_SPIN_CLASS.test(text);
}

const SPINNER_ELEMENTS = new Set(['Spinner', 'SpinnerGapIcon']);
const PENDING_CONTROLS = new Set(['Button', 'DropdownMenuItem']);

function classNameSpins(attribute, sourceCode) {
  return (
    attribute.type === 'JSXAttribute' &&
    attribute.name.name === 'className' &&
    Boolean(attribute.value) &&
    hasSpinClass(sourceCode.getText(attribute.value))
  );
}

/** The first spinner rendered among a control's children, through conditionals and fragments. */
function findChildSpinner(node, sourceCode) {
  switch (node?.type) {
    case 'JSXElement': {
      const opening = node.openingElement;
      if (
        SPINNER_ELEMENTS.has(jsxTagName(opening.name)) ||
        opening.attributes.some((attribute) => classNameSpins(attribute, sourceCode))
      ) {
        return node;
      }
      return findInChildren(node.children, sourceCode);
    }
    case 'JSXFragment':
      return findInChildren(node.children, sourceCode);
    case 'JSXExpressionContainer':
      return findChildSpinner(node.expression, sourceCode);
    case 'ConditionalExpression':
      return (
        findChildSpinner(node.consequent, sourceCode) ??
        findChildSpinner(node.alternate, sourceCode)
      );
    case 'LogicalExpression':
      return findChildSpinner(node.left, sourceCode) ?? findChildSpinner(node.right, sourceCode);
    default:
      return undefined;
  }
}

function findInChildren(children, sourceCode) {
  for (const child of children) {
    const spinner = findChildSpinner(child, sourceCode);
    if (spinner) {
      return spinner;
    }
  }
  return undefined;
}

const rules = {
  'query-owner': {
    meta: {
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
          if (
            match &&
            (match.group.helpers === 'all' || QUERY_CACHE_METHODS.has(memberName(node)))
          ) {
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
  },
  'named-query-options': {
    create(context) {
      // Query defaults live in src/client/lib/query-client.ts and named
      // intervals and retry exceptions in src/client/lib/query-options.ts.
      return {
        Property(node) {
          if (isQueryClientDefault(node)) {
            return;
          }
          const key = propertyKey(node);
          const value = node.value;
          if (key === 'refetchInterval') {
            const literal = numericIntervalLiteral(value, context.sourceCode.visitorKeys);
            if (literal) {
              context.report({
                node: literal,
                message:
                  'Use a POLL_INTERVAL_MS tier from src/client/lib/query-options.ts instead of a numeric refetchInterval.',
              });
            }
          } else if (
            key === 'refetchOnWindowFocus' &&
            value.type === 'Literal' &&
            value.value === false
          ) {
            context.report({
              node,
              message:
                'Remove refetchOnWindowFocus: false; it is the app default (src/client/lib/query-client.ts).',
            });
          } else if (
            key === 'retry' &&
            value.type === 'Literal' &&
            ['boolean', 'number'].includes(typeof value.value)
          ) {
            context.report({
              node,
              message:
                'Rely on the app retry policy (src/client/lib/query-client.ts) or use a named QUERY_RETRY reason from src/client/lib/query-options.ts.',
            });
          }
        },
      };
    },
  },
  'query-error-handled': {
    create(context) {
      return {
        VariableDeclarator(node) {
          if (!isQueryHookCall(node.init)) {
            return;
          }
          const fields = readQueryFields(context, node);
          if (
            fields?.some((field) => QUERY_LOADING_FIELDS.has(field)) &&
            !fields.some((field) => QUERY_ERROR_FIELDS.has(field))
          ) {
            context.report({
              node,
              message:
                'This query reads a loading flag but not `error`, so a failed request reads as loading or empty. Render it with QueryState, or handle `error` (docs/architecture/client-loading.md).',
            });
          }
        },
      };
    },
  },
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
  'use-pending-prop': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      return {
        JSXElement(node) {
          const name = jsxTagName(node.openingElement.name);
          if (!PENDING_CONTROLS.has(name)) {
            return;
          }
          const spinner = findInChildren(node.children, context.sourceCode);
          if (spinner) {
            context.report({
              node: spinner,
              message: `Pass \`pending\` to ${name} instead of rendering a spinner inside it; it disables the control and swaps its icon for the shared Spinner.`,
            });
          }
        },
      };
    },
  },
  'no-raw-spinner': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      const report = (node, text) => {
        if (hasSpinClass(text)) {
          context.report({
            node,
            message:
              'Use the shared Spinner (src/components/ui/spinner.tsx) instead of animate-spin (docs/architecture/client-loading.md).',
          });
        }
      };
      return {
        Literal(node) {
          report(node, node.value);
        },
        TemplateElement(node) {
          report(node, node.value.cooked ?? node.value.raw);
        },
      };
    },
  },
  'no-raw-palette-classes': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      // Fixed palette exceptions are explained in docs/status-colors.md.
      if (isExceptedFile(context)) {
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
  'no-tool-input-cast': {
    create(context) {
      // Tool input is agent-supplied; renderers parse it with the schemas in
      // tool-renderers/tool-input-schemas.ts and fall back to raw JSON.
      const report = (node) => {
        if (node.typeAnnotation.typeName?.name === 'const' || !readsToolInput(node.expression)) {
          return;
        }
        context.report({
          node,
          message:
            'Parse agent tool input with parseToolInput and a Zod schema instead of a type assertion.',
        });
      };
      return { TSAsExpression: report, TSTypeAssertion: report };
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
