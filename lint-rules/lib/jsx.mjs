// JSX helpers shared by several rules.
export function jsxTagName(node) {
  return node.type === 'JSXMemberExpression'
    ? `${jsxTagName(node.object)}.${node.property.name}`
    : node.name;
}

export function jsxAttribute(opening, name) {
  return opening.attributes.find(
    (attribute) => attribute.type === 'JSXAttribute' && attribute.name.name === name
  );
}

export function classNameText(opening, sourceCode) {
  const attribute = opening.attributes.find(
    (candidate) => candidate.type === 'JSXAttribute' && candidate.name.name === 'className'
  );
  return attribute?.value ? sourceCode.getText(attribute.value) : '';
}

/** The element an `asChild` trigger renders: its only JSX child, if any. */
export function onlyElementChild(node) {
  const children = node.children.filter(
    (child) =>
      !(child.type === 'JSXText' && !child.value.trim()) &&
      !(child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression')
  );
  return children.length === 1 && children[0].type === 'JSXElement' ? children[0] : undefined;
}
