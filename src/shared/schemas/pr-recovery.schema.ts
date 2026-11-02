import { z } from 'zod';
import { prEventBackupSchema } from './pr-monitoring-backup.schema';

const instant = z.iso.datetime().nullable();
export const prDeliveryRecoverySchema = z.strictObject({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  eventIds: z.array(z.string().min(1)).min(1),
  state: z.string().min(1),
  sessionId: z.string().nullable(),
  provider: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  bindingRevision: z.number().int().nonnegative().nullable(),
  text: prEventBackupSchema.shape.deliveryText,
  attempts: z.number().int().nonnegative(),
  claimedAt: instant,
  deliveredAt: instant,
});
// Raw normalized facts need no copied frozen envelope; the batch owns that evidence.
export const prFactRecoverySchema = z.strictObject({
  ...prEventBackupSchema.shape,
  batchId: z.string().min(1).nullable(),
});
export const prRecoverySchema = z
  .strictObject({
    deliveries: z.array(prDeliveryRecoverySchema),
    events: z.array(prFactRecoverySchema),
  })
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    const events = new Map(snapshot.events.map((event) => [event.id, event]));
    if (events.size !== snapshot.events.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate PR receipt identity' });
    }
    for (const delivery of snapshot.deliveries) {
      const members = snapshot.events.filter(
        (event) => event.batchId === delivery.id || event.deliveryId === delivery.id
      );
      if (
        ids.has(delivery.id) ||
        new Set(delivery.eventIds).size !== delivery.eventIds.length ||
        members.length !== delivery.eventIds.length ||
        members.some(
          (event) =>
            !delivery.eventIds.includes(event.id) || event.workspaceId !== delivery.workspaceId
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Incomplete or inconsistent PR delivery membership',
        });
      }
      ids.add(delivery.id);
    }
    for (const event of snapshot.events) {
      // A normalized batch owns its frozen envelope. Older unbatched rows must
      // still carry their own complete metadata, as required by v6/v7 imports.
      const { batchId, ...legacy } = event;
      if (!(batchId || prEventBackupSchema.safeParse(legacy).success)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid unbatched PR fact payload or frozen delivery metadata',
        });
      }
      if (
        event.kind !== event.payload.kind ||
        (event.batchId && !ids.has(event.batchId)) ||
        (event.batchId && event.deliveryId && event.batchId !== event.deliveryId)
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid PR receipt payload or batch reference' });
      }
    }
  });
export type PRRecovery = z.infer<typeof prRecoverySchema>;
