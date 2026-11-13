// `animate-spin` as a class, with optional variants (`motion-safe:animate-spin`).
const ANIMATE_SPIN_CLASS = /(?<=^|[\s'"`:!])animate-spin(?![\w-])/;

export function hasSpinClass(text) {
  return typeof text === 'string' && ANIMATE_SPIN_CLASS.test(text);
}
