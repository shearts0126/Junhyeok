import { findCommonCodeRefs, type CommonCodeRefClient } from '@/modules/common-code/application';
import type { TransactionClient } from '@/shared/db';

/**
 * SKU 승인 전 검증 9종 — V1~V9 (T1-4A).
 *
 * ⚠️ 원 PRD(SKU·BOM 상세 PRD v0.1 §15.1)가 repository 에 존재하지 않아,
 *    `docs/08_설계복구_승인전검증9종.md` (2026-08-09 Design Recovery Decision)로
 *    복구 확정된 canonical contract 를 구현한다. 목록·severity·시점(submit +
 *    approve 재검증)의 근거는 모두 그 문서다 — 여기서 임의로 바꾸지 않는다.
 *
 * ## 상태 4값
 *
 *   - PASS / FAIL          — 실제 판정 결과
 *   - CHECK_UNAVAILABLE    — 판정 근거(정확한 패턴 등)가 아직 설계에 없음.
 *                            **PASS 로 위장하거나 조용히 숨기지 않는다.**
 *   - NOT_APPLICABLE       — 검사 대상 모듈/데이터가 아직 없음 (V7~V9 barcode).
 *
 * FAIL+ERROR 만 submit/approve 를 차단한다. FAIL+WARNING 은 응답에 포함하되
 * 진행을 막지 않는다.
 */

export const SKU_APPROVAL_CHECKS = [
  'REQUIRED_FIELD_MISSING', // V1 ERROR
  'SKU_CODE_DUPLICATE', // V2 ERROR
  'ITEM_TYPE_UNMAPPED', // V3 ERROR
  'BRAND_CODE_NOT_FOUND', // V4 ERROR
  'CATEGORY_CODE_NOT_FOUND', // V5 ERROR
  'SKU_CODE_PATTERN_VIOLATION', // V6 WARNING
  'BARCODE_SCIENTIFIC_NOTATION', // V7 ERROR
  'BARCODE_UNVERIFIED', // V8 ERROR
  'BARCODE_DUPLICATE', // V9 WARNING
] as const;

export type SkuApprovalCheckCode = (typeof SKU_APPROVAL_CHECKS)[number];

export type SkuApprovalSeverity = 'ERROR' | 'WARNING';

export const SKU_APPROVAL_CHECK_SEVERITY: Readonly<
  Record<SkuApprovalCheckCode, SkuApprovalSeverity>
> = {
  REQUIRED_FIELD_MISSING: 'ERROR',
  SKU_CODE_DUPLICATE: 'ERROR',
  ITEM_TYPE_UNMAPPED: 'ERROR',
  BRAND_CODE_NOT_FOUND: 'ERROR',
  CATEGORY_CODE_NOT_FOUND: 'ERROR',
  // ⛔ ERROR 승격 금지 (D-06 — 코드체계 위반 SKU `FB-SB` 실존)
  SKU_CODE_PATTERN_VIOLATION: 'WARNING',
  BARCODE_SCIENTIFIC_NOTATION: 'ERROR',
  BARCODE_UNVERIFIED: 'ERROR',
  BARCODE_DUPLICATE: 'WARNING',
};

export type SkuApprovalCheckStatus = 'PASS' | 'FAIL' | 'CHECK_UNAVAILABLE' | 'NOT_APPLICABLE';

export interface SkuApprovalValidationResult {
  readonly code: SkuApprovalCheckCode;
  readonly severity: SkuApprovalSeverity;
  readonly status: SkuApprovalCheckStatus;
  readonly message?: string;
}

export interface SkuApprovalValidationReport {
  readonly checks: readonly SkuApprovalValidationResult[];
  /** ERROR severity 의 FAIL 존재 여부 — submit/approve 차단 조건. */
  readonly hasErrors: boolean;
  /** WARNING severity 의 FAIL 존재 여부 — 차단하지 않고 응답에 포함. */
  readonly hasWarnings: boolean;
}

/**
 * V3 vocabulary — authoritative: `01_AS-IS_엑셀분석.md §1.4` (실측 15종 중
 * 시스템 코드 14종) + `06_데이터_마이그레이션설계*.md §12.4` ("15종 매핑,
 * 미매칭은 오류").
 *
 * ⛔ ITEM_TYPE CommonCode 그룹·enum 컬럼을 만들지 않는다 — `Sku.itemType` 은
 *    String 유지(T1-1 확정)이며 이 목록은 **승인 검증에서만** 쓴다.
 */
export const SKU_ITEM_TYPES = [
  'FINISHED_GOOD',
  'KIT_FINISHED_GOOD',
  'NONSALE_FINISHED_GOOD',
  'SEMI_FINISHED_GOOD',
  'PACKAGING_MATERIAL',
  'COMMON_PACKAGING_MATERIAL',
  'KIT_PACKAGING_MATERIAL',
  'MATERIAL',
  'CONSUMABLE',
  'SALON_SUPPLY',
  'SAMPLE',
  'SERVICE',
  'MOLD',
  'ETC',
] as const;

/** 검증에 필요한 SKU persisted state 의 최소 형태. */
export interface SkuApprovalTarget {
  readonly id: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly itemType: string;
  readonly baseUom: string;
  readonly brandId: string | null;
  readonly majorCategoryId: string | null;
  readonly minorCategoryId: string | null;
}

/** report 계산에 필요한 최소 클라이언트. */
export type SkuApprovalValidationClient = CommonCodeRefClient & Pick<TransactionClient, 'sku'>;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

const NOT_APPLICABLE_BARCODE_MESSAGE =
  'NOT_APPLICABLE_UNTIL_BARCODE_MODULE — SkuBarcode 모듈 도입 후 연결된다.';

/**
 * V1~V9 report 를 계산한다. **persisted state 기준**이다 — Create DTO 가 이미
 * 검증한 값이라도 승인 시점의 DB 상태로 다시 판정한다.
 *
 * submit 과 approve **둘 다** 이 report 를 새로 계산한다 (08 문서 §4 —
 * submit 후 approve 전 사이에 참조 공통코드가 비활성화될 수 있다).
 */
export async function buildSkuApprovalValidationReport(
  client: SkuApprovalValidationClient,
  sku: SkuApprovalTarget,
): Promise<SkuApprovalValidationReport> {
  const checks: SkuApprovalValidationResult[] = [];
  const push = (
    code: SkuApprovalCheckCode,
    status: SkuApprovalCheckStatus,
    message?: string,
  ): void => {
    checks.push({
      code,
      severity: SKU_APPROVAL_CHECK_SEVERITY[code],
      status,
      ...(message !== undefined ? { message } : {}),
    });
  };

  // ── V1 REQUIRED_FIELD_MISSING ──────────────────────────────
  const missing = (
    [
      ['skuCode', sku.skuCode],
      ['skuName', sku.skuName],
      ['itemType', sku.itemType],
      ['baseUom', sku.baseUom],
    ] as const
  )
    .filter(([, value]) => blank(value))
    .map(([field]) => field);
  push(
    'REQUIRED_FIELD_MISSING',
    missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? undefined : `누락된 핵심값: ${missing.join(', ')}`,
  );

  // ── V2 SKU_CODE_DUPLICATE (자기 자신 제외) ─────────────────
  const duplicates = await client.sku.count({
    where: { skuCode: sku.skuCode, id: { not: sku.id } },
  });
  push(
    'SKU_CODE_DUPLICATE',
    duplicates === 0 ? 'PASS' : 'FAIL',
    duplicates === 0 ? undefined : `동일 skuCode ${duplicates}건 존재`,
  );

  // ── V3 ITEM_TYPE_UNMAPPED ──────────────────────────────────
  const itemTypeKnown = (SKU_ITEM_TYPES as readonly string[]).includes(sku.itemType);
  push(
    'ITEM_TYPE_UNMAPPED',
    itemTypeKnown ? 'PASS' : 'FAIL',
    itemTypeKnown
      ? undefined
      : `'${sku.itemType}' 은(는) 품목구분 14종(01 §1.4)에 해당하지 않습니다.`,
  );

  // ── V4/V5 공통코드 참조 (null 은 검사 대상 아님 — 오류 금지) ─
  const refTargets = [
    { check: 'BRAND_CODE_NOT_FOUND' as const, field: 'brandId', id: sku.brandId, group: 'BRAND' },
    {
      check: 'CATEGORY_CODE_NOT_FOUND' as const,
      field: 'majorCategoryId',
      id: sku.majorCategoryId,
      group: 'MAJOR_CATEGORY',
    },
    {
      check: 'CATEGORY_CODE_NOT_FOUND' as const,
      field: 'minorCategoryId',
      id: sku.minorCategoryId,
      group: 'MINOR_CATEGORY',
    },
  ];
  const idsToResolve = refTargets
    .map((target) => target.id)
    .filter((id): id is string => id !== null);
  const refs = await findCommonCodeRefs(client, idsToResolve);
  const byId = new Map(refs.map((ref) => [ref.id, ref]));

  const refProblems = new Map<'BRAND_CODE_NOT_FOUND' | 'CATEGORY_CODE_NOT_FOUND', string[]>();
  for (const target of refTargets) {
    if (target.id === null) continue;
    const ref = byId.get(target.id);
    const problem =
      ref === undefined
        ? `${target.field}: 존재하지 않음`
        : ref.groupCode !== target.group
          ? `${target.field}: '${target.group}' 그룹이 아님 (현재 '${ref.groupCode}')`
          : !ref.active
            ? `${target.field}: 비활성 코드`
            : null;
    if (problem !== null) {
      const list = refProblems.get(target.check) ?? [];
      list.push(problem);
      refProblems.set(target.check, list);
    }
  }
  for (const check of ['BRAND_CODE_NOT_FOUND', 'CATEGORY_CODE_NOT_FOUND'] as const) {
    const problems = refProblems.get(check);
    push(check, problems === undefined ? 'PASS' : 'FAIL', problems?.join(' / '));
  }

  // ── V6 SKU_CODE_PATTERN_VIOLATION — CHECK_UNAVAILABLE ─────
  // 코드체계는 `브랜드-대분류-소분류-일련번호`(00 v0.2 D-06)로 이름만 확정돼
  // 있고, 기계 판정 가능한 정확한 패턴(세그먼트 문자집합·길이, `FB-DP-016` 이
  // 위반으로 분류되지 않은 기준)이 문서에 없다. 정규식을 발명하지 않는다.
  push(
    'SKU_CODE_PATTERN_VIOLATION',
    'CHECK_UNAVAILABLE',
    '정확한 코드체계 패턴이 authoritative 문서에 없어 판정하지 않는다 (08 문서 V6).',
  );

  // ── V7~V9 — barcode 모듈 부재 ──────────────────────────────
  push('BARCODE_SCIENTIFIC_NOTATION', 'NOT_APPLICABLE', NOT_APPLICABLE_BARCODE_MESSAGE);
  push('BARCODE_UNVERIFIED', 'NOT_APPLICABLE', NOT_APPLICABLE_BARCODE_MESSAGE);
  push('BARCODE_DUPLICATE', 'NOT_APPLICABLE', NOT_APPLICABLE_BARCODE_MESSAGE);

  return {
    checks,
    hasErrors: checks.some((check) => check.severity === 'ERROR' && check.status === 'FAIL'),
    hasWarnings: checks.some((check) => check.severity === 'WARNING' && check.status === 'FAIL'),
  };
}
