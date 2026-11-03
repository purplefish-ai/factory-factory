/** Every weight a Phosphor icon definition module ships. */
export const phosphorWeights = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const;
export type PhosphorWeight = (typeof phosphorWeights)[number];

/**
 * Non-default weights each icon may render, keyed by its `dist/csr/<Name>` module name.
 * `regular` (the IconBase default) is always kept. The build plugin in
 * `scripts/phosphor-icon-weights.ts` drops every other weight, and the icon policy
 * test in `src/lib/icon-library.test.ts` fails when source uses a weight not listed
 * here or when an entry here is no longer used.
 */
export const phosphorWeightAllowlist: Readonly<
  Partial<Record<Exclude<PhosphorWeight, 'regular'>, readonly string[]>>
> = {
  fill: ['CheckCircle', 'Circle', 'Play', 'Square', 'Wrench'],
  duotone: [
    'Acorn',
    'Butterfly',
    'Cactus',
    'Clover',
    'Flower',
    'FlowerLotus',
    'Leaf',
    'Plant',
    'PottedPlant',
    'Sun',
    'Tree',
    'TreeEvergreen',
  ],
};

export function isPhosphorWeight(value: unknown): value is PhosphorWeight {
  return phosphorWeights.some((weight) => weight === value);
}

export function allowedPhosphorWeights(icon: string): ReadonlySet<PhosphorWeight> {
  return new Set<PhosphorWeight>([
    'regular',
    ...phosphorWeights.filter((weight) =>
      weight === 'regular' ? false : phosphorWeightAllowlist[weight]?.includes(icon)
    ),
  ]);
}
