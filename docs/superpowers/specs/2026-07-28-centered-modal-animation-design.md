# Centered Modal Animation Design

## Goal

Make every centered modal animate from its resting center position instead of traveling diagonally across the viewport. Provider Settings is the motivating example, but the behavior should be consistent across all standard and confirmation modals.

## Scope

Update the shared `DialogContent` and `AlertDialogContent` primitives. Their consumers should inherit the new behavior without call-site changes.

Side sheets, drawers, menus, popovers, tooltips, and other anchored surfaces are out of scope because their directional motion communicates where they came from.

## Interaction Design

On open, modal content will fade from transparent to opaque and scale subtly from 95% to 100% while remaining centered. On close, the animation will reverse. The existing 200 ms duration and overlay fade will remain unchanged.

Remove the directional enter and exit translation offsets from both centered modal primitives. Retain the layout translation that positions content at the viewport center.

For users who request reduced motion, modal content should appear without scale or directional movement. The overlay may retain a simple opacity transition.

## Implementation Boundaries

- Change `src/components/ui/dialog.tsx`.
- Change `src/components/ui/alert-dialog.tsx`.
- Do not add per-modal variants or update individual consumers.
- Do not change the `Sheet` primitive or anchored overlay components.
- Keep the public component APIs unchanged.

## Verification

- Confirm Provider Settings opens and closes from the center.
- Confirm a regular modal and an alert/confirmation modal use the same centered motion.
- Confirm modal content remains centered at the beginning, during, and after animation.
- Confirm sheets retain their existing directional animation.
- Confirm reduced-motion mode removes content scale and travel.
- Run focused tests for the shared primitives, then run type checking and standard repository checks.
