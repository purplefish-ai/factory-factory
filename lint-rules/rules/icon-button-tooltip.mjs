// Icon buttons use IconButton, whose label is both the accessible name and the
// tooltip (docs/shadcn.md#buttons-icon-buttons-and-tooltips).
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { jsxAttribute, jsxTagName, onlyElementChild } from '../lib/jsx.mjs';

/** A literal `size="icon…"` on a Button. */
function hasIconSize(opening) {
  const size = jsxAttribute(opening, 'size');
  return size?.value?.type === 'Literal' && /^icon(?:-|$)/.test(size.value.value);
}

export default {
  meta: {
    docs: {
      description:
        'Reject an icon-size Button rendered by TooltipTrigger asChild (also through nested …Trigger asChild elements) or carrying a native title; use IconButton.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
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
};
