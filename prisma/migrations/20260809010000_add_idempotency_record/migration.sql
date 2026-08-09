-- 공용 멱등성 기록 (T1-3 보완)
--
-- 멱등 scope = (actor_id, http_method, route_scope, idempotency_key).
-- key 단독 UNIQUE 가 아니다 — 다른 actor / 다른 endpoint 의 동일 key 는 독립이다.
-- response_status / response_body 는 reservation 직후 NULL 이지만,
-- business 작업과 같은 트랜잭션에서 채워져 commit 되므로 커밋된 행에서 NULL 이 아니다.
-- TTL / cleanup / 상태 컬럼은 현재 요구사항에 없어 만들지 않는다.

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "http_method" VARCHAR(10) NOT NULL,
    "route_scope" VARCHAR(200) NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- 멱등 scope UNIQUE — 동시 claim 의 최종 직렬화 장치다.
CREATE UNIQUE INDEX "idempotency_record_scope_key"
  ON "idempotency_record"("actor_id", "http_method", "route_scope", "idempotency_key");

-- 멱등 기록은 replay 근거다 — 사용자 삭제에 딸려 지워지면 안 된다 (audit_log 와 동일 정책).
ALTER TABLE "idempotency_record"
  ADD CONSTRAINT "idempotency_record_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 빈 값 금지 (기존 btrim CHECK convention)
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_http_method_not_blank_check"
  CHECK (length("http_method") > 0 AND "http_method" = btrim("http_method"));
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_route_scope_not_blank_check"
  CHECK (length("route_scope") > 0 AND "route_scope" = btrim("route_scope"));
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_key_not_blank_check"
  CHECK (length(btrim("idempotency_key")) > 0);

-- request_hash 는 SHA-256 lowercase hex 64자만
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_request_hash_sha256_check"
  CHECK ("request_hash" ~ '^[0-9a-f]{64}$');
