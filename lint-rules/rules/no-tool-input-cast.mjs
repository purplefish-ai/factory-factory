// Type assertions on agent-supplied data under src/client/features/chat: tool
// input such as `input.todos as …` or `call.input.file_path as …`, which
// renderers parse with `parseToolInput` and a Zod schema, and stream payloads
// such as `event.delta as …` or `event.content_block as …`, which the reducer
// path parses with Zod and skips when they do not match.
import { isIdentifier, memberName } from '../lib/ast.mjs';

/** Agent-supplied members: tool input, and stream event deltas and content blocks. */
const AGENT_PAYLOAD_MEMBERS = new Set(['input', 'delta', 'content_block']);

/**
 * `input`, `input.todos`, `call.input.file_path`, `input?.["offset"]`,
 * `event.delta`, `event.content_block` and similar.
 */
function readsAgentPayload(node) {
  let current = node;
  while (current) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSNonNullExpression'
    ) {
      current = current.expression;
    } else if (current.type === 'MemberExpression') {
      if (AGENT_PAYLOAD_MEMBERS.has(memberName(current))) {
        return true;
      }
      current = current.object;
    } else {
      return isIdentifier(current, 'input');
    }
  }
  return false;
}

export default {
  meta: {
    docs: {
      description:
        'Reject type assertions on agent-supplied tool input and stream payloads (input, delta, content_block); parse them with parseToolInput or a Zod schema.',
    },
  },
  create(context) {
    // Tool input and stream payloads are agent-supplied; renderers parse tool
    // input with the schemas in tool-renderers/tool-input-schemas.ts and fall
    // back to raw JSON, and the reducer path skips payloads it cannot parse.
    const report = (node) => {
      if (node.typeAnnotation.typeName?.name === 'const' || !readsAgentPayload(node.expression)) {
        return;
      }
      context.report({
        node,
        message:
          'Parse agent tool input (parseToolInput) or stream payloads with a Zod schema instead of a type assertion.',
      });
    };
    return { TSAsExpression: report, TSTypeAssertion: report };
  },
};
