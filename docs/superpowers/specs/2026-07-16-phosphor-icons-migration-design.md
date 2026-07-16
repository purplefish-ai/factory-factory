# Phosphor Icons Migration Design

## Goal

Replace `lucide-react` with `@phosphor-icons/react` across the application so the repository uses one icon system everywhere.

## Scope

- Migrate every application, shared component, client route, story, and test that imports or mocks `lucide-react`.
- Remove `lucide-react` from `package.json` and the lockfile.
- Add `@phosphor-icons/react` as the sole general-purpose React icon dependency.
- Preserve the existing custom Factory Factory logo and any other repository-owned SVG artwork.
- Update documentation that explicitly directs contributors to use Lucide.

## Import and Naming Strategy

Components will import icons directly from `@phosphor-icons/react`. The migration will use Phosphor's current native component exports, which use the `*Icon` suffix, rather than aliasing them to Lucide names, and it will not add a local compatibility barrel.

Each Lucide icon will be replaced with the closest semantic Phosphor equivalent. Examples include:

- `Loader2` → `SpinnerGapIcon`
- `RefreshCw` → `ArrowsClockwiseIcon`
- `AlertTriangle` → `WarningIcon`
- `CheckCircle2` → `CheckCircleIcon`
- `XCircle` → `XCircleIcon`
- `MoreHorizontal` → `DotsThreeIcon`
- `Github` → `GithubLogoIcon`
- `PanelLeft` / `PanelRight` → `SidebarSimpleIcon` with the appropriate direction or mirroring

When no exact shape match exists, semantic meaning takes precedence over visual similarity.

## Visual Behavior

Phosphor's `regular` weight is the application default. No global `IconContext` provider is required because `regular` is already the package default and direct imports keep component behavior explicit.

Existing Tailwind classes and SVG props that control dimensions, color, animation, accessibility, and layout will be retained where compatible. Spinners will continue to use the existing `animate-spin` classes. Intentional filled status markers may use `weight="fill"` only where the current icon is already visually filled; the general application default remains `regular`.

The migration will not redesign layouts, alter labels, change interactions, or introduce unrelated styling changes.

## Type Migration

Places that store icon components in configuration objects or accept icons as props will replace Lucide's `LucideIcon` type with Phosphor's exported `Icon` type. Existing component interfaces and runtime behavior will otherwise remain unchanged.

## Tests

Tests that mock the icon package will mock `@phosphor-icons/react` and expose the Phosphor export names used by the component under test.

Tests that inspect Lucide-generated CSS classes will be rewritten to assert stable application behavior or explicit accessible/test selectors. Vendor-generated SVG class names are not part of the application's contract and will not be replaced with assertions against Phosphor internals.

Regression coverage will ensure:

- No source, story, or test imports or mocks `lucide-react`.
- No tests depend on `lucide-*` classes.
- Icon-bearing components still render the correct semantic states.
- TypeScript accepts all dynamic icon component types and props.

## Dependency and Bundle Considerations

The app will use named imports from `@phosphor-icons/react`, which the package documents as tree-shakeable. The existing Vite application build will be used to validate production bundling. A compatibility barrel or namespace import will not be introduced because either would obscure icon ownership and could weaken tree-shaking.

## Verification

The completed migration must pass:

1. Focused tests for components whose icon assertions or mocks change.
2. `pnpm test`
3. `pnpm typecheck`
4. `pnpm check`
5. `pnpm build`
6. Repository searches confirming no remaining `lucide-react`, `LucideIcon`, or `lucide-` references in active source, stories, tests, package metadata, or icon guidance.

`pnpm check:fix` will be run as needed to apply the repository's formatting and lint rules, followed by the relevant verification commands again.

## Out of Scope

- Redesigning the Factory Factory logo.
- Introducing a project-wide icon wrapper.
- Changing icon weights globally away from `regular`.
- Reworking unrelated component structure or visual styling.
