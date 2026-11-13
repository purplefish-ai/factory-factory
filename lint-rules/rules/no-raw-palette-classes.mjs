// Fixed Tailwind palette colors must use theme tokens instead
// (docs/status-colors.md). Enabled for src/client, src/components and src/lib.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import exceptions from './no-raw-palette-classes.exceptions.json' with { type: 'json' };

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

export default {
  meta: {
    docs: {
      description:
        'Reject fixed Tailwind palette color classes (bg-red-500, dark:text-emerald-300); use theme tokens instead.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    // Fixed palette exceptions are explained in docs/status-colors.md.
    if (isExceptedFile(context, exceptions)) {
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
};
