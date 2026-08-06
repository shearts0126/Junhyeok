CREATE TABLE "common_code_group" (
    "id" UUID NOT NULL,
    "group_code" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "description" TEXT,
    "parent_group_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "common_code_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "common_code" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_code_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "attributes" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "common_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "common_code_group_group_code_key" ON "common_code_group"("group_code");

-- CreateIndex
CREATE INDEX "common_code_group_id_active_sort_order_idx" ON "common_code"("group_id", "active", "sort_order");

-- CreateIndex
CREATE INDEX "common_code_parent_code_id_idx" ON "common_code"("parent_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "common_code_group_id_code_key" ON "common_code"("group_id", "code");

-- AddForeignKey
ALTER TABLE "common_code_group" ADD CONSTRAINT "common_code_group_parent_group_id_fkey" FOREIGN KEY ("parent_group_id") REFERENCES "common_code_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code_group" ADD CONSTRAINT "common_code_group_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code_group" ADD CONSTRAINT "common_code_group_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code" ADD CONSTRAINT "common_code_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "common_code_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code" ADD CONSTRAINT "common_code_parent_code_id_fkey" FOREIGN KEY ("parent_code_id") REFERENCES "common_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code" ADD CONSTRAINT "common_code_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_code" ADD CONSTRAINT "common_code_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════
-- CHECK 제약 (수기 추가 — Prisma 스키마 언어는 CHECK 를 표현하지 못함)
-- ═══════════════════════════════════════════════════════════════

-- 그룹 코드는 빈 문자열·앞뒤 공백 금지
ALTER TABLE "common_code_group"
  ADD CONSTRAINT "common_code_group_code_not_blank_check"
  CHECK (length("group_code") > 0 AND "group_code" = btrim("group_code"));

-- 그룹 이름도 공백만으로는 안 된다
ALTER TABLE "common_code_group"
  ADD CONSTRAINT "common_code_group_name_not_blank_check"
  CHECK (length(btrim("group_name")) > 0);

ALTER TABLE "common_code_group"
  ADD CONSTRAINT "common_code_group_sort_order_check"
  CHECK ("sort_order" >= 0);

-- 자기 자신을 부모 그룹으로 지정 금지
ALTER TABLE "common_code_group"
  ADD CONSTRAINT "common_code_group_no_self_parent_check"
  CHECK ("parent_group_id" IS NULL OR "parent_group_id" <> "id");

-- 코드는 빈 문자열·앞뒤 공백 금지
ALTER TABLE "common_code"
  ADD CONSTRAINT "common_code_code_not_blank_check"
  CHECK (length("code") > 0 AND "code" = btrim("code"));

-- 이름은 빈 문자열·앞뒤 공백 금지 (내부 공백은 허용)
ALTER TABLE "common_code"
  ADD CONSTRAINT "common_code_name_not_blank_check"
  CHECK (length("name") > 0 AND "name" = btrim("name"));

ALTER TABLE "common_code"
  ADD CONSTRAINT "common_code_sort_order_check"
  CHECK ("sort_order" >= 0);

-- 자기 자신을 부모 코드로 지정 금지 (순환의 최소 형태를 DB 에서도 차단)
ALTER TABLE "common_code"
  ADD CONSTRAINT "common_code_no_self_parent_check"
  CHECK ("parent_code_id" IS NULL OR "parent_code_id" <> "id");
