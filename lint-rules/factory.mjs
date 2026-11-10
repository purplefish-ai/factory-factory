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

// An arbitrary font size such as `text-[10px]`, `md:text-[0.8rem]` or
// `text-[1.5em]`; the type scale (`text-2xs`, `text-xs`, …) replaces them.
const ARBITRARY_FONT_SIZE_CLASS = /(?<=^|[\s'"`:!])text-\[(?:\d*\.)?\d+(?:px|r?em)\](?![\w-])/;

const STATUS_TOKENS = '(destructive|warning|success|info|running|merged)(?:-accent)?';
const STATUS_BACKGROUND_TINT = new RegExp(`^bg-${STATUS_TOKENS}/\\d+$`);
const STATUS_BORDER = new RegExp(`^border(?:-[trblxyse])?-${STATUS_TOKENS}(?:/\\d+)?$`);

/**
 * The status token of a hand-rolled callout surface in one class string: a
 * tinted status background (`bg-warning/10`) paired with a border of the same
 * status token (`border-warning/30`). Only unprefixed and `dark:` classes
 * count, so hover, focus and data-state styling never match.
 */
function statusCalloutToken(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const backgrounds = new Set();
  const borders = new Set();
  for (const token of text.split(/[\s'"`]+/)) {
    const variants = token.split(':');
    const utility = variants.pop().replace(/^!/, '');
    if (variants.length > 1 || (variants.length === 1 && variants[0] !== 'dark')) {
      continue;
    }
    const background = STATUS_BACKGROUND_TINT.exec(utility);
    if (background) {
      backgrounds.add(background[1]);
    }
    const border = STATUS_BORDER.exec(utility);
    if (border) {
      borders.add(border[1]);
    }
  }
  return [...backgrounds].find((token) => borders.has(token)) ?? null;
}

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
  return (
    ['aria-label', 'aria-labelledby', 'title'].includes(attribute.name.name) &&
    hasNonEmptyValue(attribute)
  );
}

/** A JSX attribute whose value may be a non-empty string. */
function hasNonEmptyValue(attribute) {
  if (!attribute.value) {
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

const WEB_STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);

/** `window`, `globalThis` or `self`: the objects that expose Web Storage. */
function isWebStorageGlobal(node) {
  return node?.type === 'Identifier' && ['window', 'globalThis', 'self'].includes(node.name);
}

/** A property or key name that does not depend on runtime values. */
function staticKeyName(key, computed) {
  if (!computed) {
    return key.type === 'Identifier' ? key.name : key.value;
  }
  if (key.type === 'Literal') {
    return key.value;
  }
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return key.quasis[0].value.cooked;
  }
  return undefined;
}

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

// The controls whose `size` variant sizes their icons (src/components/ui/button.tsx).
const SIZED_BUTTONS = new Set(['Button', 'IconButton']);

// `h-4`, `w-3.5`, `md:size-8`, `h-px`: a fixed height, width or size from the
// spacing scale. Keywords (`w-full`, `h-auto`), fractions (`w-1/2`) and
// arbitrary values (`w-[160px]`) are layout, not control sizes, and pass.
const FIXED_SIZE_CLASS = /(?<=^|[\s'"`:!])(?:h|w|size)-(?:\d+(?:\.\d+)?|px)(?![\w./-])/;

// Hand-rolled keyboard focus styles that the `focus-ring` utility replaces:
// `focus-visible:ring-2`, `focus-visible:outline-none`, `focus-visible:outline-ring`.
const HAND_ROLLED_FOCUS_CLASS =
  /(?<=^|[\s'"`:!])focus-visible:(?:ring-2|outline(?:-none|-ring|-2)?)(?![\w-])/;

// `h-4`, `w-[18px]`, `md:w-3`: any height or width class on an icon.
const ICON_DIMENSION_CLASS = /(?<=^|[\s'"`:!])[hw]-[\w.[\]/-]+/;

function classNameText(opening, sourceCode) {
  const attribute = opening.attributes.find(
    (candidate) => candidate.type === 'JSXAttribute' && candidate.name.name === 'className'
  );
  return attribute?.value ? sourceCode.getText(attribute.value) : '';
}

function jsxAttribute(opening, name) {
  return opening.attributes.find(
    (attribute) => attribute.type === 'JSXAttribute' && attribute.name.name === name
  );
}

/** A literal `size="icon…"` on a Button. */
function hasIconSize(opening) {
  const size = jsxAttribute(opening, 'size');
  return size?.value?.type === 'Literal' && /^icon(?:-|$)/.test(size.value.value);
}

function isIconElement(opening) {
  const name = jsxTagName(opening.name);
  return name === 'svg' || /Icon$/.test(name) || /(?:^|\.)Icons?\./.test(name);
}

/** Icons rendered among a control's children, through conditionals, fragments and wrappers. */
function collectIcons(node, found = []) {
  switch (node?.type) {
    case 'JSXElement':
      if (SIZED_BUTTONS.has(jsxTagName(node.openingElement.name))) {
        return found;
      }
      if (isIconElement(node.openingElement)) {
        found.push(node.openingElement);
      }
      for (const child of node.children) {
        collectIcons(child, found);
      }
      return found;
    case 'JSXFragment':
      for (const child of node.children) {
        collectIcons(child, found);
      }
      return found;
    case 'JSXExpressionContainer':
      return collectIcons(node.expression, found);
    case 'ConditionalExpression':
      collectIcons(node.consequent, found);
      return collectIcons(node.alternate, found);
    case 'LogicalExpression':
      collectIcons(node.left, found);
      return collectIcons(node.right, found);
    default:
      return found;
  }
}

/** The element an `asChild` trigger renders: its only JSX child, if any. */
function onlyElementChild(node) {
  const children = node.children.filter(
    (child) =>
      !(child.type === 'JSXText' && !child.value.trim()) &&
      !(child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression')
  );
  return children.length === 1 && children[0].type === 'JSXElement' ? children[0] : undefined;
}

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

const rules = {
  'button-icon-size': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      return {
        JSXElement(node) {
          const name = jsxTagName(node.openingElement.name);
          if (!SIZED_BUTTONS.has(name)) {
            return;
          }
          for (const child of node.children) {
            for (const icon of collectIcons(child)) {
              const match = ICON_DIMENSION_CLASS.exec(classNameText(icon, context.sourceCode));
              if (match) {
                context.report({
                  node: icon,
                  message: `Remove "${match[0]}": the ${name} size variant sizes its icons. Use a size-* class only for a deliberate exception (src/components/ui/button.tsx).`,
                });
              }
            }
          }
        },
      };
    },
  },
  'button-size-variant': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      return {
        JSXOpeningElement(node) {
          const name = jsxTagName(node.name);
          if (!SIZED_BUTTONS.has(name)) {
            return;
          }
          const match = FIXED_SIZE_CLASS.exec(classNameText(node, context.sourceCode));
          if (match) {
            context.report({
              node,
              message: `Use a ${name} size variant (xs, compact, sm, default, lg, inline or icon-*) instead of "${match[0]}" in className. Layout widths such as w-full pass.`,
            });
          }
        },
      };
    },
  },
  'icon-button-tooltip': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      const message =
        'Use IconButton (src/client/components/icon-button.tsx): its label is both the accessible name and the tooltip.';
      return {
        JSXElement(node) {
          const opening = node.openingElement;
          const name = jsxTagName(opening.name);
          if (name === 'Button' && hasIconSize(opening) && jsxAttribute(opening, 'title')) {
            context.report({ node: opening, message });
            return;
          }
          if (name !== 'TooltipTrigger' || !jsxAttribute(opening, 'asChild')) {
            return;
          }
          // Follow nested `DropdownMenuTrigger asChild` and similar triggers to the rendered element.
          let child = onlyElementChild(node);
          while (
            child &&
            /Trigger$/.test(jsxTagName(child.openingElement.name)) &&
            jsxAttribute(child.openingElement, 'asChild')
          ) {
            child = onlyElementChild(child);
          }
          if (
            child &&
            jsxTagName(child.openingElement.name) === 'Button' &&
            hasIconSize(child.openingElement) &&
            // A titled icon Button is already reported above.
            !jsxAttribute(child.openingElement, 'title')
          ) {
            context.report({ node: child.openingElement, message });
          }
        },
      };
    },
  },
  'tooltip-provider-root': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      return {
        JSXOpeningElement(node) {
          if (jsxTagName(node.name) === 'TooltipProvider') {
            context.report({
              node,
              message:
                'Render tooltips under the app root TooltipProvider instead of nesting one; a nested provider without props resets the open delay to 700ms.',
            });
          }
        },
      };
    },
  },
  'focus-ring': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      const report = (node, text) => {
        const match = typeof text === 'string' ? HAND_ROLLED_FOCUS_CLASS.exec(text) : null;
        if (match) {
          context.report({
            node,
            message: `Use the focus-ring utility (src/client/globals.css) instead of "${match[0]}".`,
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
          if (opening.name.name === 'IconButton') {
            // IconButton's required label is its name; it must not be empty.
            const label = jsxAttribute(opening, 'label');
            if (label && !hasNonEmptyValue(label)) {
              context.report({ node: opening, message: 'Give IconButton a non-empty label.' });
            }
            return;
          }
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
              message: `Pass \`pending\` to ${name} instead of rendering a spinner inside it; pending disables the control and shows the shared Spinner in place of its icon.`,
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
      const message =
        'Use the shared Spinner (src/components/ui/spinner.tsx) instead of SpinnerGapIcon or animate-spin (docs/architecture/client-loading.md).';
      const report = (node, text) => {
        if (hasSpinClass(text)) {
          context.report({ node, message });
        }
      };
      return {
        // Class strings are also built in variables, `cn()` arguments and
        // status config objects, so every string is checked, not only JSX.
        Literal(node) {
          report(node, node.value);
        },
        TemplateElement(node) {
          report(node, node.value.cooked ?? node.value.raw);
        },
        JSXOpeningElement(node) {
          if (jsxTagName(node.name) === 'SpinnerGapIcon') {
            context.report({ node, message });
          }
        },
      };
    },
  },
  'no-raw-tab-role': {
    meta: { schema: EXCEPTIONS_SCHEMA },
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
  'no-direct-web-storage': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      // `exceptions` maps repository-relative paths to the reason each file
      // may touch Web Storage directly (src/client/lib/browser-storage.ts).
      if (isListedFile(context, Object.keys(context.options[0]?.exceptions ?? {}))) {
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
  },
  'no-arbitrary-font-size': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      const report = (node, text) => {
        const match = typeof text === 'string' ? ARBITRARY_FONT_SIZE_CLASS.exec(text) : null;
        if (match) {
          context.report({
            node,
            message: `Use the type scale (text-2xs, text-xs, text-sm, …) instead of "${match[0]}" (docs/status-colors.md#small-text).`,
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
  'use-status-callout': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      const report = (node, text) => {
        const token = statusCalloutToken(text);
        if (token) {
          context.report({
            node,
            message: `Use StatusCallout (src/client/components/status-callout.tsx) or StatusChip instead of pairing a ${token} background tint with a ${token} border (docs/status-colors.md#callouts-and-chips).`,
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
  'no-forward-ref': {
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee;
          if (
            isIdentifier(callee, 'forwardRef') ||
            (callee.type === 'MemberExpression' && memberName(callee) === 'forwardRef')
          ) {
            context.report({
              node,
              message:
                'React 19 passes `ref` as a prop; take it from props instead of wrapping the component in forwardRef.',
            });
          }
        },
      };
    },
  },
  'no-render-ref-write': {
    meta: { schema: EXCEPTIONS_SCHEMA },
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
  },
  'no-state-sync-effect': {
    meta: { schema: EXCEPTIONS_SCHEMA },
    create(context) {
      if (isExceptedFile(context)) {
        return {};
      }
      return {
        CallExpression(node) {
          const name =
            node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee);
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
