-- CreateTable
CREATE TABLE "QualityReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "rulesetVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "summary" TEXT NOT NULL,
    "params" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QualityReport_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "storageKey" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "dismissedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QualityFinding_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QualityFinding_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "QualityReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "findingId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "params" TEXT,
    "beforeSnapshot" TEXT NOT NULL,
    "afterSnapshot" TEXT,
    "executedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" DATETIME,
    "rollbackResult" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QualityAction_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "QualityFinding" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QualityAction_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QualityReport_ownerId_createdAt_idx" ON "QualityReport"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QualityFinding_ownerId_fingerprint_key" ON "QualityFinding"("ownerId", "fingerprint");

-- CreateIndex
CREATE INDEX "QualityFinding_ownerId_status_severity_idx" ON "QualityFinding"("ownerId", "status", "severity");

-- CreateIndex
CREATE INDEX "QualityFinding_reportId_idx" ON "QualityFinding"("reportId");

-- CreateIndex
CREATE INDEX "QualityFinding_ownerId_ruleCode_idx" ON "QualityFinding"("ownerId", "ruleCode");

-- CreateIndex
CREATE INDEX "QualityAction_findingId_idx" ON "QualityAction"("findingId");

-- CreateIndex
CREATE INDEX "QualityAction_ownerId_executedAt_idx" ON "QualityAction"("ownerId", "executedAt");
