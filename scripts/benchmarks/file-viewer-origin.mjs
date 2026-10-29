export function parseBenchmarkOrigin(input = 'http://127.0.0.1:5173/') {
  const invalidOrigin = 'Expected an HTTP(S) origin without a path, query, hash, or credentials';
  let origin;
  try {
    origin = new URL(input);
  } catch {
    throw new Error(invalidOrigin);
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(invalidOrigin);
  }
  return origin;
}
