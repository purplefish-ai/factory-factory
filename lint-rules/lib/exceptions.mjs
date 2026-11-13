// File exceptions shared by the rules that take an `exceptions` option.

export function isListedFile(context, paths) {
  const filename = context.filename.replaceAll('\\', '/');
  return paths.some((path) => filename === path || filename.endsWith(`/${path}`));
}

// `exceptions` maps repository-relative paths to the reason each file may keep
// the reported pattern; a test fails once a listed file no longer needs it.
// A rule's default map is its `rules/<rule-name>.exceptions.json`; an
// `exceptions` option replaces it.
export const EXCEPTIONS_SCHEMA = [
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

export function isExceptedFile(context, exceptions = {}) {
  return isListedFile(context, Object.keys(context.options[0]?.exceptions ?? exceptions));
}
