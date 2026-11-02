-- Preserve every original receipt ID and full membership. Never choose a
-- representative value from inconsistent evidence: quarantine it unchanged.
CREATE TABLE "WorkspacePRDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "workspaceId" TEXT NOT NULL,
 "eventIds" JSONB NOT NULL,
 "state" TEXT NOT NULL,
 "sessionId" TEXT,
 "provider" TEXT,
 "providerSessionId" TEXT,
 "bindingRevision" INTEGER,
 "text" TEXT,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "claimedAt" DATETIME,
 "deliveredAt" DATETIME,
 CONSTRAINT "WorkspacePRDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkspacePRDelivery_workspaceId_state_idx" ON "WorkspacePRDelivery"("workspaceId", "state");
-- NO ACTION checks after workspace cascades; a malformed cross-workspace
-- group must never cascade deletion into another workspace's evidence.
ALTER TABLE "WorkspacePREvent" ADD COLUMN "batchId" TEXT REFERENCES "WorkspacePRDelivery"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "WorkspacePREvent_batchId_idx" ON "WorkspacePREvent"("batchId");
CREATE TEMP TABLE valid_pr_delivery AS
SELECT e.deliveryId AS id FROM WorkspacePREvent e WHERE e.deliveryId IS NOT NULL AND length(e.deliveryId)>0 AND
NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.workspaceId IS NOT e.workspaceId)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.state IS NOT e.state)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliverySessionId IS NOT e.deliverySessionId)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliveryProvider IS NOT e.deliveryProvider)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliveryProviderSessionId IS NOT e.deliveryProviderSessionId)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliveryBindingRevision IS NOT e.deliveryBindingRevision)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliveryText IS NOT e.deliveryText)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.attempts IS NOT e.attempts)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.claimedAt IS NOT e.claimedAt)
 AND NOT EXISTS (SELECT 1 FROM WorkspacePREvent other WHERE other.deliveryId = e.deliveryId AND other.deliveredAt IS NOT e.deliveredAt)
 AND e.state IN ('PENDING','DISPATCHING','DELIVERED','CANCELLED')
 AND length(e.deliverySessionId)>0
 AND e.deliveryProvider IN ('CLAUDE','CODEX')
 AND length(e.deliveryProviderSessionId)>0
 AND length(e.deliveryText)>0
 AND length(CAST(e.deliveryText AS BLOB)) <= 16384
 AND e.deliveryBindingRevision >= 0
 AND e.attempts >= 0
GROUP BY e.deliveryId;
INSERT INTO WorkspacePRDelivery(id,workspaceId,eventIds,state,sessionId,provider,providerSessionId,bindingRevision,text,attempts,claimedAt,deliveredAt)
SELECT e.deliveryId, e.workspaceId,
 (SELECT json_group_array(id) FROM (SELECT id FROM WorkspacePREvent member WHERE member.deliveryId=e.deliveryId ORDER BY createdAt,id)),
 CASE WHEN valid.id IS NULL THEN 'BLOCKED' ELSE e.state END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliverySessionId END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliveryProvider END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliveryProviderSessionId END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliveryBindingRevision END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliveryText END,
 CASE WHEN valid.id IS NOT NULL THEN e.attempts ELSE 0 END,
 CASE WHEN valid.id IS NOT NULL THEN e.claimedAt END,
 CASE WHEN valid.id IS NOT NULL THEN e.deliveredAt END
FROM WorkspacePREvent e LEFT JOIN valid_pr_delivery valid ON valid.id=e.deliveryId
WHERE e.deliveryId IS NOT NULL GROUP BY e.deliveryId;
UPDATE WorkspacePREvent SET batchId=deliveryId WHERE deliveryId IS NOT NULL;
-- Null the redundant compatible columns only after a proven valid backfill.
UPDATE WorkspacePREvent SET state='PENDING',attempts=0,deliveryId=NULL,deliverySessionId=NULL,deliveryProvider=NULL,deliveryProviderSessionId=NULL,deliveryBindingRevision=NULL,deliveryText=NULL,claimedAt=NULL,deliveredAt=NULL
WHERE deliveryId IN (SELECT id FROM valid_pr_delivery);
DROP TABLE valid_pr_delivery;
