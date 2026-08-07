import { Prisma, type PrismaClient } from '@/generated/prisma/client';

import { getPrismaClient } from './prisma';

/**
 * 공통 트랜잭션 경계.
 *
 * 재고·발주·감사로그처럼 여러 테이블을 한 번에 바꾸는 작업은 반드시
 * 이 헬퍼를 통과한다. 각 유스케이스가 `prisma.$transaction` 을 직접 부르면
 * 옵션 기본값·오류 처리·클라이언트 주입 방식이 호출부마다 갈라진다.
 *
 * ## 자동 재시도가 없는 이유
 *
 * 직렬화 실패(40001)·데드락(40P01)은 재시도로 해소되는 경우가 많지만,
 * **이 계층에서 재시도하지 않는다.**
 *
 * `withTransaction` 의 재시도는 callback **전체**를 다시 실행한다. callback 안에
 * 외부 API 호출·파일 저장·메시지 발행처럼 롤백되지 않는 부작용이 하나라도 들어오면
 * 그 부작용이 중복 실행된다. DB 는 롤백되지만 이미 보낸 HTTP 요청은 되돌릴 수 없다.
 *
 * 재시도는 "무엇을 다시 해도 안전한가"를 아는 계층이 결정해야 한다.
 * 따라서 `SERIALIZATION_FAILURE` 변환과 Posting Service 의 재시도 정책은
 * 멱등성 정책과 함께 **R1a-2** 에서 구현한다.
 *
 * ## 트랜잭션 클라이언트와 루트 클라이언트
 *
 * callback 은 `TransactionClient` 를 받는다. 루트 `PrismaClient` 와 달리
 * `$transaction`·`$connect`·`$disconnect`·`$on`·`$use`·`$extends` 가 없다
 * (Prisma 의 `ITXClientDenyList`). 중첩 트랜잭션이나 커넥션 조작을 막기 위한
 * Prisma 의 설계이며, 타입 수준에서 걸러진다.
 *
 * ⚠️ callback 안에서 루트 클라이언트(`getPrismaClient()`)를 다시 부르면
 *    **트랜잭션 밖의 별도 커넥션**으로 나간다. 반드시 인자로 받은 `tx` 를 쓴다.
 *
 * ```ts
 * const result = await withTransaction(async (tx) => {
 *   const header = await tx.inventoryTransaction.create({ data });
 *   await tx.inventoryLedgerEntry.createMany({ data: entries });
 *   return header;
 * }, { isolationLevel: 'Serializable', timeout: 15_000 });
 * ```
 */

/** 트랜잭션 안에서만 쓰는 Prisma 클라이언트. 중첩 트랜잭션이 불가능하다. */
export type TransactionClient = Prisma.TransactionClient;

/** PostgreSQL 격리수준. */
export type TransactionIsolationLevel = Prisma.TransactionIsolationLevel;

export const TransactionIsolationLevel = Prisma.TransactionIsolationLevel;

export interface TransactionOptions {
  /**
   * 트랜잭션 슬롯을 기다리는 최대 시간(ms).
   * 미지정 시 Prisma 기본값(2000ms).
   */
  readonly maxWait?: number;
  /**
   * 트랜잭션 최대 실행 시간(ms). 초과하면 롤백된다.
   * 미지정 시 Prisma 기본값(5000ms).
   */
  readonly timeout?: number;
  /**
   * 격리수준. 미지정 시 DB 기본값(PostgreSQL 은 `ReadCommitted`).
   *
   * ⚠️ 재고 검증에 `Serializable` 을 쓰면 직렬화 실패가 늘어난다.
   *    행 잠금(`SELECT ... FOR UPDATE`)과의 선택은 R1a-2 에서 결정한다.
   */
  readonly isolationLevel?: TransactionIsolationLevel;
}

/**
 * Prisma 에 넘길 옵션 객체를 만든다.
 *
 * 지정된 키만 담는다. 아무것도 지정되지 않으면 `undefined` 를 돌려주어
 * Prisma·DB 기본값이 그대로 쓰이게 한다.
 */
function buildPrismaOptions(options: TransactionOptions):
  | {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: TransactionIsolationLevel;
    }
  | undefined {
  const result: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: TransactionIsolationLevel;
  } = {};

  if (options.maxWait !== undefined) result.maxWait = options.maxWait;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  if (options.isolationLevel !== undefined) result.isolationLevel = options.isolationLevel;

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 트랜잭션 안에서 callback 을 실행한다.
 *
 * - callback 이 정상 반환하면 **commit** 하고 반환값을 그대로 돌려준다.
 * - callback 이 예외를 던지면 **rollback** 하고 **원래 오류를 그대로 전파**한다.
 *   오류를 감싸거나 변환하지 않는다. 원인 타입(`AppError` 하위 클래스 등)이
 *   호출부의 `instanceof` 검사에 그대로 걸려야 하기 때문이다.
 * - callback 은 **정확히 한 번** 실행된다. 재시도하지 않는다.
 *
 * @param callback 트랜잭션 클라이언트를 받아 작업을 수행하는 함수
 * @param options  `maxWait` / `timeout` / `isolationLevel`. 미지정 키는 기본값.
 * @param client   사용할 PrismaClient. 기본값은 싱글턴이며,
 *                 테스트에서 대역을 주입할 때만 지정한다.
 */
export async function withTransaction<T>(
  callback: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
  client: PrismaClient = getPrismaClient(),
): Promise<T> {
  const prismaOptions = buildPrismaOptions(options);

  // 오류를 잡지 않는다. Prisma 가 롤백한 뒤 원래 오류를 그대로 던진다.
  // 여기서 try/catch 로 감싸면 스택과 cause 체인만 흐려진다.
  return prismaOptions === undefined
    ? client.$transaction(callback)
    : client.$transaction(callback, prismaOptions);
}
