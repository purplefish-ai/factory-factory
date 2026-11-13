# Agent-friendly codebase principles

What the repository's structure is optimised for, and how to decide where a new
rule, fact or tool belongs. [Maintaining agent guidance](agent-guidance.md)
covers the instruction files themselves.

An agent starts each task knowing nothing about this repository, with a bounded
context window, usually while other agents change the same tree. Each principle
removes one way that goes wrong.

These are targets, not a description of the repository today. The
[program plan](../superpowers/plans/2026-11-13-agent-friendly-codebase.md)
records the 2026-11-13 baseline and the outstanding work.

## 1. Orientation costs little

An agent finds where a change belongs from directory structure, names and a
short guide that loads with the directory. A guide states what the unit owns,
its public surface, its invariants and a map of what is inside it.

Test: the guides an agent must read before editing any one file total about
4,000 tokens or less.

## 2. Units fit in a context window

Anything an agent must understand to change safely has an explicit public
surface and is small enough to read. When a unit outgrows that, split it into
units with their own surfaces.

A line cap is a backstop. Files settling just under the cap mean the unit needs
splitting, not trimming.

## 3. Rules are checks

A rule that matters is a type, a lint rule or a script whose failure message
names the fix. Prose carries only what a check cannot: the reason.

Exceptions live in configuration with a reason, and a test fails once an
exception is no longer needed. When a prose rule is broken twice, write the
check.

## 4. Each kind of knowledge has one home

| Knowledge                        | Home                                       |
| -------------------------------- | ------------------------------------------ |
| What the software does           | Tests                                      |
| Ownership, invariants, map       | The area guide (`AGENTS.md`)               |
| Why a decision was made          | A dated decision record, fixed after merge |
| How to make a multi-file change  | A recipe                                   |
| What changed and when            | Git history and the changelog              |
| What is being worked on, and how | A plan, removed when the work is done      |

A change in behaviour changes tests. It changes a guide only when ownership, an
invariant, a public surface or the map changed.

## 5. Feedback is fast and true

The whole local verification sequence runs in a few minutes, and a failure
always means a defect in the change. A test that fails without one is a defect
in the feedback loop; fix it before other work.

## 6. Changes are proven in the running application

An agent can start an isolated instance with its own data directory and ports,
and with no real provider, credentials or external service, then drive it and
attach evidence.

Passing tests show the code does what the tests say. Only the running
application shows it does what was asked.

## 7. Parallel work touches different files

One fact lives in one small file next to what it describes, and registries are
composed from those files. A file that most pull requests must edit is a design
fault whatever it contains: a note, a baseline, a registry or a configuration
file.

## 8. Recipes live in the repository

A sequence that agents repeat is written once, versioned with the code and
usable from any agent tool. Personal configuration may add to it; nothing the
work depends on lives only there.

## 9. Outcomes are measured

We track how agent work goes: first-run CI pass rate, pushes per pull request,
follow-up fixes, flaky tests, guide size and the most-edited files. A change to
guidance or structure is an experiment against those numbers.

## Deciding where something goes

When an agent gets something wrong, apply the first of these that works:

1. Change the structure so the mistake cannot be written: a type, a narrower
   public surface, a single owner module.
2. Add a check whose message names the fix.
3. Add a recipe, when the mistake is in a sequence of steps.
4. Add a line to the nearest guide, when it is an invariant no check can
   express.
5. Record a decision, when what was missing is a reason.

Describing the corrected behaviour in a note is not on the list. That is what
the regression test is for.
