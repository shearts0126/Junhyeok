/**
 * 감사로그 이력 조회 projection (T1-6B3).
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §29~§31
 *    (2026-08-11 SKU 변경이력 Design Recovery Decision).
 *
 * ## 좁은 projection 이다
 *
 * SKU 상세 변경이력 화면이 실제로 쓰는 필드만 낸다. ⛔ `approvedBy` ·
 * `requestId` · `sessionId` · `ipAddress` 는 **응답에 넣지 않는다** —
 * 그것들은 future global `/admin/audit-logs` 의 범위다(`05 §11.19`).
 *
 * ⛔ AuditLog 스키마를 다른 모듈 도메인 모델로 복제하지 않는다.
 * ⛔ generic audit browser service 를 선구현하지 않는다.
 */

/** 조회 결과 1행. `beforeValue`/`afterValue` 는 **저장된 JSON 원형** 그대로다. */
export interface AuditHistoryItem {
  readonly id: string;
  /** 이 범위에서는 `Sku` · `SkuBarcode` 뿐이다 (`docs/16` §29). */
  readonly entityType: string;
  readonly entityId: string;
  /** `text` 컬럼이라 enum 이 아니다 — 미지의 값도 그대로 흘린다. */
  readonly action: string;
  /**
   * ⚠️ `null` 은 두 가지 의미가 될 수 있다 —
   *    저장된 JSON `null`(CREATE 계열)과 SQL NULL. 화면은 둘을 구분하지 않고
   *    `null` 로 표시한다(`docs/16` §33).
   */
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  /** UUID 원문. ⛔ 사용자 이름을 추정하지 않는다 (`docs/16` §32). */
  readonly actorId: string;
  /** ISO 8601 */
  readonly occurredAt: string;
  /** `reason` 컬럼 — SKU SUBMIT/APPROVE 의 `note` 도 여기 들어온다. */
  readonly reason: string | null;
}

/** repository 가 읽어오는 최소 행 모양. */
export interface AuditHistoryRow {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly actorId: string;
  readonly occurredAt: Date;
  readonly reason: string | null;
}

export function toAuditHistoryItem(row: AuditHistoryRow): AuditHistoryItem {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    // ★ 저장된 값을 가공하지 않는다 — Decimal 문자열·ISO 날짜·REDACTED 전부 원형.
    beforeValue: row.beforeValue ?? null,
    afterValue: row.afterValue ?? null,
    actorId: row.actorId,
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
  };
}
