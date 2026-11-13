// Button sizing follows the `size` variant
// (docs/shadcn.md#buttons-icon-buttons-and-tooltips): the variant sizes icons,
// with a `size-*` class as the explicit opt-out, and its `gap` already spaces
// icon and label.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { classNameText, jsxAttribute, jsxTagName, onlyElementChild } from '../lib/jsx.mjs';
import { SIZED_BUTTONS } from '../lib/sized-buttons.mjs';

// `h-4`, `w-[18px]`, `md:w-3`: any height or width class on an icon.
const ICON_DIMENSION_CLASS = /(?<=^|[\s'"`:!])[hw]-[\w.[\]/-]+/;

// `mr-2`, `ml-1.5`, `md:me-1`, `mx-[3px]`, `m-1`: a positive horizontal margin
// (including all-sides `m-`), which adds to the control's `gap`. Negative
// optical offsets (`-ml-1`), `ml-auto` and vertical margins (`my-1`) pass.
const ICON_HORIZONTAL_MARGIN_CLASS =
  /(?<=^|[\s'"`:!])m[lrxse]?-(?:\d+(?:\.\d+)?|px|\[[^\]\s]+\])(?![\w./-])/;

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

/**
 * Icons that are flex items of the control: its children, through conditionals
 * and fragments but not wrapper elements, whose own layout spaces their icons.
 * With `asChild`, the rendered child's children.
 */
function collectDirectIcons(node, found = []) {
  switch (node?.type) {
    case 'JSXElement':
      if (isIconElement(node.openingElement)) {
        found.push(node.openingElement);
      }
      return found;
    case 'JSXFragment':
      for (const child of node.children) {
        collectDirectIcons(child, found);
      }
      return found;
    case 'JSXExpressionContainer':
      return collectDirectIcons(node.expression, found);
    case 'ConditionalExpression':
      collectDirectIcons(node.consequent, found);
      return collectDirectIcons(node.alternate, found);
    case 'LogicalExpression':
      collectDirectIcons(node.left, found);
      return collectDirectIcons(node.right, found);
    default:
      return found;
  }
}

export default {
  meta: {
    docs: {
      description:
        'Reject h-*/w-* classes on an icon (*Icon, svg) anywhere inside a Button or IconButton, through conditionals, fragments and wrappers, and a positive horizontal margin (mr-2, md:ml-1.5, me-1, m-1) on an icon that is a direct flex item of the control (through conditionals, fragments and an asChild child). Negative optical offsets, ml-auto, vertical margins and icons inside a wrapper element pass.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
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
        // One report per icon: a sized icon is fixed first.
        const reported = new Set();
        for (const child of node.children) {
          for (const icon of collectIcons(child)) {
            const match = ICON_DIMENSION_CLASS.exec(classNameText(icon, context.sourceCode));
            if (match) {
              reported.add(icon);
              context.report({
                node: icon,
                message: `Remove "${match[0]}": the ${name} size variant sizes its icons. Use a size-* class only for a deliberate exception (src/components/ui/button.tsx).`,
              });
            }
          }
        }
        const rendered = jsxAttribute(node.openingElement, 'asChild')
          ? onlyElementChild(node)
          : node;
        for (const child of rendered?.children ?? []) {
          for (const icon of collectDirectIcons(child)) {
            if (reported.has(icon)) {
              continue;
            }
            const match = ICON_HORIZONTAL_MARGIN_CLASS.exec(
              classNameText(icon, context.sourceCode)
            );
            if (match) {
              context.report({
                node: icon,
                message: `Remove "${match[0]}": the ${name} gap already spaces its icon from the label (src/components/ui/button.tsx).`,
              });
            }
          }
        }
      },
    };
  },
};
