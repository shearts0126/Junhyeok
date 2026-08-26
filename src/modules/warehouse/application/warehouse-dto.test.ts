import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

import { locationCodeDuplicate, translateLocationWriteError } from './constraint-errors';
import {
  DEFAULT_TIMEZONE,
  WAREHOUSE_TYPES,
  isReservedWarehouseInput,
  parseCreateLocationInput,
  parseCreateWarehouseInput,
  parseListWarehousesQuery,
  parseUpdateWarehouseInput,
} from './dto';
import { DEFAULT_LOCATION_CODE, IN_TRANSIT_WAREHOUSE_CODE, WAREHOUSE_PAGE_SIZE } from './policy';

/**
 * 창고 DTO 계약 단위 테스트 (T08-2) — DB 없이 검증 규칙만 본다.
 *
 * 근거: `docs/19_설계복구_Warehouse.md` §W-D24·§W-D25·§W-D26·§W-D27·§W-D30·
 *       §W-D33·§W-D9·§W-D12.
 */

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

const minimalCreate = {
  warehouseCode: 'WH-01',
  warehouseName: '테스트 창고',
  warehouseType: 'INTERNAL',
} as const;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
};

// ═══════════════════════════════════════════════════════════════
// W-D24 — CreateWarehouseDto
// ═══════════════════════════════════════════════════════════════

describe('W-D24. CreateWarehouseDto', () => {
  it('필수 3종만으로 통과하고 timezone 은 생략 가능하다', () => {
    const input = parseCreateWarehouseInput({ ...minimalCreate });
    expect(input.warehouseCode).toBe('WH-01');
    expect(input.timezone).toBeUndefined();
  });

  it('★ warehouseCode·warehouseName 은 trim 되지만 대소문자는 보존된다', () => {
    const input = parseCreateWarehouseInput({
      ...minimalCreate,
      warehouseCode: '  wh-lower  ',
      warehouseName: '  이름  ',
    });
    // ⛔ uppercase 강제 변환 없음 (§W-D24).
    expect(input.warehouseCode).toBe('wh-lower');
    expect(input.warehouseName).toBe('이름');
  });

  it('공백-only 는 400 이다', () => {
    for (const patch of [{ warehouseCode: '   ' }, { warehouseName: '  ' }]) {
      expect(codeOf(() => parseCreateWarehouseInput({ ...minimalCreate, ...patch }))).toBe(
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  });

  it('★ warehouseType 은 exact 6종이며 그 외는 400 이다', () => {
    expect([...WAREHOUSE_TYPES]).toEqual([
      'INTERNAL',
      'THREE_PL',
      'SUPPLIER_SITE',
      'OVERSEAS',
      'VIRTUAL',
      'IN_TRANSIT',
    ]);
    expect(
      codeOf(() => parseCreateWarehouseInput({ ...minimalCreate, warehouseType: 'DEPOT' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('★ timezone 의 explicit null 은 400 이다 (생략과 다르다)', () => {
    expect(codeOf(() => parseCreateWarehouseInput({ ...minimalCreate, timezone: null }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    // 값이 있으면 그대로 받는다 — ⛔ IANA 검증 라이브러리를 새로 넣지 않는다.
    expect(
      parseCreateWarehouseInput({ ...minimalCreate, timezone: 'America/Los_Angeles' }).timezone,
    ).toBe('America/Los_Angeles');
    expect(DEFAULT_TIMEZONE).toBe('Asia/Seoul');
  });

  it('⛔ server-owned 필드는 전부 400 이다', () => {
    for (const patch of [
      { id: VALID_UUID },
      { defaultLocationId: VALID_UUID },
      { active: true },
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(
        codeOf(() => parseCreateWarehouseInput({ ...minimalCreate, ...patch })),
        Object.keys(patch)[0],
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('externalSystemId·supplierId 는 UUID 이거나 null 이다', () => {
    expect(
      parseCreateWarehouseInput({ ...minimalCreate, externalSystemId: null }).externalSystemId,
    ).toBeNull();
    expect(codeOf(() => parseCreateWarehouseInput({ ...minimalCreate, supplierId: 'x' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// W-D12 — IN_TRANSIT 예약
// ═══════════════════════════════════════════════════════════════

describe('W-D12. IN_TRANSIT 는 public create 대상이 아니다', () => {
  it('★ 유형과 코드 둘 다 예약으로 판정된다', () => {
    expect(isReservedWarehouseInput({ warehouseCode: 'X', warehouseType: 'IN_TRANSIT' })).toBe(
      true,
    );
    expect(
      isReservedWarehouseInput({ warehouseCode: 'IN_TRANSIT', warehouseType: 'INTERNAL' }),
    ).toBe(true);
    // 소문자로 우회할 수 없다.
    expect(
      isReservedWarehouseInput({ warehouseCode: 'in_transit', warehouseType: 'INTERNAL' }),
    ).toBe(true);
    expect(isReservedWarehouseInput({ warehouseCode: 'OLPUN', warehouseType: 'THREE_PL' })).toBe(
      false,
    );
    expect(IN_TRANSIT_WAREHOUSE_CODE).toBe('IN_TRANSIT');
  });
});

// ═══════════════════════════════════════════════════════════════
// W-D25 · W-D26 · W-D27 — UpdateWarehouseDto
// ═══════════════════════════════════════════════════════════════

describe('W-D26. UpdateWarehouseDto', () => {
  it('편집 가능 5필드를 받는다', () => {
    const patch = parseUpdateWarehouseInput({
      warehouseName: '새 이름',
      externalSystemId: null,
      supplierId: VALID_UUID,
      timezone: 'Asia/Seoul',
      address: null,
    });
    expect(patch.warehouseName).toBe('새 이름');
    expect(patch.address).toBeNull();
  });

  it('★ {} 는 400 이다', () => {
    expect(codeOf(() => parseUpdateWarehouseInput({}))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('⛔ create-only immutable 은 400 이다 (§W-D25)', () => {
    expect(codeOf(() => parseUpdateWarehouseInput({ warehouseCode: 'NEW' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(codeOf(() => parseUpdateWarehouseInput({ warehouseType: 'VIRTUAL' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('★★ `active` 는 400 이다 — 조용히 무시하지 않는다 (§W-D27)', () => {
    // lifecycle 은 `T2-20` 이다. 재고 존재 시 비활성 차단이 없는 상태에서
    // active 를 열면 안전장치 없이 창고를 끌 수 있다.
    expect(codeOf(() => parseUpdateWarehouseInput({ active: false }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(codeOf(() => parseUpdateWarehouseInput({ warehouseName: 'A', active: true }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('⛔ defaultLocationId 는 400 이다', () => {
    expect(codeOf(() => parseUpdateWarehouseInput({ defaultLocationId: VALID_UUID }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('warehouseName·timezone 의 explicit null 은 400 이다 (DB NOT NULL)', () => {
    expect(codeOf(() => parseUpdateWarehouseInput({ warehouseName: null }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(codeOf(() => parseUpdateWarehouseInput({ timezone: null }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// W-D30 — list query
// ═══════════════════════════════════════════════════════════════

describe('W-D30. GET /api/warehouses query', () => {
  const q = (raw: string) => parseListWarehousesQuery(new URLSearchParams(raw));

  it('기본은 page 1 이고 필터가 없다', () => {
    const query = q('');
    expect(query.page).toBe(1);
    expect(query.warehouseType).toBeUndefined();
    // ★ active 필터가 undefined 다 — 자동으로 true 가 되지 않는다.
    expect(query.active).toBeUndefined();
  });

  it('warehouseType·active·page 를 받는다', () => {
    const query = q('warehouseType=THREE_PL&active=false&page=3');
    expect(query.warehouseType).toBe('THREE_PL');
    expect(query.active).toBe(false);
    expect(query.page).toBe(3);
  });

  it('⛔ q·sort·pageSize 는 400 이다 — 조용히 무시하지 않는다', () => {
    for (const raw of ['q=올펀', 'sort=warehouseName', 'pageSize=10', 'unknown=1']) {
      expect(
        codeOf(() => q(raw)),
        raw,
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('page 는 1 이상 정수다', () => {
    for (const raw of ['page=0', 'page=-1', 'page=abc']) {
      expect(
        codeOf(() => q(raw)),
        raw,
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('pageSize 는 서버 고정 50 이다', () => {
    expect(WAREHOUSE_PAGE_SIZE).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// W-D33 · W-D9 — CreateLocationDto
// ═══════════════════════════════════════════════════════════════

describe('W-D33. CreateLocationDto', () => {
  it('필수 2종 + optional locationType', () => {
    const input = parseCreateLocationInput({ locationCode: 'A-01', locationName: 'A 구역' });
    expect(input.locationCode).toBe('A-01');
    expect(input.locationType).toBeUndefined();
  });

  it('⛔ id·warehouseId·active 는 400 이다', () => {
    for (const patch of [{ id: VALID_UUID }, { warehouseId: VALID_UUID }, { active: true }]) {
      expect(
        codeOf(() =>
          parseCreateLocationInput({ locationCode: 'A-01', locationName: 'A', ...patch }),
        ),
        Object.keys(patch)[0],
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('★★ 예약어 DEFAULT 는 대소문자·공백을 무시하고 400 이다 (§W-D9)', () => {
    for (const code of ['DEFAULT', 'default', 'Default', '  DEFAULT  ', 'DeFaUlT']) {
      expect(
        codeOf(() => parseCreateLocationInput({ locationCode: code, locationName: 'x' })),
        code,
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(DEFAULT_LOCATION_CODE).toBe('DEFAULT');
  });

  it('★ 일반 코드의 대소문자는 보존된다 — a-01 을 A-01 로 바꾸지 않는다', () => {
    expect(
      parseCreateLocationInput({ locationCode: ' a-01 ', locationName: 'x' }).locationCode,
    ).toBe('a-01');
  });

  it('DEFAULT 를 포함하는 다른 코드는 허용된다', () => {
    expect(
      parseCreateLocationInput({ locationCode: 'DEFAULT-2', locationName: 'x' }).locationCode,
    ).toBe('DEFAULT-2');
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류코드 등록
// ═══════════════════════════════════════════════════════════════

/** `(warehouse_id, location_code)` UNIQUE 위반을 흉내낸 Prisma 오류. */
function locationUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['warehouse_id', 'location_code'] },
  });
}

describe('창고 오류코드', () => {
  it('★ 창고코드 중복은 409 다', () => {
    expect(httpStatusForCode(ERROR_CODES.WAREHOUSE_CODE_DUPLICATE)).toBe(409);
  });

  it('★★ 로케이션 코드 중복은 **generic CONFLICT(409)** 다 (§W-D34)', () => {
    const error = locationCodeDuplicate(VALID_UUID, 'A-01');

    expect(error.code).toBe(ERROR_CODES.CONFLICT);
    expect(httpStatusForCode(error.code)).toBe(409);
    // 어떤 중복인지는 code 가 아니라 publicDetails 로 구분한다.
    expect(error.publicDetails).toEqual({ warehouseId: VALID_UUID, locationCode: 'A-01' });
    expect(error.retryable).toBe(false);
  });

  it('⛔ 로케이션 전용 duplicate error code 를 만들지 않았다', () => {
    // ★ 금지된 이름을 이 파일에 literal 로 적지 않는다 — 저장소 전역 grep 이
    //   0건이어야 한다. 대신 **패턴**으로 재발을 막는다.
    const locationDuplicateCodes = Object.keys(ERROR_CODES).filter(
      (key) => key.includes('LOCATION') && key.includes('DUPLICATE'),
    );
    expect(locationDuplicateCodes).toEqual([]);
  });

  it('★★ P2002 를 번역해도 Prisma 원본이 응답에 새지 않는다', () => {
    let thrown: unknown;
    try {
      translateLocationWriteError(locationUniqueViolation(), VALID_UUID, 'A-01');
    } catch (error) {
      thrown = error;
    }

    const conflict = thrown as ReturnType<typeof locationCodeDuplicate>;
    expect(conflict.code).toBe(ERROR_CODES.CONFLICT);

    // 공개되는 문자열 어디에도 P2002·23505·제약 이름·컬럼명이 없다.
    const exposed = JSON.stringify({
      code: conflict.code,
      publicMessage: conflict.publicMessage,
      message: conflict.message,
      publicHint: conflict.publicHint,
      publicDetails: conflict.publicDetails,
    });
    for (const leak of ['P2002', '23505', 'warehouse_id', 'location_code', 'Unique constraint']) {
      expect(exposed, leak).not.toContain(leak);
    }
  });

  it('⛔ 로케이션과 무관한 P2002 는 삼키지 않는다 — 원본을 그대로 던진다', () => {
    const other = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['warehouse_code'] },
    });

    expect(() => translateLocationWriteError(other, VALID_UUID, 'A-01')).toThrow(other);
  });

  it('⛔ WAREHOUSE_NOT_FOUND runtime code 를 만들지 않았다', () => {
    // 존재하지 않는 창고는 generic NOT_FOUND(404) 다 — `productionPartnerNotFound`
    // 와 같은 방식. `docs/06` 의 동명 코드는 마이그레이션 DataIssue 이며 별개다.
    expect(Object.keys(ERROR_CODES)).not.toContain('WAREHOUSE_NOT_FOUND');
    expect(httpStatusForCode(ERROR_CODES.NOT_FOUND)).toBe(404);
  });
});
