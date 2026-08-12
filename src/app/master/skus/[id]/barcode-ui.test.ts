import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  BARCODE_ALL_STATUSES,
  BARCODE_TYPES,
  approveDuplicateSchema,
  createBarcodeSchema,
  requestDuplicateCandidateSchema,
  updateBarcodeSchema,
} from '@/modules/barcode/application';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../../../prisma/seed/roles';
import { SKU_CREATE_TABS, SKU_DETAIL_TABS } from '../sku-form-fields';

import {
  BARCODE_ACTION_PERMISSIONS,
  BARCODE_ROW_STATUSES,
  BARCODE_STATUS_LABELS,
  BARCODE_TYPE_OPTIONS,
  DASH,
  DUPLICATE_WARNING,
  EMPTY_BARCODE_CREATE_FORM,
  barcodeActionsForStatus,
  buildApproveDuplicatePayload,
  buildBarcodeCreatePayload,
  buildDuplicateCandidatePayload,
  buildReactivatePayload,
  buildTogglePrimaryPayload,
  formatBarcodePeriod,
  isApprovalReasonValid,
  isApprovedDuplicate,
  isDuplicateBarcodeConflict,
  isPendingDuplicate,
  orDash,
  visibleBarcodeActions,
  type BarcodeRow,
} from './barcode-form';

/**
 * SKU 상세 바코드 탭 helper 단위 테스트 (T1-6B1).
 *
 * 계약 근거는 `docs/16_설계복구_SKU상세잔여탭.md` 이며, 바코드 API 계약 자체는
 * `docs/10`(T04-3) · `docs/11`(T04-4A) 이다. 화면 동작 자체는
 * `tests/e2e/barcode-tab.e2e.ts` 가 실 브라우저로 본다 — repo 의 unit 프로젝트는
 * node 환경이라 컴포넌트 렌더링 대역이 없다(T1-5A/T1-6A/T05-4A 와 같은 분업).
 *
 * ★ 이 파일의 존재 이유는 **helper 가 backend Zod DTO 와 어긋나지 않게 고정**하는
 *   것이다. helper 는 Prisma 를 끌고 오는 barrel 을 import 하지 않으므로, 정합은
 *   여기서만 검증된다.
 */

const ROW: BarcodeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  skuId: '22222222-2222-4222-8222-222222222222',
  barcode: '8809619961373',
  barcodeType: 'UNIT',
  isPrimary: false,
  countryCode: null,
  channelCode: null,
  status: 'ACTIVE',
  duplicateException: false,
  exceptionReason: null,
  approvedBy: null,
  effectiveFrom: null,
  effectiveTo: null,
  createdAt: '2026-08-11T00:00:00.000Z',
};

const ALL_PERMISSIONS = [
  'barcode.read',
  'barcode.create',
  'barcode.update',
  'barcode.deactivate',
  'barcode.request_duplicate',
  'barcode.approve_duplicate',
];

// ═══════════════════════════════════════════════════════════════
// 탭 구성 (docs/16 §7)
// ═══════════════════════════════════════════════════════════════

describe('★ 등록/상세 탭 배열 분리', () => {
  it('1. 등록 화면은 기존 3탭 그대로다 — 바코드 탭이 없다', () => {
    expect(SKU_CREATE_TABS.map((tab) => tab.key)).toEqual(['basic', 'classification', 'inventory']);
    expect(SKU_CREATE_TABS.map((tab) => tab.label)).toEqual([
      '기본정보',
      '코드·분류',
      '재고관리 설정',
    ]);
    expect(SKU_CREATE_TABS.map((tab) => tab.key) as readonly string[]).not.toContain('barcode');
  });

  it('2. 상세 화면 탭에 바코드가 포함된다', () => {
    expect(SKU_DETAIL_TABS.some((tab) => tab.key === 'barcode')).toBe(true);
    expect(SKU_DETAIL_TABS.find((tab) => tab.key === 'barcode')?.label).toBe('바코드');
  });

  it('3. ★ 바코드는 코드·분류 바로 다음이다 (원문 8탭의 ③ 자리)', () => {
    // ⚠️ 전체 탭 수·순서는 `external-mapping-ui.test.ts` 가 고정한다 — 탭이 늘어날
    //    때마다 두 파일이 같은 단정을 중복하지 않도록 여기서는 상대 위치만 본다.
    const keys = SKU_DETAIL_TABS.map((tab) => tab.key) as readonly string[];
    expect(keys.indexOf('barcode')).toBe(keys.indexOf('classification') + 1);
  });

  it('4. 아직 없는 탭(공급조건·BOM)은 어느 배열에도 없다', () => {
    const labels = [...SKU_CREATE_TABS, ...SKU_DETAIL_TABS].map((tab) => tab.label);
    for (const absent of ['공급조건', 'BOM']) {
      expect(labels, absent).not.toContain(absent);
    }
  });

  it('5. 상세 탭은 등록 탭의 상위집합이다 (라벨 중복 정의 없음)', () => {
    for (const tab of SKU_CREATE_TABS) {
      expect(
        SKU_DETAIL_TABS.some((entry) => entry.key === tab.key && entry.label === tab.label),
      ).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 권한 (docs/16 §12)
// ═══════════════════════════════════════════════════════════════

describe('★ 바코드 권한 — permission 키로만 판단한다', () => {
  it('6. helper 가 쓰는 permission 키가 전부 seed 에 존재한다', () => {
    const seeded = new Set(PERMISSION_SEED.map((entry) => entry.permissionKey));
    for (const permission of Object.values(BARCODE_ACTION_PERMISSIONS)) {
      expect(seeded.has(permission), permission).toBe(true);
    }
    expect(seeded.has('barcode.read')).toBe(true);
    expect(seeded.has('barcode.create')).toBe(true);
  });

  it('7. ★ 액션별 permission 매핑이 backend 계약과 같다', () => {
    expect(BARCODE_ACTION_PERMISSIONS).toEqual({
      togglePrimary: 'barcode.update',
      deactivate: 'barcode.deactivate',
      reactivate: 'barcode.update',
      approveDuplicate: 'barcode.approve_duplicate',
      cancelCandidate: 'barcode.deactivate',
    });
  });

  it('8. ★ 승인은 ADMIN·SCM_LEADER 뿐이고 요청은 SCM_STAFF 도 가능하다 (실제 seed)', () => {
    const rolesFor = (key: string) =>
      ROLE_PERMISSION_SEED.filter((entry) => entry.permissionKey === key)
        .map((entry) => entry.roleCode)
        .sort();

    expect(rolesFor('barcode.approve_duplicate')).toEqual(['ADMIN', 'SCM_LEADER']);
    expect(rolesFor('barcode.request_duplicate')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesFor('barcode.read')).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    // FINANCE·EXECUTIVE 는 어떤 바코드 변경 권한도 갖지 않는다.
    for (const key of [
      'barcode.create',
      'barcode.update',
      'barcode.deactivate',
      'barcode.request_duplicate',
      'barcode.approve_duplicate',
    ]) {
      expect(rolesFor(key), key).not.toContain('FINANCE');
      expect(rolesFor(key), key).not.toContain('EXECUTIVE');
    }
  });

  it('9. ★ 권한이 없으면 액션이 노출되지 않는다 (ADMIN bypass 없음)', () => {
    expect(visibleBarcodeActions('ACTIVE', [])).toEqual([]);
    expect(visibleBarcodeActions('PENDING_DUPLICATE', [])).toEqual([]);
    // 아직 /api/me 응답 전(null)에도 아무 것도 노출하지 않는다.
    expect(visibleBarcodeActions('ACTIVE', null)).toEqual([]);
  });

  it('10. ★ SCM_STAFF 권한집합에서는 승인 액션이 나오지 않는다', () => {
    const staff = [
      'barcode.read',
      'barcode.create',
      'barcode.update',
      'barcode.deactivate',
      'barcode.request_duplicate',
    ];
    expect(visibleBarcodeActions('PENDING_DUPLICATE', staff)).toEqual(['cancelCandidate']);
    expect(visibleBarcodeActions('PENDING_DUPLICATE', staff)).not.toContain('approveDuplicate');
  });

  it('11. 6개 endpoint 의 proxy 1차 정책이 바코드 전용 권한으로 잡힌다', () => {
    const sku = '/api/skus/11111111-1111-4111-8111-111111111111';
    const bid = '22222222-2222-4222-8222-222222222222';
    expect(resolveRoutePermission({ pathname: `${sku}/barcodes`, method: 'GET' })).toBe(
      'barcode.read',
    );
    expect(resolveRoutePermission({ pathname: `${sku}/barcodes`, method: 'POST' })).toBe(
      'barcode.create',
    );
    expect(resolveRoutePermission({ pathname: `${sku}/barcodes/${bid}`, method: 'PATCH' })).toBe(
      'barcode.update',
    );
    expect(resolveRoutePermission({ pathname: `${sku}/barcodes/${bid}`, method: 'DELETE' })).toBe(
      'barcode.deactivate',
    );
    expect(
      resolveRoutePermission({ pathname: `${sku}/barcodes/duplicate-candidates`, method: 'POST' }),
    ).toBe('barcode.request_duplicate');
    expect(
      resolveRoutePermission({
        pathname: `${sku}/barcodes/${bid}/approve-duplicate`,
        method: 'POST',
      }),
    ).toBe('barcode.approve_duplicate');
  });
});

// ═══════════════════════════════════════════════════════════════
// 등록 DTO (docs/16 §8)
// ═══════════════════════════════════════════════════════════════

describe('★ 등록 payload — createBarcodeSchema 와 정확히 같다', () => {
  it('12. 최소 payload 가 실제 Zod DTO 를 통과한다', () => {
    const payload = buildBarcodeCreatePayload({
      barcode: '8809619961373',
      barcodeType: 'UNIT',
      isPrimary: false,
    });
    expect(payload).toEqual({ barcode: '8809619961373', barcodeType: 'UNIT' });
    expect(createBarcodeSchema.safeParse(payload).success).toBe(true);
  });

  it('13. isPrimary 는 true 일 때만 키가 들어간다', () => {
    const payload = buildBarcodeCreatePayload({
      barcode: '8801',
      barcodeType: 'INNER_BOX',
      isPrimary: true,
    });
    expect(payload).toEqual({ barcode: '8801', barcodeType: 'INNER_BOX', isPrimary: true });
    expect(createBarcodeSchema.safeParse(payload).success).toBe(true);
  });

  it('14. ★ 조회 전용 필드(국가·채널·적용기간)는 payload 에 절대 없다', () => {
    const payload = buildBarcodeCreatePayload({
      barcode: '8801',
      barcodeType: 'UNIT',
      isPrimary: true,
    }) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'countryCode',
      'channelCode',
      'effectiveFrom',
      'effectiveTo',
      'status',
      'duplicateException',
      'exceptionReason',
      'approvedBy',
      'skuId',
      'id',
    ]) {
      expect(Object.hasOwn(payload, forbidden), forbidden).toBe(false);
    }
  });

  it('15. ★ 서버가 금지한 필드를 하나라도 넣으면 strict DTO 가 거부한다 (계약 확인)', () => {
    expect(
      createBarcodeSchema.safeParse({
        barcode: '8801',
        barcodeType: 'UNIT',
        countryCode: 'KR',
      }).success,
    ).toBe(false);
  });

  it('16. ★ UI 가 trim 하지 않는다 — 정규화는 서버 권위다', () => {
    expect(
      buildBarcodeCreatePayload({ barcode: ' 880 1 ', barcodeType: 'UNIT', isPrimary: false }),
    ).toEqual({ barcode: ' 880 1 ', barcodeType: 'UNIT' });
  });

  it('17. 빈 폼 기본값 — UNIT · 대표 아님', () => {
    expect(EMPTY_BARCODE_CREATE_FORM).toEqual({
      barcode: '',
      barcodeType: 'UNIT',
      isPrimary: false,
    });
  });

  it('18. 타입 옵션이 BARCODE_TYPES 5종과 값·순서까지 같다', () => {
    expect(BARCODE_TYPE_OPTIONS.map((option) => option.value)).toEqual([...BARCODE_TYPES]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 중복 판정 (docs/16 §10)
// ═══════════════════════════════════════════════════════════════

describe('★ 중복 감지 — BARCODE_DUPLICATE 만 CTA 를 띄운다', () => {
  it('19. 409 BARCODE_DUPLICATE 는 중복으로 판정한다', () => {
    expect(isDuplicateBarcodeConflict({ status: 409, code: 'BARCODE_DUPLICATE' })).toBe(true);
  });

  it('20. ★ 다른 409 는 중복이 아니다 — 잘못된 CTA 를 띄우면 안 된다', () => {
    for (const code of [
      'BARCODE_PRIMARY_CONFLICT',
      'BARCODE_DUPLICATE_CANDIDATE_EXISTS',
      'IDEMPOTENCY_KEY_REUSED',
    ]) {
      expect(isDuplicateBarcodeConflict({ status: 409, code }), code).toBe(false);
    }
  });

  it('21. 422·400·null 도 중복이 아니다', () => {
    expect(isDuplicateBarcodeConflict({ status: 422, code: 'BARCODE_UNVERIFIED' })).toBe(false);
    expect(isDuplicateBarcodeConflict({ status: 400, code: 'VALIDATION_ERROR' })).toBe(false);
    expect(isDuplicateBarcodeConflict({ status: 409, code: null })).toBe(false);
    expect(isDuplicateBarcodeConflict(null)).toBe(false);
  });

  it('22. ★ 안내문이 다른 SKU 정보를 담지 않는다', () => {
    expect(DUPLICATE_WARNING).toContain('다른 SKU');
    expect(DUPLICATE_WARNING).toContain('중복 예외 요청');
    // 상대 SKU 코드/이름을 넣을 자리표시자가 없어야 한다.
    expect(DUPLICATE_WARNING).not.toMatch(/\{|\$\{|%s/);
  });

  it('23. 관련 오류코드가 실제 ERROR_CODES 에 있고 HTTP 상태가 계약과 같다', () => {
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_PRIMARY_CONFLICT)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE_CANDIDATE_EXISTS)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_INVALID_STATE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_PENDING)).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════════════
// 중복 예외 요청 (docs/16 §9)
// ═══════════════════════════════════════════════════════════════

describe('★ 중복 예외 요청 payload', () => {
  it('24. ★ 등록 입력값을 그대로 재사용한다 — UI 가 값을 바꾸지 않는다', () => {
    const form = { barcode: '8809619961373', barcodeType: 'UNIT' as const, isPrimary: true };
    expect(buildDuplicateCandidatePayload(form)).toEqual(buildBarcodeCreatePayload(form));
  });

  it('25. candidate DTO 는 create DTO 와 같은 스키마다 (backend 계약)', () => {
    const payload = buildDuplicateCandidatePayload({
      barcode: '8801',
      barcodeType: 'CHANNEL',
      isPrimary: false,
    });
    expect(requestDuplicateCandidateSchema.safeParse(payload).success).toBe(true);
    expect(createBarcodeSchema.safeParse(payload).success).toBe(true);
  });

  it('26. candidate payload 에도 금지 필드가 섞이지 않는다', () => {
    const payload = buildDuplicateCandidatePayload({
      barcode: '8801',
      barcodeType: 'UNIT',
      isPrimary: false,
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['barcode', 'barcodeType']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 액션 매트릭스 (docs/16 §11·§13)
// ═══════════════════════════════════════════════════════════════

describe('★ status 별 액션 매트릭스', () => {
  it('27. ACTIVE — 대표 지정/해제 · 비활성', () => {
    expect(barcodeActionsForStatus('ACTIVE')).toEqual(['togglePrimary', 'deactivate']);
  });

  it('28. INACTIVE — 재활성만', () => {
    expect(barcodeActionsForStatus('INACTIVE')).toEqual(['reactivate']);
  });

  it('29. ★ PENDING_DUPLICATE — 승인 · 요청 취소 뿐 (일반 수정 액션 없음)', () => {
    const actions = barcodeActionsForStatus('PENDING_DUPLICATE');
    expect(actions).toEqual(['approveDuplicate', 'cancelCandidate']);
    expect(actions).not.toContain('togglePrimary');
    expect(actions).not.toContain('reactivate');
    expect(actions).not.toContain('deactivate');
  });

  it('30. 알 수 없는 status 에는 액션을 발명하지 않는다', () => {
    expect(barcodeActionsForStatus('WHATEVER')).toEqual([]);
  });

  it('31. ★ revoke 계열 액션이 어떤 status 에도 없다', () => {
    const every = BARCODE_ROW_STATUSES.flatMap((status) =>
      visibleBarcodeActions(status, ALL_PERMISSIONS),
    );
    for (const action of every) {
      expect(action).not.toMatch(/revoke|clear|unapprove/i);
    }
    expect(new Set(every)).toEqual(
      new Set(['togglePrimary', 'deactivate', 'reactivate', 'approveDuplicate', 'cancelCandidate']),
    );
  });

  it('32. 업무 status 3종이 backend BARCODE_ALL_STATUSES 와 같다', () => {
    expect([...BARCODE_ROW_STATUSES].sort()).toEqual([...BARCODE_ALL_STATUSES].sort());
    for (const status of BARCODE_ROW_STATUSES) {
      expect(BARCODE_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(BARCODE_STATUS_LABELS.PENDING_DUPLICATE).toBe('중복 예외 승인 대기');
  });
});

// ═══════════════════════════════════════════════════════════════
// mutation payload (docs/16 §13)
// ═══════════════════════════════════════════════════════════════

describe('★ 행 mutation payload', () => {
  it('33. 대표 지정/해제 PATCH — 현재 값의 반대만 보낸다', () => {
    expect(buildTogglePrimaryPayload({ isPrimary: false })).toEqual({ isPrimary: true });
    expect(buildTogglePrimaryPayload({ isPrimary: true })).toEqual({ isPrimary: false });
    expect(updateBarcodeSchema.safeParse({ isPrimary: true }).success).toBe(true);
  });

  it('34. ★ 다른 행의 대표를 함께 해제하는 payload 를 만들지 않는다', () => {
    const payload = buildTogglePrimaryPayload({ isPrimary: false }) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual(['isPrimary']);
  });

  it('35. 재활성 PATCH — {status:"ACTIVE"} 만', () => {
    expect(buildReactivatePayload()).toEqual({ status: 'ACTIVE' });
    expect(updateBarcodeSchema.safeParse(buildReactivatePayload()).success).toBe(true);
  });

  it('36. ★ 일반 PATCH 로 PENDING_DUPLICATE 를 만들 수 없다 (backend 계약 확인)', () => {
    expect(updateBarcodeSchema.safeParse({ status: 'PENDING_DUPLICATE' }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 승인 (docs/16 §11)
// ═══════════════════════════════════════════════════════════════

describe('★ 중복 예외 승인 payload', () => {
  it('37. body 는 {reason} 뿐이다', () => {
    const payload = buildApproveDuplicatePayload('원본 중복 확인 완료');
    expect(payload).toEqual({ reason: '원본 중복 확인 완료' });
    expect(approveDuplicateSchema.safeParse(payload).success).toBe(true);
  });

  it('38. ★ 저장되는 값과 같도록 trim 해서 보낸다', () => {
    expect(buildApproveDuplicatePayload('  사유  ')).toEqual({ reason: '사유' });
    const parsed = approveDuplicateSchema.parse({ reason: '  사유  ' });
    expect(parsed.reason).toBe(buildApproveDuplicatePayload('  사유  ').reason);
  });

  it('39. 공백만인 사유는 client 에서도 막는다 (서버도 400 이다)', () => {
    expect(isApprovalReasonValid('   ')).toBe(false);
    expect(isApprovalReasonValid('')).toBe(false);
    expect(isApprovalReasonValid(' 사유 ')).toBe(true);
    expect(approveDuplicateSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });

  it('40. ★ 최대 길이를 새로 만들지 않는다 — 긴 사유도 통과한다', () => {
    const long = '가'.repeat(5_000);
    expect(isApprovalReasonValid(long)).toBe(true);
    expect(approveDuplicateSchema.safeParse(buildApproveDuplicatePayload(long)).success).toBe(true);
  });

  it('41. reason 외 필드를 넣으면 strict DTO 가 거부한다 (계약 확인)', () => {
    expect(approveDuplicateSchema.safeParse({ reason: '사유', approvedBy: 'x' }).success).toBe(
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 표시 (docs/16 §11·§13)
// ═══════════════════════════════════════════════════════════════

describe('★ 행 표시', () => {
  it('42. 승인 대기·승인 완료 판정', () => {
    expect(isPendingDuplicate({ status: 'PENDING_DUPLICATE' })).toBe(true);
    expect(isPendingDuplicate({ status: 'ACTIVE' })).toBe(false);

    expect(isApprovedDuplicate({ status: 'ACTIVE', duplicateException: true })).toBe(true);
    expect(isApprovedDuplicate({ status: 'ACTIVE', duplicateException: false })).toBe(false);
    // 비활성으로 내려간 예외 행은 "승인된 예외 배지" 대상이 아니다.
    expect(isApprovedDuplicate({ status: 'INACTIVE', duplicateException: true })).toBe(false);
    // 후보는 아직 예외가 아니다.
    expect(isApprovedDuplicate({ status: 'PENDING_DUPLICATE', duplicateException: false })).toBe(
      false,
    );
  });

  it('43. ★ 조회 전용 메타의 null 은 0·공란이 아니라 —', () => {
    expect(orDash(ROW.countryCode)).toBe(DASH);
    expect(orDash(ROW.channelCode)).toBe(DASH);
    expect(orDash('')).toBe(DASH);
    expect(orDash('KR')).toBe('KR');
    expect(formatBarcodePeriod(null, null)).toBe(DASH);
    expect(formatBarcodePeriod('2026-01-01', null)).toBe(`2026-01-01 ~ ${DASH}`);
    expect(formatBarcodePeriod(null, '2026-12-31')).toBe(`${DASH} ~ 2026-12-31`);
    expect(formatBarcodePeriod('2026-01-01', '2026-12-31')).toBe('2026-01-01 ~ 2026-12-31');
  });

  it('44. ★ 승인자·승인시각을 표시할 helper 자체를 만들지 않았다', async () => {
    // `approvedBy` 는 UUID 뿐이고 `approvedAt` 컬럼도 없으며, 사용자·감사로그
    // 조회 API 도 만들지 않는다 — 그래서 표시 helper 도 존재하지 않아야 한다.
    const barcodeForm = await import('./barcode-form');
    for (const name of Object.keys(barcodeForm)) {
      expect(name, name).not.toMatch(/approvedBy|approvedAt|approver|승인자/i);
    }
    expect(ROW.approvedBy).toBeNull();
  });
});
