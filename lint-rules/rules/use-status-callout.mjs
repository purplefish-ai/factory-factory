// Status surfaces render with StatusCallout or StatusChip
// (docs/status-colors.md#callouts-and-chips). Tests are exempt.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';

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

export default {
  meta: {
    docs: {
      description:
        'Reject a class string pairing a tinted status background (bg-destructive/5) with a border of the same status token (border-destructive/30); render that surface with StatusCallout or StatusChip. Hover, focus and data-state tints pass.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
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
};
