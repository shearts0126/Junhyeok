-- 인증 모델의 물리 컬럼을 snake_case 로 통일한다 (T0-6 보완).
--
-- Prisma 필드명은 camelCase 를 유지하고 @map 으로 물리 컬럼을 지정한다.
-- raw SQL·트리거·수동 조회에서 따옴표 없이 쓸 수 있어야 하고,
-- 기존 DB 설계 규약(snake_case)과도 맞아야 한다.
--
-- ⚠️ 비파괴 변경이다. RENAME COLUMN 은 데이터를 보존하며,
--    PostgreSQL 이 인덱스·FK·PK 의 컬럼 참조를 자동으로 따라간다.
--    다만 제약·인덱스의 **이름**은 따라가지 않으므로 함께 rename 한다.
--    (이름이 어긋나면 Prisma 가 drift 로 감지한다)

-- ── 컬럼 rename ─────────────────────────────────────────────────
ALTER TABLE "user" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "user" RENAME COLUMN "updatedAt" TO "updated_at";

ALTER TABLE "role" RENAME COLUMN "roleCode" TO "role_code";
ALTER TABLE "role" RENAME COLUMN "roleName" TO "role_name";

ALTER TABLE "permission" RENAME COLUMN "permissionKey" TO "permission_key";

ALTER TABLE "role_permission" RENAME COLUMN "roleId" TO "role_id";
ALTER TABLE "role_permission" RENAME COLUMN "permissionId" TO "permission_id";

ALTER TABLE "user_role" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "user_role" RENAME COLUMN "roleId" TO "role_id";
ALTER TABLE "user_role" RENAME COLUMN "grantedAt" TO "granted_at";
ALTER TABLE "user_role" RENAME COLUMN "grantedBy" TO "granted_by";

-- ── 인덱스 rename ───────────────────────────────────────────────
ALTER INDEX "role_roleCode_key" RENAME TO "role_role_code_key";
ALTER INDEX "permission_permissionKey_key" RENAME TO "permission_permission_key_key";
ALTER INDEX "role_permission_permissionId_idx" RENAME TO "role_permission_permission_id_idx";
ALTER INDEX "user_role_roleId_idx" RENAME TO "user_role_role_id_idx";

-- ── FK 제약 rename ──────────────────────────────────────────────
ALTER TABLE "role_permission" RENAME CONSTRAINT "role_permission_roleId_fkey" TO "role_permission_role_id_fkey";
ALTER TABLE "role_permission" RENAME CONSTRAINT "role_permission_permissionId_fkey" TO "role_permission_permission_id_fkey";
ALTER TABLE "user_role" RENAME CONSTRAINT "user_role_userId_fkey" TO "user_role_user_id_fkey";
ALTER TABLE "user_role" RENAME CONSTRAINT "user_role_roleId_fkey" TO "user_role_role_id_fkey";
