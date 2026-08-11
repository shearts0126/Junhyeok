import { z } from 'zod';

import { classifyExternalBarcode, normalizeExternalText } from './normalize';
import { externalSystemNotFound } from './refs';
import {
  createPrismaResolverPort,
  type ExternalMappingLookupRow,
  type ExternalMappingResolverPort,
} from './resolver-port';

/**
 * 외부 식별자 → 내부 SKU 해석 서비스 (T05-3).
 *
 * ⚠️ 근거: `docs/14_설계복구_ExternalMappingResolver.md`
 *    (2026-08-10 External Mapping Resolver Design Recovery Decision).
 *
 * ## 이것은 REST API 가 아니다
 *
 * V1 은 **internal application service** 다. `POST /api/external-mappings/resolve`
 * (`05_v0.2:125`)는 T05-3 V1 에서 supersede 되었다 — 라우트·권한·HTTP 계약을
 * 만들지 않는다. T17-2 같은 application layer 가 이 서비스를 직접 호출한다.
 *
 * ## 우선순위는 "낮은 신뢰도가 높은 신뢰도를 덮지 못한다"는 뜻이다
 *
 *   1. 코드 후보 조회 → 2. 바코드 후보 조회 → 3. 코드↔바코드 정합성 판정
 *   → 4. 확정되면 종료 → 5. 바코드 모호성이면 종료
 *   → 6. 여기까지 미확정일 때만 상품명 조회 → 7·8·9
 *
 * ★ 단순 SQL short-circuit(코드가 맞으면 바코드를 아예 조회하지 않음)을 쓰지
 *   않는다 — 그러면 `code → A, barcode → B` 인 데이터 품질 문제를 **조용히
 *   무시**하게 된다. 코드와 바코드는 항상 함께 평가한다.
 * ★ 반대로 **상품명은 상위 식별자와 충돌 판정을 하지 않는다.** 상품명은
 *   low-confidence fallback 이지 definitive identifier 가 아니다.
 *
 * ## 상품명만으로는 자동 반영하지 않는다 (TC-INV-026)
 *
 * 상품명으로 단일 SKU 를 찾아도 `autoApplicable = false`, `requiresReview = true`,
 * `resolutionStatus = 'REVIEW_REQUIRED'` 다. `matchedSkuId` 를 **후보로 돌려주는
 * 것은 허용**하지만, downstream 이 그것을 자동 원장 반영에 쓸 수 있는 확정
 * 매칭으로 취급해서는 안 된다.
 *
 * ## 순수 조회 서비스다
 *
 * ⛔ 어떤 쓰기도 하지 않는다 — 매핑·SKU·AuditLog·DataIssue·InventoryException·
 *    스냅샷·잔고·Posting 전부. 미매칭/모호/충돌의 **영속화 책임은 T17-2** 다.
 * ⛔ 멱등 인프라(Idempotency-Key·IdempotencyRecord·requestHash)를 쓰지 않는다.
 */

export interface ResolveExternalMappingInput {
  readonly externalSystemId: string;
  readonly externalProductCode?: string | null;
  readonly externalBarcode?: string | null;
  readonly externalProductName?: string | null;
}

export type ExternalMappingResolutionStatus =
  'MATCHED' | 'REVIEW_REQUIRED' | 'UNMATCHED' | 'AMBIGUOUS' | 'CONFLICT';

/**
 * ★ 정확히 4종이다 — `ExternalInventorySnapshotLine.match_method`(T17-1)의
 *   `CODE / BARCODE / NAME / UNMATCHED` 와 호환되어야 한다.
 * ⛔ `AMBIGUOUS`·`CONFLICT` 를 여기에 넣지 않는다. 그 둘은 transient
 *   `resolutionStatus` 로만 표현하며, 영속화 방법은 T17-1/T17-2 에서 정한다.
 */
export type ExternalMappingMatchMethod = 'CODE' | 'BARCODE' | 'NAME' | 'UNMATCHED';

export type ExternalMappingResolutionReason =
  | 'CODE_MATCH'
  | 'BARCODE_MATCH'
  | 'NAME_ONLY_REVIEW_REQUIRED'
  | 'BARCODE_AMBIGUOUS'
  | 'NAME_AMBIGUOUS'
  | 'IDENTIFIER_CONFLICT'
  | 'NO_MATCH'
  | 'INVALID_BARCODE';

export interface ResolveExternalMappingResult {
  readonly resolutionStatus: ExternalMappingResolutionStatus;
  readonly matchedSkuId: string | null;
  readonly matchMethod: ExternalMappingMatchMethod;
  /** true 여야만 downstream 이 자동 반영에 쓸 수 있다. 상품명 기반은 항상 false. */
  readonly autoApplicable: boolean;
  readonly requiresReview: boolean;
  /** distinct + 오름차순 고정 — DB 반환 순서에 결과가 좌우되지 않는다. */
  readonly candidateSkuIds: readonly string[];
  readonly reasonCode: ExternalMappingResolutionReason;
}

export interface ResolverDependencies {
  readonly port?: ExternalMappingResolverPort;
}

async function defaultPort(): Promise<ExternalMappingResolverPort> {
  const { getPrismaClient } = await import('@/shared/db');
  return createPrismaResolverPort(getPrismaClient());
}

/** 정규화된 조회 키. `null` 은 "그 단계 조회 없음"이다. */
interface CanonicalInput {
  readonly externalSystemId: string;
  readonly code: string | null;
  readonly barcode: string | null;
  /** 바코드 문자열이 있었지만 정규화로 유효한 조회값을 만들지 못했다. */
  readonly barcodeInvalid: boolean;
  readonly name: string | null;
}

const uuidSchema = z.uuid();

/**
 * 입력 정규화 — **T05-2 CRUD 가 쓰는 canonicalization 을 그대로 재사용**한다.
 *
 * ⛔ 새 규칙을 만들지 않는다: 대소문자 변환·대소문자 무시 비교·fuzzy·유사도·
 *    공백 collapse·문장부호 제거·한글/영문 정규화 전부 없다.
 */
function canonicalize(input: ResolveExternalMappingInput): CanonicalInput {
  const code = normalizeExternalText(input.externalProductCode ?? null) ?? null;
  const name = normalizeExternalText(input.externalProductName ?? null) ?? null;

  const classified = classifyExternalBarcode(input.externalBarcode ?? null);

  return {
    externalSystemId: input.externalSystemId,
    code,
    name,
    barcode: classified.kind === 'VALUE' ? classified.barcode : null,
    // ★ 오류를 던지지 않는다 — 잘못된 바코드 하나가 행 전체 해석을 막지 않는다.
    barcodeInvalid: classified.kind === 'INVALID',
  };
}

function sortedDistinct(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** `(systemId, value)` 짝이 정확히 일치하는 행의 SKU 집합. */
function skusFor(
  rows: readonly ExternalMappingLookupRow[],
  field: 'externalProductCode' | 'externalBarcode' | 'externalProductName',
  systemId: string,
  value: string | null,
): string[] {
  if (value === null) return [];
  return sortedDistinct(
    rows
      .filter((row) => row.externalSystemId === systemId && row[field] === value)
      .map((row) => row.skuId),
  );
}

const matched = (skuId: string, method: 'CODE' | 'BARCODE'): ResolveExternalMappingResult => ({
  resolutionStatus: 'MATCHED',
  matchedSkuId: skuId,
  matchMethod: method,
  autoApplicable: true,
  requiresReview: false,
  candidateSkuIds: [skuId],
  reasonCode: method === 'CODE' ? 'CODE_MATCH' : 'BARCODE_MATCH',
});

const notResolved = (
  resolutionStatus: 'UNMATCHED' | 'AMBIGUOUS' | 'CONFLICT',
  reasonCode: ExternalMappingResolutionReason,
  candidateSkuIds: readonly string[],
): ResolveExternalMappingResult => ({
  resolutionStatus,
  matchedSkuId: null,
  matchMethod: 'UNMATCHED',
  autoApplicable: false,
  requiresReview: true,
  candidateSkuIds,
  reasonCode,
});

/** 순수 판정 — 조회 결과만 받아 결정한다. DB 접근이 없다. */
function decide(
  canonical: CanonicalInput,
  codeRows: readonly ExternalMappingLookupRow[],
  barcodeRows: readonly ExternalMappingLookupRow[],
  nameRows: readonly ExternalMappingLookupRow[],
): ResolveExternalMappingResult {
  const systemId = canonical.externalSystemId;

  const codeSkus = skusFor(codeRows, 'externalProductCode', systemId, canonical.code);
  const barcodeSkus = skusFor(barcodeRows, 'externalBarcode', systemId, canonical.barcode);

  // ── ①②③ 코드·바코드를 함께 평가한다 ──────────────────────────
  if (codeSkus.length > 0) {
    const definitive = sortedDistinct([...codeSkus, ...barcodeSkus]);
    // 코드와 바코드가 같은 SKU 하나를 가리킨다(또는 바코드 미조회) → 코드가 우선.
    if (definitive.length === 1) return matched(definitive[0] as string, 'CODE');
    // 서로 다른 SKU 를 가리킨다 → 임의 선택하지 않는다.
    return notResolved('CONFLICT', 'IDENTIFIER_CONFLICT', definitive);
  }

  if (barcodeSkus.length === 1) return matched(barcodeSkus[0] as string, 'BARCODE');

  // ── ⑤ 바코드 모호 → 여기서 종료한다 (상품명으로 내려가지 않는다) ──
  if (barcodeSkus.length > 1) {
    return notResolved('AMBIGUOUS', 'BARCODE_AMBIGUOUS', barcodeSkus);
  }

  // ── ⑥ 여기까지 미확정일 때만 상품명 ───────────────────────────
  const nameSkus = skusFor(nameRows, 'externalProductName', systemId, canonical.name);

  if (nameSkus.length === 1) {
    // ★ TC-INV-026 — 단일 후보라도 자동 반영 대상이 아니다.
    return {
      resolutionStatus: 'REVIEW_REQUIRED',
      matchedSkuId: nameSkus[0] as string,
      matchMethod: 'NAME',
      autoApplicable: false,
      requiresReview: true,
      candidateSkuIds: nameSkus,
      reasonCode: 'NAME_ONLY_REVIEW_REQUIRED',
    };
  }

  if (nameSkus.length > 1) return notResolved('AMBIGUOUS', 'NAME_AMBIGUOUS', nameSkus);

  // ── ⑨ 아무것도 없음 ─────────────────────────────────────────
  return notResolved('UNMATCHED', canonical.barcodeInvalid ? 'INVALID_BARCODE' : 'NO_MATCH', []);
}

/**
 * 여러 외부 행을 한 번에 해석한다.
 *
 * ★ 반환 배열은 **입력 순서와 1:1** 이다.
 * ★ 조회 키를 dedupe 한 뒤 **kind 별 bulk 조회 1회씩**만 한다 —
 *   입력 수에 비례해 쿼리가 늘어나는 N+1 구현을 쓰지 않는다.
 *
 * @throws {DomainError} 404 — `externalSystemId` 가 UUID 가 아니거나 존재하지 않을 때.
 *   이것은 "매핑 없음"이 아니라 **잘못된 호출**이다.
 */
export async function resolveMany(
  inputs: readonly ResolveExternalMappingInput[],
  dependencies: ResolverDependencies = {},
): Promise<ResolveExternalMappingResult[]> {
  if (inputs.length === 0) return [];

  const port = dependencies.port ?? (await defaultPort());

  const canonicals = inputs.map(canonicalize);

  const systemIds = sortedDistinct(canonicals.map((row) => row.externalSystemId));
  for (const systemId of systemIds) {
    if (!uuidSchema.safeParse(systemId).success) throw externalSystemNotFound(systemId);
  }

  const existing = await port.findExistingSystemIds(systemIds);
  for (const systemId of systemIds) {
    if (!existing.has(systemId)) throw externalSystemNotFound(systemId);
  }

  const codes = sortedDistinct(canonicals.flatMap((row) => (row.code === null ? [] : [row.code])));
  const barcodes = sortedDistinct(
    canonicals.flatMap((row) => (row.barcode === null ? [] : [row.barcode])),
  );
  const names = sortedDistinct(canonicals.flatMap((row) => (row.name === null ? [] : [row.name])));

  const [codeRows, barcodeRows] = await Promise.all([
    port.findCurrentByCodes(systemIds, codes),
    port.findCurrentByBarcodes(systemIds, barcodes),
  ]);

  // ★ 상품명 단계는 상위 식별자로 확정되지 않은 입력이 하나라도 있을 때만 조회한다.
  //   (상품명 없이 판정했을 때 UNMATCHED 인 입력이 곧 상품명 단계가 필요한 입력이다.)
  const needsName = canonicals.some(
    (canonical) =>
      canonical.name !== null &&
      decide(canonical, codeRows, barcodeRows, []).resolutionStatus === 'UNMATCHED',
  );
  const nameRows = needsName ? await port.findCurrentByNames(systemIds, names) : [];

  return canonicals.map((canonical) => decide(canonical, codeRows, barcodeRows, nameRows));
}

/**
 * 외부 행 하나를 해석한다.
 *
 * ★ `resolveMany([input])[0]` 과 **완전히 동일한 결과**를 보장하기 위해 실제로
 *   그 경로를 그대로 쓴다 — 두 구현이 갈라질 여지를 만들지 않는다.
 */
export async function resolveOne(
  input: ResolveExternalMappingInput,
  dependencies: ResolverDependencies = {},
): Promise<ResolveExternalMappingResult> {
  const [result] = await resolveMany([input], dependencies);
  return result as ResolveExternalMappingResult;
}
