import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { businessDateOf } from '@/shared/business-date';
import { toDecimal, toDecimalString, type Decimal } from '@/shared/decimal';

import {
  assertQuantityConsistency,
  bomCycleDetected,
  bomMaxLevelExceeded,
  computeRawRequiredQty,
  toRequiredQtyString,
} from '../domain';

import { parseBomId, parseDateOnly, type ExplodeBomQuery } from './dto';
import { defaultBomClient, type BomReadDependencies } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { bomNotFound, type BomReadClient } from './refs';
import { resolveEffectiveBoms } from './resolve-effective-bom';
import { EXPLODE_LINE_INCLUDE, type ExplodeLineRow, type ExplodedNodeView } from './views';

/**
 * `GET /api/boms/{id}/explode` — 다단계 BOM 전개 (T07-6).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-18(전개 계약) · §D-19(수량 공식·정밀도)
 *    · §D-20(무합산) · §D-21(asOf) · §D-22(하위 resolver) · §D-13(순환·MAX_LEVEL)
 *    · §D-15(권한) · `★ T07-6 explosion quantity gap closure`(E-1 ~ E-7).
 *
 * ## root 는 **요청한 그 header** 다 — 재선택하지 않는다
 *
 * 같은 `parentSkuId` 에 asOf 기준 다른 `ACTIVE` 버전이 있어도 root 는 URL 이
 * 지정한 `bomId` 그대로다 (D-18 1행). `resolveEffectiveBom` 은 **하위 구성품에만**
 * 적용한다. 이 비대칭이 계약의 핵심이다 — "이 버전으로 만들면 무엇이 필요한가"
 * 를 묻는 질문이기 때문이다.
 *
 * ⛔ root 의 `status` 로 거르지 않는다 — docs/18 에 근거가 없다. `DRAFT` 도
 *    전개할 수 있으며, 그 경우 미확정 수량은 E-1·E-2 대로 `null` 이 된다.
 *
 * ## level·path
 *
 * root SKU 가 `0` 이고(D-13 `dfs(X.parentSkuId, 0)` 와 같은 원점) root 의 직접
 * 구성품이 `1` 이다. `path` 는 **조상 skuId 배열**(자기 제외)이므로 언제나
 * `path.length === level` 이다.
 *
 * ## ordering
 *
 * D-18: `level` asc → 같은 level 내 **부모의 `lineNo`** asc → `lineNo` asc.
 * 아래 BFS 는 level 별로 **직전 level 의 순서대로** 부모를 순회하고 각 부모의
 * 라인을 `lineNo` 오름차순으로 붙이므로, 결과는 `level` asc → **lineNo 경로
 * 사전순**이 된다. level 1·2 에서는 D-18 의 문구와 정확히 같고, level 3 이상은
 * 같은 규칙("부모의 lineNo")을 재귀적으로 적용한 **유일한 결정적 확장**이다.
 * ⛔ DB 의 자연 순서에 의존하지 않는다.
 *
 * ## 전역 visited 를 쓰지 않는다 (D-13 · D-20)
 *
 * 순환 판정은 **각 node 가 들고 있는 조상 경로**로만 한다. 다이아몬드에서
 * 두 번째 경로의 `D` 를 "이미 봤다"고 건너뛰면 D-20 의 경로별 detail 이
 * 사라지므로, `done` 류의 **traversal 가지치기를 결과 생성에 쓰지 않는다.**
 * 재사용하는 것은 **조회 결과(라인·resolver)뿐**이며 그것은 memoization 이지
 * dedupe 가 아니다.
 *
 * ## N+1 을 만들지 않는다
 *
 * level 당 쿼리는 **정확히 2회**다 — ① 그 level 부모들의 라인 batch 조회
 * (`bomHeaderId IN (...)`, header 계수 포함) ② 구성품들의 유효 BOM batch
 * 해석(`resolveEffectiveBoms`, `IN (...)` 1회). node 수와 무관하며 전체
 * 쿼리 수는 `1 + 2 × 실제 depth` 로 상한이 `maxLevel` 이다.
 *
 * ## read-only
 *
 * ⛔ write 0 · AuditLog 0 · 멱등 계약 없음 · advisory lock 없음 · row lock 없음.
 *    D-28 의 lock 은 **cycle graph 를 바꾸는 mutation** 을 위한 것이며 조회에
 *    관성적으로 복사하지 않는다.
 */

export interface ExplodeBomResult {
  readonly bomId: string;
  readonly parentSkuId: string;
  readonly asOf: string;
  readonly qty: string;
  readonly maxLevel: number;
  readonly nodes: readonly ExplodedNodeView[];
}

/** 한 header 를 전개하기 위한 작업 단위 — BFS frontier 의 원소. */
interface ExpansionTask {
  readonly bomHeaderId: string;
  /** 이 header 산출물의 필요 수량 `Q` (raw). `null` = 상위가 미상 (E-2). */
  readonly parentQty: Decimal | null;
  /** 이 header 의 라인들이 만들 node 의 `path` — 조상 skuId 배열. */
  readonly path: readonly string[];
}

export async function explodeBom(
  actor: ActorContext,
  rawBomId: string,
  query: ExplodeBomQuery,
  dependencies: BomReadDependencies = {},
): Promise<ExplodeBomResult> {
  // ⚠️ 2차 권한 가드 — proxy 통과를 신뢰하지 않는다. ⛔ ADMIN bypass 없음.
  //    ★ EXECUTIVE 도 `bom.read` 를 가지므로 통과한다 (D-15).
  assertPermission(actor, BOM_READ_PERMISSION);
  const bomId = parseBomId(rawBomId);

  // ★ asOf 는 **request 시작 시 한 번** 확정해 전 level 에 그대로 넘긴다 (D-21).
  //   ⛔ 재귀 도중에 오늘 날짜를 다시 읽지 않는다.
  const asOfLabel = query.asOf ?? businessDateOf(new Date());
  const asOf = parseDateOnly(asOfLabel);

  const db = dependencies.db ?? (await defaultBomClient());

  // root — 요청한 exact header. 없으면 404 (빈 배열로 위장하지 않는다).
  const root = await db.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, parentSkuId: true },
  });
  if (root === null) throw bomNotFound(bomId);

  const nodes: ExplodedNodeView[] = [];
  let frontier: ExpansionTask[] = [
    { bomHeaderId: root.id, parentQty: toDecimal(query.qty), path: [root.parentSkuId] },
  ];

  for (let level = 1; frontier.length > 0; level += 1) {
    // ── 쿼리 ① — 라인 batch + 순환·정합 판정.
    const pending = await collectLines(db, frontier);
    if (pending.length === 0) break;

    // ★ 깊이 판정은 **실제로 node 가 생길 때** 한다 (D-13 `level > maxLevel` 과
    //   같은 semantics — 노드 기준이다). 라인이 0건인 하위 BOM 은 위에서 이미
    //   끊겼으므로 깊이를 소비하지 않는다.
    //   ⛔ 조용히 절단하고 부분 배열을 돌려주지 않는다 — 요청 전체가 실패한다.
    //   ⚠️ 순환 판정이 `collectLines` 안에서 **먼저** 일어난다 — D-13 의
    //      `if (skuId in path)` 가 `if (level > MAX_LEVEL)` 보다 앞인 것과 같다.
    if (level > query.maxLevel) {
      const deepest = pending[0];
      throw bomMaxLevelExceeded(
        [...(deepest?.task.path ?? []), deepest?.row.componentSkuId ?? ''],
        query.maxLevel,
      );
    }

    // ── 쿼리 ② — 유효 하위 BOM batch 해석.
    const levelNodes = await resolveLevel(db, pending, level, asOf);
    nodes.push(...levelNodes.map((entry) => entry.node));
    // 하위 BOM 이 있는 node 만 다음 frontier 가 된다 — leaf 는 여기서 끝난다.
    frontier = levelNodes
      .filter((entry) => entry.node.bomHeaderId !== null)
      .map((entry) => ({
        bomHeaderId: entry.node.bomHeaderId as string,
        // ★ E-7 — public 6dp 문자열이 아니라 **raw Decimal** 을 넘긴다.
        parentQty: entry.rawRequiredQty,
        path: [...entry.node.path, entry.node.componentSkuId],
      }));
  }

  return {
    bomId: root.id,
    parentSkuId: root.parentSkuId,
    asOf: asOfLabel,
    qty: toDecimalString(toDecimal(query.qty)),
    maxLevel: query.maxLevel,
    nodes,
  };
}

/** node 와, **public DTO 에 넣지 않는** raw 수량을 함께 들고 다니는 내부 쌍. */
interface LevelEntry {
  readonly node: ExplodedNodeView;
  /** ⛔ 응답·DB 로 나가지 않는다 — 다음 level 의 `Q` 전용 (E-7). */
  readonly rawRequiredQty: Decimal | null;
}

/** 라인 + 그 라인이 만들 raw 수량. resolver 이전 단계의 중간 산물이다. */
interface PendingLine {
  readonly row: ExplodeLineRow;
  readonly task: ExpansionTask;
  readonly raw: Decimal | null;
}

/**
 * 쿼리 ① — 이 level 부모들의 라인을 **한 번에** 읽고, 순환·정합을 판정하고,
 * raw 수량을 계산한다. resolver 는 아직 부르지 않는다.
 *
 * ⛔ N+1 금지 — `bomHeaderId IN (...)` 한 번이며 header 계수도 같이 읽는다.
 */
async function collectLines(
  db: BomReadClient,
  frontier: readonly ExpansionTask[],
): Promise<PendingLine[]> {
  const headerIds = [...new Set(frontier.map((task) => task.bomHeaderId))];
  const rows = await db.bomLine.findMany({
    where: { bomHeaderId: { in: headerIds } },
    include: EXPLODE_LINE_INCLUDE,
    orderBy: [{ bomHeaderId: 'asc' }, { lineNo: 'asc' }],
  });
  if (rows.length === 0) return [];

  // ★ 같은 header 가 frontier 에 두 번 나올 수 있다(다이아몬드) — 조회 결과를
  //   재사용하는 것은 **memoization** 이지 traversal dedupe 가 아니다.
  const linesByHeader = new Map<string, ExplodeLineRow[]>();
  for (const row of rows) {
    const bucket = linesByHeader.get(row.bomHeaderId);
    if (bucket === undefined) linesByHeader.set(row.bomHeaderId, [row]);
    else bucket.push(row);
  }

  // frontier 순서 × lineNo 순서 = D-18 ordering.
  const pending: PendingLine[] = [];
  for (const task of frontier) {
    for (const row of linesByHeader.get(task.bomHeaderId) ?? []) {
      // ★ 순환은 **현재 경로**로만 판정한다 — 다이아몬드는 순환이 아니다 (D-13).
      const seen = task.path.indexOf(row.componentSkuId);
      if (seen >= 0) {
        throw bomCycleDetected([...task.path.slice(seen), row.componentSkuId]);
      }

      // ★ E-5 — 손상 상태는 완화하지 않는다. 정상 UNKNOWN 만 통과시킨다.
      const quantityPer = row.quantityPer === null ? null : toDecimalString(row.quantityPer);
      assertQuantityConsistency({ quantityPer, quantityStatus: row.quantityStatus });

      pending.push({
        row,
        task,
        raw: computeRawRequiredQty({
          parentQty: task.parentQty,
          outputQty: row.bomHeader.outputQty,
          quantityPer,
          lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
          overallLossRate:
            row.bomHeader.overallLossRate === null
              ? null
              : toDecimalString(row.bomHeader.overallLossRate),
          bomHeaderId: row.bomHeaderId,
          lineNo: row.lineNo,
        }),
      });
    }
  }
  return pending;
}

/**
 * 쿼리 ② — 이 level 구성품들의 asOf 유효 BOM 을 **한 번에** 해석해 node 를 만든다.
 *
 * 0건 = leaf(정상) · 1건 = 하위 전개 · 2건 이상 = 409 (resolver 가 던진다, D-22).
 */
async function resolveLevel(
  db: BomReadClient,
  pending: readonly PendingLine[],
  level: number,
  asOf: Date,
): Promise<LevelEntry[]> {
  const resolved = await resolveEffectiveBoms(db, {
    parentSkuIds: pending.map((item) => item.row.componentSkuId),
    asOf,
  });

  return pending.map(({ row, task, raw }) => {
    const childBom = resolved.get(row.componentSkuId) ?? null;
    return {
      rawRequiredQty: raw,
      node: {
        level,
        path: task.path,
        // 이 구성품을 전개한 하위 BOM. ★ leaf 판정과 같은 근거를 공유한다.
        bomHeaderId: childBom?.id ?? null,
        componentSkuId: row.componentSkuId,
        componentSku: {
          id: row.componentSku.id,
          skuCode: row.componentSku.skuCode,
          skuName: row.componentSku.skuName,
          baseUom: row.componentSku.baseUom,
        },
        componentRole: row.componentRole,
        quantityPer: row.quantityPer === null ? null : toDecimalString(row.quantityPer),
        lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
        // ★ E-6 — 6dp HALF_UP 후 minimal 문자열. trailing zero 를 채우지 않는다.
        requiredQty: toRequiredQtyString(raw),
        uom: row.uom,
        // ★ E-3 — 수량과 **독립**이다. 유효 ACTIVE BOM 유무만 본다.
        isLeaf: childBom === null,
        quantityStatus: row.quantityStatus,
      },
    };
  });
}
