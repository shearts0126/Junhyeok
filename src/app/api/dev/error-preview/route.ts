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
 * ⚠️ 운영환경에서는 404 를 반환한다. 오류 종류를 임의로 유발할 수 있는
 *    엔드포인트를 외부에 열어두지 않는다.
 *
 * 이 라우트는 T0-3 의 응답 포맷을 사람이 눈으로 확인하기 위한 것이며
 * 실제 검증은 단위·API 테스트가 담당한다.
 */
export const dynamic = 'force-dynamic';

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
      });

    case 'domain':
      return new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
        message: '가용재고 10, 요청 12 로 재고가 부족합니다.',
        details: { available: '10.000000', requestedNet: '12.000000', entryCount: 2 },
        hint: '동일 재고키의 2개 항목이 합산되어 검증되었습니다.',
        context: { skuId: 'internal-uuid', warehouseId: 'internal-uuid' },
      });

    case 'system':
      return new SystemError({
        message: 'connect ECONNREFUSED postgresql://postgres:pw@db.internal:5432/prod',
        context: { internalHost: 'db.internal' },
      });

    case 'unknown':
    default:
      // AppError 가 아닌 값도 SystemError 로 정규화되는지 확인한다.
      return new TypeError('Cannot read properties of undefined (reading "id")');
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env['NODE_ENV'] === 'production') {
    return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  }

  return withErrorHandling(
    request,
    async () => {
      const kind = new URL(request.url).searchParams.get('kind');
      throw buildError(kind);
    },
    { route: '/api/dev/error-preview' },
  );
}
