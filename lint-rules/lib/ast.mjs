// AST helpers shared by several rules.
export function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

export function memberName(node) {
  if (node?.type !== 'MemberExpression') {
    return undefined;
  }
  return node.computed ? node.property.value : node.property.name;
}

export function isMember(node, object, property) {
  return isIdentifier(node?.object, object) && memberName(node) === property;
}

export function isFunction(node) {
  return ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
    node?.type
  );
}

/** A property or key name that does not depend on runtime values. */
export function staticKeyName(key, computed) {
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
