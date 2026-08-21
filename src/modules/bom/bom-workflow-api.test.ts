import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  bomCloneRouteScope,
  parseActivateBomInput,
  parseApproveBomInput,
  parseArchiveBomInput,
  parseCloneBomInput,
  parseDeactivateBomInput,
  parseRejectBomInput,
  parseSubmitBomInput,
  resolveBomTransition,
  shouldPerformBomTransition,
  BOM_STATUSES,
  BOM_TRANSITIONS,
  BOM_WORKFLOW_ACTIONS,
  type BomWorkflowAction,
} from '@/modules/bom/application';
import { ERROR_CODES, httpStatusForCode, ValidationError } from '@/shared/errors';

/**
 * BOM workflow 단위 테스트 (T07-5) — DB 없이 고정하는 계약.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6(전이 8개) · §D-8(approve vs activate) ·
 *    §D-15(권한) · §D-17(멱등) · §D-29 +
 *    **`★ T07-5 workflow gap closure`** W-1 · W-3 · W-8 · W-9.
 *
 * §D-32 test matrix 가 T07-5 unit 에 요구한 것: **전이 표 전량** · 자가승인.
 * 자가승인은 DB 설정을 읽으므로 DB 테스트가 담당하고, 여기서는 전이·DTO·
 * route-policy 를 고정한다.
 */

const BOM = 'cccccccc-3333-4333-8333-333333333333';

// ═══════════════════════════════════════════════════════════════
// 전이 그래프 — D-6 8전이 전량
// ═══════════════════════════════════════════════════════════════

describe('★★ 전이 그래프는 D-6 8전이 그대로다', () => {
  it('action 은 정확히 6개다 (clone 은 전이가 아니라 생성)', () => {
    expect([...BOM_WORKFLOW_ACTIONS]).toEqual([
      'submit',
      'approve',
      'reject',
      'activate',
      'deactivate',
      'archive',
    ]);
  });

  it('★ 8개 전이가 전부 있고 그 외는 없다', () => {
    const edges = BOM_WORKFLOW_ACTIONS.flatMap((action) =>
      BOM_TRANSITIONS[action].from.map(
        (from) => `${from}--${action}-->${BOM_TRANSITIONS[action].to}`,
      ),
    );
    expect(edges.sort()).toEqual(
      [
        'DRAFT--submit-->PENDING_APPROVAL',
        'REJECTED--submit-->PENDING_APPROVAL',
        'PENDING_APPROVAL--approve-->APPROVED',
        'PENDING_APPROVAL--reject-->REJECTED',
        'APPROVED--activate-->ACTIVE',
        'ACTIVE--deactivate-->INACTIVE',
        'DRAFT--archive-->ARCHIVED',
        'REJECTED--archive-->ARCHIVED',
      ].sort(),
    );
    expect(edges).toHaveLength(8);
  });

  it('★★ REJECTED → DRAFT 전이를 만들지 않는다 — 바로 재제출한다', () => {
    const targets = BOM_WORKFLOW_ACTIONS.map((action) => BOM_TRANSITIONS[action].to);
    expect(targets).not.toContain('DRAFT');
    expect(resolveBomTransition('submit', 'REJECTED')).toBe('transition');
  });

  it('★★ INACTIVE → ACTIVE 재활성화가 없다 — clone 으로 새 버전을 만든다', () => {
    expect(resolveBomTransition('activate', 'INACTIVE')).toBe('invalid');
    // activate 의 출발 상태는 APPROVED 뿐이다.
    expect([...BOM_TRANSITIONS.activate.from]).toEqual(['APPROVED']);
  });

  it('★ archive 는 DRAFT·REJECTED 만 — 발효 이력은 보관 대상이 아니다', () => {
    expect([...BOM_TRANSITIONS.archive.from].sort()).toEqual(['DRAFT', 'REJECTED']);
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE']) {
      expect(resolveBomTransition('archive', status), status).toBe('invalid');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 7 status × 6 action 전수 matrix
// ═══════════════════════════════════════════════════════════════

describe('★★ 7 status × 6 action 전수 판정 (D-6 · D-17)', () => {
  /** `transition` 이 아닌 상태에서 목표 상태면 `noop`, 그 밖은 `invalid`. */
  const EXPECTED: Readonly<Record<BomWorkflowAction, Readonly<Record<string, string>>>> = {
    submit: {
      DRAFT: 'transition',
      REJECTED: 'transition',
      PENDING_APPROVAL: 'noop',
      APPROVED: 'invalid',
      ACTIVE: 'invalid',
      INACTIVE: 'invalid',
      ARCHIVED: 'invalid',
    },
    approve: {
      PENDING_APPROVAL: 'transition',
      APPROVED: 'noop',
      DRAFT: 'invalid',
      REJECTED: 'invalid',
      ACTIVE: 'invalid',
      INACTIVE: 'invalid',
      ARCHIVED: 'invalid',
    },
    reject: {
      PENDING_APPROVAL: 'transition',
      REJECTED: 'noop',
      DRAFT: 'invalid',
      APPROVED: 'invalid',
      ACTIVE: 'invalid',
      INACTIVE: 'invalid',
      ARCHIVED: 'invalid',
    },
    activate: {
      APPROVED: 'transition',
      ACTIVE: 'noop',
      DRAFT: 'invalid',
      REJECTED: 'invalid',
      PENDING_APPROVAL: 'invalid',
      INACTIVE: 'invalid',
      ARCHIVED: 'invalid',
    },
    deactivate: {
      ACTIVE: 'transition',
      INACTIVE: 'noop',
      DRAFT: 'invalid',
      REJECTED: 'invalid',
      PENDING_APPROVAL: 'invalid',
      APPROVED: 'invalid',
      ARCHIVED: 'invalid',
    },
    archive: {
      DRAFT: 'transition',
      REJECTED: 'transition',
      ARCHIVED: 'noop',
      PENDING_APPROVAL: 'invalid',
      APPROVED: 'invalid',
      ACTIVE: 'invalid',
      INACTIVE: 'invalid',
    },
  };

  it.each(BOM_WORKFLOW_ACTIONS)('%s — 7 status 전부', (action) => {
    for (const status of BOM_STATUSES) {
      expect(resolveBomTransition(action, status), `${action}/${status}`).toBe(
        EXPECTED[action][status],
      );
    }
  });

  it('★ 표가 7 status 를 하나도 빠뜨리지 않았다', () => {
    for (const action of BOM_WORKFLOW_ACTIONS) {
      expect(Object.keys(EXPECTED[action]).sort(), action).toEqual([...BOM_STATUSES].sort());
    }
  });

  it('★★ 목표 상태 반복은 no-op 이고 무관한 상태는 invalid 다 — 위장 금지', () => {
    // 이미 PENDING 인데 submit → no-op(200)
    expect(shouldPerformBomTransition(BOM, 'submit', 'PENDING_APPROVAL')).toBe(false);
    // DRAFT 인데 approve → 무관한 상태이므로 422 다. no-op 으로 위장하지 않는다.
    expect(() => shouldPerformBomTransition(BOM, 'approve', 'DRAFT')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BOM_INVALID_TRANSITION }),
    );
    expect(() => shouldPerformBomTransition(BOM, 'activate', 'PENDING_APPROVAL')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BOM_INVALID_TRANSITION }),
    );
    expect(() => shouldPerformBomTransition(BOM, 'reject', 'APPROVED')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BOM_INVALID_TRANSITION }),
    );
  });

  it('★ `BOM_INVALID_TRANSITION` 은 422 다 (D-29)', () => {
    expect(httpStatusForCode(ERROR_CODES.BOM_INVALID_TRANSITION)).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════════════
// DTO — D-6 body 열 + W-1 archive + W-3 deactivate
// ═══════════════════════════════════════════════════════════════

describe('workflow DTO strict (D-14 공통 규칙)', () => {
  it('submit·approve 는 `{note?}` 이고 본문 없이도 통과한다', () => {
    expect(parseSubmitBomInput(undefined)).toEqual({});
    expect(parseApproveBomInput({})).toEqual({});
    expect(parseSubmitBomInput({ note: '검토 요청' })).toEqual({ note: '검토 요청' });
  });

  it('★ reject 는 `{reason}` **필수** 다 (D-6)', () => {
    expect(() => parseRejectBomInput({})).toThrow(ValidationError);
    expect(() => parseRejectBomInput(undefined)).toThrow(ValidationError);
    expect(parseRejectBomInput({ reason: '단가 재확인' })).toEqual({ reason: '단가 재확인' });
  });

  it('★★ archive 는 `{reason}` **필수** 다 (W-1)', () => {
    expect(() => parseArchiveBomInput({})).toThrow(ValidationError);
    expect(() => parseArchiveBomInput({ note: 'x' })).toThrow(ValidationError);
    expect(parseArchiveBomInput({ reason: '중복 초안' })).toEqual({ reason: '중복 초안' });
  });

  it('★★ deactivate 는 `{effectiveTo, reason}` **둘 다 필수** 다 (D-6)', () => {
    expect(() => parseDeactivateBomInput({ effectiveTo: '2026-08-18' })).toThrow(ValidationError);
    expect(() => parseDeactivateBomInput({ reason: '단종' })).toThrow(ValidationError);
    expect(parseDeactivateBomInput({ effectiveTo: '2026-08-18', reason: '단종' })).toEqual({
      effectiveTo: '2026-08-18',
      reason: '단종',
    });
  });

  it('★ activate 는 `{effectiveFrom?}` — 생략 가능하다', () => {
    expect(parseActivateBomInput({})).toEqual({});
    expect(parseActivateBomInput({ effectiveFrom: '2027-07-01' })).toEqual({
      effectiveFrom: '2027-07-01',
    });
  });

  it('★ clone 은 3개 필드가 **전부 필수** 다 (D-4 · W-5)', () => {
    expect(() => parseCloneBomInput({ newVersion: 'v2' })).toThrow(ValidationError);
    expect(() => parseCloneBomInput({ newVersion: 'v2', effectiveFrom: '2027-01-01' })).toThrow(
      ValidationError,
    );
    expect(
      parseCloneBomInput({
        newVersion: 'v2',
        effectiveFrom: '2027-01-01',
        changeReason: '원가 반영',
      }),
    ).toEqual({ newVersion: 'v2', effectiveFrom: '2027-01-01', changeReason: '원가 반영' });
  });

  it('★★ 모든 DTO 가 unknown key 를 400 으로 막는다', () => {
    const cases: [string, (body: unknown) => unknown][] = [
      ['submit', parseSubmitBomInput],
      ['approve', parseApproveBomInput],
      ['reject', (body) => parseRejectBomInput(body)],
      ['activate', parseActivateBomInput],
      ['archive', (body) => parseArchiveBomInput(body)],
    ];
    for (const [label, parse] of cases) {
      expect(() => parse({ reason: 'x', note: 'y', bogus: 1 }), label).toThrow(ValidationError);
    }
  });

  it('★★ server-managed 필드는 어느 DTO 에도 없다 — 넣으면 400', () => {
    for (const field of ['status', 'createdBy', 'approvedAt', 'approvedBy', 'activatedAt']) {
      expect(() => parseApproveBomInput({ [field]: 'x' }), field).toThrow(ValidationError);
      expect(() => parseActivateBomInput({ [field]: 'x' }), field).toThrow(ValidationError);
    }
  });

  it('★ reason·note 는 trim 된 non-blank 만 받는다 — 공백으로 필수를 우회할 수 없다', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(() => parseRejectBomInput({ reason: blank }), JSON.stringify(blank)).toThrow(
        ValidationError,
      );
      expect(() => parseArchiveBomInput({ reason: blank }), JSON.stringify(blank)).toThrow(
        ValidationError,
      );
    }
    // 앞뒤 공백이 남은 값도 거부한다.
    expect(() => parseRejectBomInput({ reason: ' 사유 ' })).toThrow(ValidationError);
  });

  it('★ 날짜는 `YYYY-MM-DD` 만 — timezone 표기·시각을 받지 않는다', () => {
    for (const bad of ['2026-8-18', '2026/08/18', '2026-08-18T00:00:00Z', '20260818', 'today']) {
      expect(() => parseActivateBomInput({ effectiveFrom: bad }), bad).toThrow(ValidationError);
      expect(() => parseDeactivateBomInput({ effectiveTo: bad, reason: 'x' }), bad).toThrow(
        ValidationError,
      );
    }
  });

  it('★ clone `newVersion` — trim 후 1~20, 자동 채번·semver 파싱 없음 (D-4)', () => {
    const base = { effectiveFrom: '2027-01-01', changeReason: 'r' };
    expect(parseCloneBomInput({ ...base, newVersion: '  v2.0  ' }).newVersion).toBe('v2.0');
    expect(() => parseCloneBomInput({ ...base, newVersion: '   ' })).toThrow(ValidationError);
    expect(() => parseCloneBomInput({ ...base, newVersion: 'x'.repeat(21) })).toThrow(
      ValidationError,
    );
    // ★ case-sensitive — 서버가 정규화하지 않는다.
    expect(parseCloneBomInput({ ...base, newVersion: 'V1.0' }).newVersion).toBe('V1.0');
  });
});

// ═══════════════════════════════════════════════════════════════
// 멱등 scope (D-17 · W-9)
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등 — clone 만 키를 받는다 (D-17)', () => {
  it('scope 는 `bom:{sourceBomId}:clone` 이다', () => {
    expect(bomCloneRouteScope(BOM)).toBe(`bom:${BOM}:clone`);
  });

  it('★ source BOM 마다 독립이다', () => {
    expect(bomCloneRouteScope(BOM)).not.toBe(
      bomCloneRouteScope('11111111-1111-4111-8111-111111111111'),
    );
  });

  it('★★ workflow 6종에는 routeScope helper 자체가 없다 — 멱등 키를 받지 않는다', async () => {
    const barrel = await import('@/modules/bom/application');
    const scopes = Object.keys(barrel).filter((name) => name.endsWith('RouteScope'));
    // T07-3 line create · T07-4 bulk-confirm · T07-5 clone 세 개뿐이다.
    expect(scopes.sort()).toEqual([
      'bomCloneRouteScope',
      'bomLineBulkConfirmRouteScope',
      'bomLineCreateRouteScope',
    ]);
    for (const forbidden of ['submit', 'approve', 'reject', 'activate', 'deactivate', 'archive']) {
      expect(scopes.join(' ').toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// route-policy (D-15) — T07-3 예약을 그대로 쓴다
// ═══════════════════════════════════════════════════════════════

describe('★★ route-policy — T07-3 예약 7건을 그대로 쓴다 (변경 0)', () => {
  const EXPECTED: [string, string][] = [
    ['submit', 'bom.submit'],
    ['approve', 'bom.approve'],
    ['reject', 'bom.approve'],
    ['activate', 'bom.approve'],
    ['deactivate', 'bom.approve'],
    ['archive', 'bom.approve'],
    ['clone', 'bom.create'],
  ];

  it.each(EXPECTED)('POST …/%s → %s', (suffix, permission) => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/${suffix}`, method: 'POST' })).toBe(
      permission,
    );
  });

  it('★★ 일반 `POST /api/boms`(bom.create)에 shadow 되지 않는다', () => {
    for (const [suffix, permission] of EXPECTED) {
      if (permission === 'bom.create') continue; // clone 은 원래 bom.create 다
      expect(
        resolveRoutePermission({ pathname: `/api/boms/${BOM}/${suffix}`, method: 'POST' }),
        suffix,
      ).not.toBe('bom.create');
    }
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'POST' })).toBe('bom.create');
  });

  it('★ submit 만 `bom.submit` 이고 나머지 workflow 는 `bom.approve` 다 (D-15)', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/submit`, method: 'POST' })).toBe(
      'bom.submit',
    );
    for (const suffix of ['approve', 'reject', 'activate', 'deactivate', 'archive']) {
      expect(
        resolveRoutePermission({ pathname: `/api/boms/${BOM}/${suffix}`, method: 'POST' }),
        suffix,
      ).toBe('bom.approve');
    }
  });

  it('기존 CRUD·line·bulk-confirm 정책이 회귀하지 않았다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}`, method: 'GET' })).toBe(
      'bom.read',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}`, method: 'PATCH' })).toBe(
      'bom.update',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines`, method: 'POST' })).toBe(
      'bom.update',
    );
    expect(
      resolveRoutePermission({
        pathname: `/api/boms/${BOM}/lines/bulk-confirm-qty`,
        method: 'POST',
      }),
    ).toBe('bom.update');
  });

  it('★ 새 permission key 를 발명하지 않았다', () => {
    const granted = EXPECTED.map(([, permission]) => permission);
    expect([...new Set(granted)].sort()).toEqual(['bom.approve', 'bom.create', 'bom.submit']);
    for (const invented of ['bom.activate', 'bom.reject', 'bom.archive', 'bom.clone']) {
      expect(granted, invented).not.toContain(invented);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// route handler 실재 — 정확히 7개 (§4)
// ═══════════════════════════════════════════════════════════════

describe('★ workflow route handler 는 정확히 7개다', () => {
  it('★ 7개가 모두 있고 금지 route 는 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../app/api/boms/[id]', import.meta.url));
    expect(readdirSync(dir).sort()).toEqual([
      'activate',
      'approve',
      'archive',
      'clone',
      // ✏️ T07-7B cost (workflow 가 아니라 read endpoint 다).
      'cost',
      'deactivate',
      // ✏️ T07-6 explode · T07-8 history (workflow 가 아니라 read endpoint 다).
      'explode',
      'history',
      'lines',
      'reject',
      'route.ts',
      'submit',
    ]);
    for (const forbidden of ['status', 'reactivate', 'unapprove', 'cancel', 'versions']) {
      expect(readdirSync(dir), forbidden).not.toContain(forbidden);
    }
  });

  it('⛔ max-assembly-qty·T07-8 route 는 여전히 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../app/api/boms/[id]', import.meta.url));
    // ✏️ `explode` 는 T07-6, `cost` 는 **T07-7B** 가 추가했다 — 위 목록도 그래서
    //    둘을 포함한다. `max-assembly-qty` 는 재고 코어(T2-*) 의존이라 여전히 유예다.
    for (const forbidden of ['max-assembly-qty', 'import', 'standard-cost']) {
      expect(readdirSync(dir), forbidden).not.toContain(forbidden);
    }
  });
});
