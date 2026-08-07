import { NextResponse } from 'next/server';

import {
  AuthorizationError,
  ConflictError,
  DomainError,
  ERROR_CODES,
  SystemError,
  ValidationError,
  withErrorHandling,
} from '@/shared/errors';

/**
 * 오류 응답 포맷 확인용 라우트 (개발 전용).
 *
 * `GET /api/dev/error-preview?kind=domain`
 *
 * ⚠️ **두 조건을 모두 만족할 때만 동작한다.**
 *    1. `NODE_ENV !== 'production'`
 *    2. `ENABLE_ERROR_PREVIEW === 'true'`
 *
 *    기본값은 비활성화다. 오류를 임의로 유발할 수 있는 엔드포인트는
 *    환경 판정 하나에만 의존해서는 안 된다. 스테이징·프리뷰 배포처럼
 *    `NODE_ENV` 가 production 이 아닌 환경도 외부에 노출될 수 있다.
 *    비활성 상태에서는 JSON 404 를 반환한다(HTML 404 가 아니라).
 *
 * 이 라우트는 T0-3 의 응답 포맷을 사람이 눈으로 확인하기 위한 것이며
 * 실제 검증은 단위·API 테스트가 담당한다.
 */
export const dynamic = 'force-dynamic';

function isPreviewEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' && process.env['ENABLE_ERROR_PREVIEW'] === 'true';
}

function buildError(kind: string | null): unknown {
  switch (kind) {
    case 'validation':
      return new ValidationError(
        [
          { path: 'skuCode', message: '필수 항목입니다.' },
          { path: 'entries.0.quantityDelta', message: '0 이 될 수 없습니다.' },
        ],
        { message: '요청 본문 검증에 실패했습니다.' },
      );

    case 'authorization':
      return new AuthorizationError(ERROR_CODES.FORBIDDEN, {
        message: 'sku.approve 권한이 없습니다.',
        context: { requiredPermission: 'sku.approve' },
      });

    case 'conflict':
      return new ConflictError(ERROR_CODES.SERIALIZATION_FAILURE, {
        message: '동일 재고키에 동시 접근이 발생했습니다.',
        retryable: true,
        publicHint: '잠시 후 다시 시도하세요.',
      });

    case 'domain':
      return new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
        message: '가용재고 10, 요청 12 로 재고가 부족합니다.',
        // 공개 — 사용자가 조치할 수 있는 값
        publicDetails: { available: '10.000000', requestedNet: '12.000000', entryCount: 2 },
        publicHint: '동일 재고키의 2개 항목이 합산되어 검증되었습니다.',
        // 로그 전용 — 내부 식별자·연결 정보
        details: { internalSkuId: 'uuid-sku-1', databaseUrl: 'postgresql://u:pw@db.internal/prod' },
        context: { skuId: 'internal-uuid', warehouseId: 'internal-uuid' },
      });

    case 'system':
      return new SystemError({
        message: 'connect ECONNREFUSED postgresql://postgres:pw@db.internal:5432/prod',
        // 예상하지 못한 오류에는 publicDetails 를 넘겨도 응답에 실리지 않는다.
        publicDetails: { shouldNotAppear: 'leaked' },
        context: { internalHost: 'db.internal', authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x' },
      });

    case 'unknown':
    default:
      // AppError 가 아닌 값도 SystemError 로 정규화되는지 확인한다.
      return new TypeError('Cannot read properties of undefined (reading "id")');
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async () => {
      // 비활성 상태의 404 도 공통 오류 응답 규약을 따른다.
      // 직접 NextResponse.json 을 만들면 requestId·x-request-id 헤더가 빠져
      // "모든 공통 오류 응답에 request ID 포함" 조건이 이 경로에서만 깨진다.
      if (!isPreviewEnabled()) {
        throw new DomainError(ERROR_CODES.NOT_FOUND, {
          message: '오류 미리보기 라우트가 비활성화되어 있습니다.',
          context: {
            reason:
              process.env['NODE_ENV'] === 'production'
                ? 'NODE_ENV=production'
                : 'ENABLE_ERROR_PREVIEW!=true',
          },
        });
      }

      const kind = new URL(request.url).searchParams.get('kind');
      throw buildError(kind);
    },
    { route: '/api/dev/error-preview' },
  );
}
