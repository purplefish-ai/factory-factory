// Icon-only buttons need an accessible name, including the shared `Button`
// icon sizes.
import { jsxAttribute, jsxTagName } from '../lib/jsx.mjs';

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

export default {
  meta: {
    docs: {
      description:
        'Require an accessible name (aria-label, aria-labelledby, title or screen-reader text) for icon-only buttons, including the shared Button icon sizes, and a non-empty IconButton label.',
    },
  },
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
};
