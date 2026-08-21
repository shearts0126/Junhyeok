import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * SKU 상세 ⑦ BOM 탭 E2E (T1-6B5) — **read-only**.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-30.
 *
 * 픽스처(setup-db):
 *
 * ```
 *   ZZS-E2E-020 (완제품)  ── 상위 BOM 7건 — BomStatus 7종이 전부 렌더된다
 *        ZZB-5.0  REJECTED         [2034-01-01, ∞)            라인 0
 *        ZZB-4.0  PENDING_APPROVAL [2033-01-01, ∞)            라인 0
 *        ZZB-3.0  APPROVED         [2032-01-01, ∞)            라인 0
 *        ZZB-2.0  DRAFT            [2030-01-01, 2031-01-01)   라인 0
 *        ZZB-1.0  ACTIVE           [2020-01-01, ∞)            라인 3
 *        ZZB-0.9  ARCHIVED         [2019-01-01, 2020-01-01)   라인 1 (→ 022)
 *        ZZB-0.8  INACTIVE         [2018-01-01, 2019-01-01)   라인 0
 *   ZZS-E2E-021 (구성품)  ── ZZB-1.0 에 **두 번**(대체그룹 ZZG-A / ZZG-B)
 *                            + ZZB-SEMI-1.0 에 한 번  ⇒ where-used 3행
 *   ZZS-E2E-022 (반제품)  ── ZZB-1.0(UNKNOWN) + ZZB-0.9(ARCHIVED) 에 쓰이고
 *                            **자신도 상위 BOM** 을 갖는다  ⇒ where-used 2행
 * ```
 *
 * ⚠️ 정렬은 `effectiveFrom DESC` 다 (`list-boms.ts`). 위 표의 순서가 곧 화면
 *    순서이며, EXCLUDE 는 `ACTIVE` 에만 걸리므로 나머지 6건은 기간이 겹쳐도
 *    무방하다(그래도 읽기 쉽게 어긋나 있다).
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`bom.read`) → 화면 → API 2차 가드
 * (`bom.read`)까지 운영과 같은 경로다.
 *
 * ★ 핵심 검증 4가지
 *   ① 8탭 순서 — BOM 은 공급조건 뒤 · 변경이력 앞
 *   ② 두 섹션이 **서로 다른 질문**에 답한다 (상위 BOM ↔ 사용처)
 *   ③ 같은 BOM 이 대체그룹만 달리해 **두 행**으로 나온다 (dedup 금지)
 *   ④ **read-only** — mutation control 이 하나도 없다
 *
 * ⚠️ "탭 선택 후 권한 상실 → basic fallback" 은 여기 없다 — ⑥ 탭과 같은 이유로
 *    브라우저 세션에서 그 전이를 만들 수 없다. 규칙은 `detail-tabs.ts` 순수
 *    함수로 분리해 `bom-ui.test.ts` 가 고정한다.
 */

const [ADMIN, STAFF, FINANCE, , EXECUTIVE] = E2E_USERS;

const PARENT_SKU = 'ZZS-E2E-020';
const COMPONENT_SKU = 'ZZS-E2E-021';
const SEMI_SKU = 'ZZS-E2E-022';

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function openDetail(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/skus?q=${skuCode}`);
  await page.locator(`tr[data-sku="${skuCode}"]`).getByRole('link', { name: skuCode }).click();
  await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
}

async function openBomTab(page: Page, skuCode: string): Promise<void> {
  await openDetail(page, skuCode);
  await page.getByRole('tab', { name: 'BOM' }).click();
}

test.describe('SKU 상세 ⑦ BOM 탭 (ADMIN)', () => {
  test('★ 탭 위치 — 공급조건과 변경이력 사이이며 최종 8탭이다 (D-30)', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, PARENT_SKU);

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText([
      '기본정보',
      '코드·분류',
      '바코드',
      '외부시스템 매핑',
      '재고관리 설정',
      '공급조건',
      'BOM',
      '변경이력',
    ]);
  });

  test('★ 섹션 A — 이 SKU 의 BOM 7건, 상태·적용기간·확정 진행률', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    await expect(page.getByTestId('bom-tab-parent-table')).toBeVisible();
    const rows = page.locator('[data-testid="bom-tab-parent-row"]');
    await expect(rows).toHaveCount(7);

    // ★ 정렬은 effectiveFrom DESC — 미래 시작이 먼저다.
    await expect(page.locator('[data-testid="bom-tab-version"]')).toHaveText([
      'ZZB-5.0',
      'ZZB-4.0',
      'ZZB-3.0',
      'ZZB-2.0',
      'ZZB-1.0',
      'ZZB-0.9',
      'ZZB-0.8',
    ]);

    // DRAFT — 라인 0건, 종료일이 있는 기간.
    const draft = rows.nth(3);
    await expect(draft.getByTestId('bom-tab-status')).toHaveAttribute('data-status', 'DRAFT');
    await expect(draft.getByTestId('bom-tab-period')).toHaveText('2030-01-01 ~ 2031-01-01');
    await expect(draft.getByTestId('bom-tab-line-count')).toHaveText('0');

    // ACTIVE — 라인 3건, 무기한.
    const active = rows.nth(4);
    await expect(active.getByTestId('bom-tab-status')).toHaveAttribute('data-status', 'ACTIVE');
    await expect(active.getByTestId('bom-tab-period')).toHaveText('2020-01-01 ~ 무기한');
    await expect(active.getByTestId('bom-tab-line-count')).toHaveText('3');
  });

  // ── remediation R1 — BomStatus 7종이 전부 실제로 렌더된다 ──────
  test('★★ BomStatus 7종 exact key 가 모두 화면에 나온다 (D-6)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    const badges = page.locator(
      '[data-testid="bom-tab-parent-row"] [data-testid="bom-tab-status"]',
    );
    await expect(badges).toHaveCount(7);
    // ★ `data-status` 는 API enum key 원문이다 — 축약하지 않는다.
    const keys = await badges.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-status')),
    );
    expect([...keys].sort()).toEqual(
      [
        'ACTIVE',
        'APPROVED',
        'ARCHIVED',
        'DRAFT',
        'INACTIVE',
        'PENDING_APPROVAL',
        'REJECTED',
      ].sort(),
    );
    // ⛔ 축약형 `PENDING` 은 어디에도 없다.
    expect(keys).not.toContain('PENDING');

    // 라벨도 7종이 각각 다르게 나온다 — 병합 없음.
    await expect(badges).toHaveText([
      '반려',
      '승인대기',
      '승인됨',
      '작성중',
      '활성',
      '보관',
      '사용종료',
    ]);
  });

  test('★★ APPROVED 와 ACTIVE 는 다른 행으로 구분된다 (합치지 않는다)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    const approved = page.locator('[data-testid="bom-tab-parent-row"]', {
      has: page.locator('[data-status="APPROVED"]'),
    });
    const active = page.locator('[data-testid="bom-tab-parent-row"]', {
      has: page.locator('[data-status="ACTIVE"]'),
    });
    await expect(approved).toHaveCount(1);
    await expect(active).toHaveCount(1);
    await expect(approved.getByTestId('bom-tab-version')).toHaveText('ZZB-3.0');
    await expect(active.getByTestId('bom-tab-version')).toHaveText('ZZB-1.0');
    // ⛔ ACTIVE 를 "현재 적용중"으로 오역하지 않는다.
    await expect(active.getByTestId('bom-tab-status')).toHaveText('활성');
  });

  test('★★ where-used 는 ARCHIVED header 를 숨기지 않는다 (status 필터 없음)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, SEMI_SKU);

    const rows = page.locator('[data-testid="bom-tab-where-used-row"]');
    // ZZB-1.0(ACTIVE, UNKNOWN 라인) + ZZB-0.9(ARCHIVED, CONFIRMED 라인).
    await expect(rows).toHaveCount(2);

    const archived = rows.filter({ has: page.locator('[data-status="ARCHIVED"]') });
    await expect(archived).toHaveCount(1);
    await expect(archived.getByTestId('bom-tab-status')).toHaveText('보관');
    await expect(archived.getByTestId('bom-tab-quantity')).toHaveText('4 EA');
  });

  test('★★ 확정 진행률 — SUGGESTED 는 미확정에 포함된다 (확정 1 / 전체 3)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    const activeRow = page.locator('[data-testid="bom-tab-parent-row"]', {
      has: page.locator('[data-status="ACTIVE"]'),
    });
    const progress = activeRow.getByTestId('bom-tab-progress');
    // CONFIRMED 1 · SUGGESTED 1 · UNKNOWN 1 → 미확정 2, 확정 1.
    await expect(progress).toHaveAttribute('data-unconfirmed', '2');
    await expect(progress).toHaveText('확정 1 / 전체 3');
    // ⛔ "UNKNOWN 2건" 처럼 표시하지 않는다 — SUGGESTED 가 미입력으로 둔갑한다.
    await expect(progress).not.toContainText('UNKNOWN');
  });

  test('★★ 섹션 B — 같은 BOM 이 대체그룹만 달리해 두 행으로 나온다 (dedup 금지)', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    await expect(page.getByTestId('bom-tab-where-used-table')).toBeVisible();
    const rows = page.locator('[data-testid="bom-tab-where-used-row"]');
    // ZZB-1.0 에 2행(ZZG-A · ZZG-B) + ZZB-SEMI-1.0 에 1행.
    await expect(rows).toHaveCount(3);

    const groups = page.locator('[data-testid="bom-tab-alternate-group"]');
    await expect(groups).toHaveText(['ZZG-A', 'ZZG-B', '—']);
  });

  test('★ 소요량 — Decimal 문자열 그대로, UNKNOWN 은 `—` 이며 0 이 아니다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    const quantities = page.locator('[data-testid="bom-tab-quantity"]');
    // ★ API 가 Decimal 을 문자열로 직렬화하며 **후행 0 은 정규화**된다
    //   (`2.500000` → `2.5`). UI 는 받은 문자열을 **그대로** 쓰므로 화면도 `2.5` 다.
    await expect(quantities.nth(0)).toHaveText('2.5 EA');
    // ★ 정밀도는 보존된다 — 1/30 이 반올림되지 않는다.
    await expect(quantities.nth(1)).toHaveText('0.033333 EA');

    const statuses = page.locator('[data-testid="bom-tab-quantity-status"]');
    await expect(statuses.nth(0)).toHaveText('확정');
    await expect(statuses.nth(1)).toHaveText('추천');
  });

  test('★ UNKNOWN 라인은 소요량이 `—` 다 — 반제품 사용처에서 확인', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, SEMI_SKU);

    const rows = page.locator('[data-testid="bom-tab-where-used-row"]');
    // ZZB-1.0(2020, UNKNOWN) → ZZB-0.9(2019, CONFIRMED). 정렬은 effectiveFrom DESC.
    await expect(rows).toHaveCount(2);
    // ZZB-1.0 line 3 — UNKNOWN · SERVICE.
    await expect(rows.nth(0).getByTestId('bom-tab-quantity')).toHaveText('—');
    await expect(rows.nth(0).getByTestId('bom-tab-quantity-status')).toHaveText('미입력');
    // ⛔ `—` 는 0 이 아니다 — 같은 표의 CONFIRMED 행은 실제 수량을 보여준다.
    await expect(rows.nth(1).getByTestId('bom-tab-quantity')).toHaveText('4 EA');
  });

  test('★ 두 질문은 다르다 — 반제품은 상위 BOM 도 있고 사용처도 있다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, SEMI_SKU);

    // 상위: ZZB-SEMI-1.0 1건.
    await expect(page.locator('[data-testid="bom-tab-parent-row"]')).toHaveCount(1);
    // 사용처: ZZB-1.0 · ZZB-0.9 의 라인 2건.
    await expect(page.locator('[data-testid="bom-tab-where-used-row"]')).toHaveCount(2);
  });

  // ── remediation R2 — 열 이름은 실제 표시 필드와 일치한다 ────────
  test('★★ 표 열 이름 — "BOM 코드" 같은 없는 필드를 만들지 않는다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    // 섹션 A — 이미 이 SKU 의 상세 안이므로 상위 SKU 를 반복하지 않는다.
    await expect(page.locator('[data-testid="bom-tab-parent-table"] thead th')).toHaveText([
      '버전',
      '유형',
      '상태',
      '적용기간',
      '구성품 수',
      '소요량 확정',
      // ★ T07-8 이 `/master/boms/{id}` 를 만들면서 링크 열이 켜졌다
      //   (`BOM_TAB_MANAGE_LINK_ENABLED`). T1-6B5 때는 404 를 피하려고 꺼 뒀다.
      '관리',
    ]);

    await openBomTab(page, COMPONENT_SKU);
    // 섹션 B — 첫 열은 `parentSku.skuCode`/`skuName` 이므로 "상위 SKU" 다.
    await expect(page.locator('[data-testid="bom-tab-where-used-table"] thead th')).toHaveText([
      '상위 SKU',
      '버전',
      '상태',
      '적용기간',
      '순번',
      '소요량',
      '소요량 상태',
      '구성품 유형',
      '필수',
      '대체그룹',
      '관리',
    ]);

    // ⛔ `BomHeader` 에 없는 "BOM 코드" 가 화면 어디에도 없다.
    await expect(page.getByText('BOM 코드', { exact: false })).toHaveCount(0);
    // ⛔ 합성 식별자(`ZZS-E2E-020-ZZB-1.0` 류)를 만들지 않는다.
    await expect(page.getByText(`${PARENT_SKU}-ZZB`, { exact: false })).toHaveCount(0);
  });

  test('★ 섹션 B 의 "상위 SKU" 열은 parentSku 코드·명을 보여준다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    const first = page.locator('[data-testid="bom-tab-where-used-row"]').first();
    await expect(first).toContainText(PARENT_SKU);
    // uuid 를 코드처럼 노출하지 않는다 — `data-` 속성에만 있다.
    await expect(first.locator('td').first()).not.toHaveText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('★ 빈 상태 — 구성품 SKU 는 상위 BOM 이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    await expect(page.getByTestId('bom-tab-parent-empty')).toBeVisible();
    await expect(page.getByTestId('bom-tab-parent-table')).toHaveCount(0);
    // 반대편 섹션은 정상 렌더된다 — 한쪽 빈 상태가 다른 쪽을 가리지 않는다.
    await expect(page.getByTestId('bom-tab-where-used-table')).toBeVisible();
  });

  test('★★ read-only — mutation control 이 하나도 없다 (D-30)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    await expect(page.getByTestId('bom-tab-notice')).toBeVisible();

    // ⛔ BOM 생성·수정·라인 편집·소요량 확정·워크플로 버튼이 전부 없다.
    for (const name of [
      '신규',
      'BOM 생성',
      '라인 추가',
      '수정',
      '삭제',
      '저장',
      '승인 요청',
      '승인',
      '반려',
      '활성화',
      '사용종료',
      '복사',
      '일괄 확정',
      '전개',
      '원가',
    ]) {
      await expect(page.getByRole('button', { name }), name).toHaveCount(0);
    }
    // 페이지 이동 버튼 외에는 form control 이 없다(픽스처는 1페이지뿐).
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
  });

  test('★ T07-8 미착수 — 관리 링크를 렌더하지 않는다 (D-30 deferred rendering)', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    // `/master/boms` 는 T07-8 이 만든다 — 없는 화면으로 보내는 링크를 만들지 않는다.
    await expect(page.locator('a[href^="/master/boms"]')).toHaveCount(0);
    await expect(page.getByTestId('bom-tab-manage-link')).toHaveCount(0);
    // 토글이 꺼져 있으므로 "관리" 열 자체가 없다 (열 개수는 위 R2 테스트가 고정).
    await expect(
      page.locator('[data-testid="bom-tab-parent-table"] thead th', {
        hasText: '관리',
      }),
    ).toHaveCount(0);
  });
});

test.describe('권한 (T1-6B5 · D-15)', () => {
  test('★ EXECUTIVE — BOM 탭이 보인다 (⑥ 공급조건과 정반대)', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openDetail(page, PARENT_SKU);

    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
    // ⑥ 공급조건은 여전히 숨는다 — 두 탭의 권한 계약이 다르다.
    await expect(page.getByRole('tab', { name: '공급조건' })).toHaveCount(0);
  });

  test('★ EXECUTIVE 도 BOM 내용을 읽는다', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openBomTab(page, PARENT_SKU);
    await expect(page.locator('[data-testid="bom-tab-parent-row"]')).toHaveCount(7);
  });

  // ── remediation R3 — 탭이 선택되지 않으면 자식 API 를 부르지 않는다 ──
  //
  // ⚠️ 시드 5역할이 **전부** `bom.read` 를 가지므로(D-15) "권한 없는 역할"로는
  //    이 경로를 재현할 수 없다. 권한 상실 → `basic` fallback 자체는
  //    `detail-tabs.ts` 순수 함수로 `bom-ui.test.ts` 가 고정한다.
  //    여기서는 그 fallback 이 실제로 막아주는 것 — **`BomTab` 미마운트 =
  //    자식 fetch 0** — 을 브라우저에서 확인한다.
  test('★★ BOM 탭을 열기 전에는 두 API 를 한 번도 부르지 않는다', async ({ page }) => {
    await login(page, ADMIN);

    const bomCalls: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname + new URL(request.url()).search;
      if (path.startsWith('/api/boms') || path.includes('/where-used')) bomCalls.push(path);
    });

    // 상세를 열고 다른 탭까지 둘러본다 — BOM 탭만 누르지 않는다.
    await openDetail(page, PARENT_SKU);
    await page.getByRole('tab', { name: '바코드' }).click();
    await expect(page.getByRole('tab', { name: 'BOM' })).toBeVisible();
    expect(bomCalls, bomCalls.join(' · ')).toHaveLength(0);

    // 탭을 누른 뒤에야 두 요청이 나간다.
    //
    // ⚠️ 횟수를 **1 로 고정하지 않는다** — E2E 는 `next dev` 를 쓰고 React
    //    StrictMode 가 effect 를 의도적으로 두 번 실행한다(실측 2회). 이 테스트가
    //    고정하려는 계약은 "탭을 열기 전 0" 이고, 그 뒤 몇 번인지는 dev/prod
    //    렌더 모드에 달린 값이라 여기서 못 박으면 계약이 아니라 환경을 고정한다.
    await page.getByRole('tab', { name: 'BOM' }).click();
    await expect(page.getByTestId('bom-tab-parent-table')).toBeVisible();
    await expect(page.getByTestId('bom-tab-where-used-heading')).toBeVisible();
    expect(bomCalls.filter((path) => path.startsWith('/api/boms')).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(bomCalls.filter((path) => path.includes('/where-used')).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test('FINANCE — BOM 탭이 보인다 (read 전용)', async ({ page }) => {
    await login(page, FINANCE);
    await openDetail(page, PARENT_SKU);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
  });

  test('SCM_STAFF — BOM 탭이 보인다', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, PARENT_SKU);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
  });
});

test.describe('등록 화면 (D-30)', () => {
  test('★ /master/skus/new 는 3탭 그대로 — BOM 탭이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['기본정보', '코드·분류', '재고관리 설정']);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(0);
  });
});

test.describe('standalone BOM 화면 (T07-8 착지)', () => {
  test('★ `/master/boms` 가 열린다 — 더 이상 404 가 아니다', async ({ page }) => {
    // T1-6B5 시점에는 route handler 가 없어 404 였다. T07-8 이 그 소유자이며
    // 이제 실제 화면이 응답한다. 상세 시나리오는 `boms-manage.e2e.ts` 가 본다.
    await login(page, ADMIN);
    const response = await page.goto('/master/boms');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'BOM 관리' })).toBeVisible();
  });
});
