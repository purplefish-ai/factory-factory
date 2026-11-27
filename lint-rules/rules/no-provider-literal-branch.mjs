// Behaviour that differs by provider belongs behind the provider module
// (src/backend/services/session/service/providers/), or travels as data: a
// capability flag or a value the caller passes in. A comparison against
// 'CLAUDE' or 'CODEX' elsewhere makes adding a provider a change to every such
// site. Enabled for src/, outside tests, stories and test support.
//
// What the rule matches: `===`, `!==`, `==` and `!=` with either operand a
// string literal (or an expression-free template) 'CLAUDE' or 'CODEX', also inside
// parentheses or a TypeScript `as`, `satisfies`, `!` or `<T>` wrapper, and
// `case 'CLAUDE':` or `case 'CODEX':` in a `switch`. The literals as values (an
// argument, an object property, a type union, a Zod enum, a Prisma enum member)
// are not branching and are allowed.
//
// What it does not match: a comparison through a constant or an enum member
// (`provider === SessionProvider.CLAUDE`), `['CLAUDE', 'CODEX'].includes(x)`,
// or a literal compared in another spelling. It is a ratchet, not a proof: the
// files that compare today are listed in the exceptions file, and a new
// comparison inside one of them still passes. The list shrinks when a file
// stops comparing, and no file can join it.
import { unwrapExpression } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { isTestSupportFile } from '../lib/test-support.mjs';
import exceptions from './no-provider-literal-branch.exceptions.json' with { type: 'json' };

const PROVIDERS = new Set(['CLAUDE', 'CODEX']);
const COMPARISONS = new Set(['===', '!==', '==', '!=']);
const PROVIDER_MODULE = 'src/backend/services/session/service/providers/';

const MESSAGE =
  "Do not branch on 'CLAUDE' or 'CODEX'. Put provider-specific behaviour behind the provider module (src/backend/services/session/service/providers/), or pass the capability as data.";

function isProviderLiteral(operand) {
  const node = unwrapExpression(operand);
  if (node?.type === 'Literal') {
    return typeof node.value === 'string' && PROVIDERS.has(node.value);
  }
  return (
    node?.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    PROVIDERS.has(node.quasis[0].value.cooked)
  );
}

export default {
  meta: {
    docs: {
      description:
        "Reject a comparison against the string literals 'CLAUDE' or 'CODEX' (===, !==, ==, != and `case` labels) outside src/backend/services/session/service/providers/; put provider-specific behaviour behind the provider module or pass a capability as data. The literals as values are allowed, and a new comparison inside an already excepted file still passes. Tests, stories and test support are exempt.",
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (
      context.filename.replaceAll('\\', '/').includes(PROVIDER_MODULE) ||
      isTestSupportFile(context) ||
      isExceptedFile(context, exceptions)
    ) {
      return {};
    }
    const report = (node) => context.report({ node, message: MESSAGE });
    return {
      BinaryExpression(node) {
        if (
          COMPARISONS.has(node.operator) &&
          (isProviderLiteral(node.left) || isProviderLiteral(node.right))
        ) {
          report(node);
        }
      },
      SwitchCase(node) {
        if (isProviderLiteral(node.test)) {
          report(node);
        }
      },
    };
  },
};
