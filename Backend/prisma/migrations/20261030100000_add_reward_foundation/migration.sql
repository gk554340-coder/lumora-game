-- AlterTable
ALTER TABLE "PlayerProfile"
ADD COLUMN "dailyStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastDailyClaimOn" DATE;

-- AlterTable
ALTER TABLE "RewardDefinition" ADD COLUMN "code" VARCHAR(100) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RewardDefinition_code_key" ON "RewardDefinition"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RewardGrant_userId_rewardDefinitionId_sourceId_key" ON "RewardGrant"("userId", "rewardDefinitionId", "sourceId");
