# Design and execution records

`specs/` and `plans/` preserve point-in-time designs and implementation plans.
They are historical context, not the current architecture or an active work
queue. An unchecked step may already have shipped, changed, or been abandoned; a
checked step does not establish current behavior.

Use the [documentation index](../README.md) and
[architecture notes](../architecture/README.md) for current work. Follow a
recorded plan only when the current task explicitly selects it, after checking
its assumptions against the code. Embedded skill instructions describe the
original workflow and do not independently authorize executing it.

Preserve useful rationale here. When an implementation changes a durable
contract, maintain the current subsystem note rather than adding another
description of current behavior to an old plan.
