/**
 * 코드사전 시드 데이터 (T0-8) — **원본 엑셀에서 기계 추출한 값이다.**
 *
 * 출처
 *   - `DEEPPOINT_SKU_MASTER_260729.xlsx` — 브랜드·대분류·소분류·부자재분류·보관처
 *   - `S&OP 2026.01ing_260729.xlsx` `구분` 시트 — 채널 16종
 *
 * ⚠️ 이 파일의 값을 손으로 "정리"하지 않는다. 원본의 오탈자(예: 대분류 SL 의
 *    영문명 `Styiling`)도 그대로 둔다 — 코드사전의 기준은 원본이고, 보정은
 *    원본 소유자의 확인을 거쳐 별도 변경으로 처리한다.
 *
 * ## 수량 기준 — 원본 행과 고유 코드를 구분한다
 *
 *   | 기준 | 수량 |
 *   |---|---|
 *   | 원본 코드사전 행 | **99행** (2+12+19+39+11+16) |
 *   | natural key(`group`, `code`) 기준 고유 코드 | **98코드** |
 *   | 실제 seed | **98코드** (BRAND 2 · MAJOR_CATEGORY 12 · MINOR_CATEGORY 19 · MATERIAL_CATEGORY 38 · STORAGE_LOCATION 11 · CHANNEL 16) |
 *
 *   행과 코드가 1 차이 나는 이유: 부자재분류 `ET`(Etc/기타)가 **원본 순번 24
 *   (전용 부자재 블록)와 순번 30(센터용 블록)에 2회 등장**한다. `common_code` 는
 *   `UNIQUE(group_id, code)` 이므로 `ET` 는 **정확히 1건**만 시드하고, 제외된
 *   순번 30은 결번으로 남겨 원본 순서를 보존한다.
 *   ⛔ 수를 맞추기 위한 `ET2` 같은 임의 코드는 만들지 않는다.
 *
 * ## 종전 "100건" 표기의 오류 원인 (문서 정오 — 01_AS-IS §1.6)
 *
 *   1. 대분류 12개를 **13개로 오기**했다 (초기 분석 문서의 집계 오기)
 *   2. MATERIAL_CATEGORY 의 `ET` 2행을 **각각 집계**해 39로 세었다
 *
 *   100 = 99행 + 대분류 오기 1. 실제 기준값은 위 표와 같다.
 *
 * ## 기타 원본 이상값 (보정하지 않고 그대로 시드)
 *
 *   - 대분류 `SL` 의 영문명이 `Styiling` — 원본 오탈자 그대로
 *   - 보관처 `BOC` 와 `BON` 의 명칭이 동일하다(본코스메틱) — 중복 의심값
 *   - 채널 원본 `A. 자사몰` 은 코드 `A` / 명칭 `자사몰` 로 분리하되 원문을
 *     `attributes.rawLabel` 에 보존한다
 *   - 대분류에 채널성 코드(OY·DS·MS)가 섞여 있다 → `attributes.isChannelCategory: true`
 *     로 표시만 한다 (설계 01_AS-IS §5.2 확정 사항)
 *
 * ## 계층
 *
 *   원본 사전에는 그룹 간 계층이 없다. 소분류 8종(TN·TT·CW·ES·ET·SP·HT·MN)이
 *   서로 다른 대분류 아래에서 사용됨을 SKU 데이터로 확인했다. 따라서 6개 그룹
 *   모두 `parentGroupCode: null` 이고 코드의 `parentCode` 도 전부 null 이다.
 *   임의로 계층을 추론해 넣지 않는다.
 */

export interface CommonCodeGroupSeed {
  readonly groupCode: string;
  readonly groupName: string;
  readonly description: string;
  /** 부모 그룹 groupCode. T0-8 시드는 전부 null. */
  readonly parentGroupCode: string | null;
  readonly sortOrder: number;
}

export interface CommonCodeSeed {
  readonly code: string;
  readonly name: string;
  /** `{ groupCode, code }` 로 지정한다. T0-8 시드는 전부 null. */
  readonly parent: { readonly groupCode: string; readonly code: string } | null;
  readonly sortOrder: number;
  readonly attributes: Record<string, unknown> | null;
}

export const COMMON_CODE_GROUP_SEED: readonly CommonCodeGroupSeed[] = [
  {
    groupCode: 'BRAND',
    groupName: '브랜드',
    description: 'SKU MASTER_본품 좌측 코드사전 (r5~r6)',
    parentGroupCode: null,
    sortOrder: 1,
  },
  {
    groupCode: 'MAJOR_CATEGORY',
    groupName: '대분류',
    description: 'SKU MASTER_본품 좌측 코드사전 (r5~r16)',
    parentGroupCode: null,
    sortOrder: 2,
  },
  {
    groupCode: 'MINOR_CATEGORY',
    groupName: '소분류',
    description: 'SKU MASTER_본품 좌측 코드사전 (r5~r23)',
    parentGroupCode: null,
    sortOrder: 3,
  },
  {
    groupCode: 'MATERIAL_CATEGORY',
    groupName: '부자재분류',
    description: 'SKU MASTER_부자재 등 좌측 코드사전 (r5~r43, ET 중복 1건 제외)',
    parentGroupCode: null,
    sortOrder: 4,
  },
  {
    groupCode: 'STORAGE_LOCATION',
    groupName: '보관처',
    description: 'SKU MASTER_부자재 등 보관처 축약코드 (r47~r57)',
    parentGroupCode: null,
    sortOrder: 5,
  },
  {
    groupCode: 'CHANNEL',
    groupName: '채널',
    description: "S&OP '구분' 시트 채널 마스터 (r4~r19)",
    parentGroupCode: null,
    sortOrder: 6,
  },
];

/** 그룹별 코드. 원본 등장 순서를 sortOrder 로 보존한다. */
export const COMMON_CODE_SEED: Readonly<Record<string, readonly CommonCodeSeed[]>> = {
  BRAND: [
    { code: 'FB', name: '포뷰트', parent: null, sortOrder: 1, attributes: null },
    { code: 'BO', name: '바디오라', parent: null, sortOrder: 2, attributes: null },
  ],
  MAJOR_CATEGORY: [
    { code: 'DV', name: '디바이스', parent: null, sortOrder: 1, attributes: { nameEn: 'Device' } },
    { code: 'TL', name: '툴', parent: null, sortOrder: 2, attributes: { nameEn: 'Tool' } },
    {
      code: 'SL',
      name: '스타일링',
      parent: null,
      sortOrder: 3,
      attributes: { nameEn: 'Styiling' },
    },
    {
      code: 'HC',
      name: '헤어케어',
      parent: null,
      sortOrder: 4,
      attributes: { nameEn: 'Hair Care' },
    },
    { code: 'CV', name: '커버', parent: null, sortOrder: 5, attributes: { nameEn: 'Cover' } },
    { code: 'BT', name: '뷰티', parent: null, sortOrder: 6, attributes: { nameEn: 'Beauty' } },
    { code: 'ET', name: '기타', parent: null, sortOrder: 7, attributes: { nameEn: 'Etc' } },
    { code: 'ST', name: '세트', parent: null, sortOrder: 8, attributes: { nameEn: 'Set' } },
    {
      code: 'GB',
      name: '증정박스',
      parent: null,
      sortOrder: 9,
      attributes: { nameEn: 'Gift Box' },
    },
    {
      code: 'OY',
      name: '올리브영',
      parent: null,
      sortOrder: 10,
      attributes: { nameEn: 'Olive Young', isChannelCategory: true },
    },
    {
      code: 'DS',
      name: '다이소',
      parent: null,
      sortOrder: 11,
      attributes: { nameEn: 'Daiso', isChannelCategory: true },
    },
    {
      code: 'MS',
      name: '무신사',
      parent: null,
      sortOrder: 12,
      attributes: { nameEn: 'Musinsa', isChannelCategory: true },
    },
  ],
  MINOR_CATEGORY: [
    { code: 'IR', name: '고데기', parent: null, sortOrder: 1, attributes: { nameEn: 'Iron' } },
    { code: 'DR', name: '드라이어', parent: null, sortOrder: 2, attributes: { nameEn: 'Dryer' } },
    {
      code: 'HT',
      name: '브러쉬/핀처/드롭셋',
      parent: null,
      sortOrder: 3,
      attributes: { nameEn: 'Hair Tool' },
    },
    {
      code: 'CW',
      name: '크림/왁스/포마드',
      parent: null,
      sortOrder: 4,
      attributes: { nameEn: 'Cream & Wax' },
    },
    { code: 'SP', name: '스프레이', parent: null, sortOrder: 5, attributes: { nameEn: 'Spray' } },
    {
      code: 'ES',
      name: '오일/토닉/에센스/앰플',
      parent: null,
      sortOrder: 6,
      attributes: { nameEn: 'Essence' },
    },
    {
      code: 'SH',
      name: '샴푸/스케일러',
      parent: null,
      sortOrder: 7,
      attributes: { nameEn: 'Shampoo' },
    },
    {
      code: 'TR',
      name: '트리트먼트',
      parent: null,
      sortOrder: 8,
      attributes: { nameEn: 'Treatment' },
    },
    {
      code: 'TT',
      name: '헤어타투/두피타투',
      parent: null,
      sortOrder: 9,
      attributes: { nameEn: 'Tattoo' },
    },
    { code: 'TN', name: '태닝', parent: null, sortOrder: 10, attributes: { nameEn: 'Tanning' } },
    { code: 'TU', name: '톤업', parent: null, sortOrder: 11, attributes: { nameEn: 'Tone Up' } },
    {
      code: 'BM',
      name: '바디미스트',
      parent: null,
      sortOrder: 12,
      attributes: { nameEn: 'Body Mist' },
    },
    {
      code: 'AP',
      name: '어플리케이터',
      parent: null,
      sortOrder: 13,
      attributes: { nameEn: 'Applicator' },
    },
    { code: 'MN', name: '미니', parent: null, sortOrder: 14, attributes: { nameEn: 'Mini' } },
    { code: 'SC', name: '샤셰', parent: null, sortOrder: 15, attributes: { nameEn: 'Sachet' } },
    { code: 'RF', name: '리필', parent: null, sortOrder: 16, attributes: { nameEn: 'Refill' } },
    {
      code: 'PC',
      name: '선케어/립케어/핸드케어',
      parent: null,
      sortOrder: 17,
      attributes: { nameEn: 'Personal Care' },
    },
    {
      code: 'MG',
      name: '마사지기',
      parent: null,
      sortOrder: 18,
      attributes: { nameEn: 'Massager' },
    },
    { code: 'ET', name: '기타', parent: null, sortOrder: 19, attributes: { nameEn: 'Etc' } },
  ],
  MATERIAL_CATEGORY: [
    {
      code: 'MC',
      name: '제조원가',
      parent: null,
      sortOrder: 1,
      attributes: { nameEn: 'Manufacturing Cost', serialFormat: '01~' },
    },
    { code: 'BX', name: '단상자', parent: null, sortOrder: 2, attributes: { nameEn: 'Box' } },
    { code: 'IB', name: '인박스', parent: null, sortOrder: 3, attributes: { nameEn: 'Inner Box' } },
    { code: 'OB', name: '대박스', parent: null, sortOrder: 4, attributes: { nameEn: 'Outer Box' } },
    { code: 'IN', name: '인서트', parent: null, sortOrder: 5, attributes: { nameEn: 'Insert' } },
    { code: 'LB', name: '일반라벨', parent: null, sortOrder: 6, attributes: { nameEn: 'Label' } },
    {
      code: 'SL',
      name: '봉합라벨',
      parent: null,
      sortOrder: 7,
      attributes: { nameEn: 'Sealing Label' },
    },
    { code: 'BT', name: '용기류', parent: null, sortOrder: 8, attributes: { nameEn: 'Bottle' } },
    { code: 'TB', name: '튜브', parent: null, sortOrder: 9, attributes: { nameEn: 'Tube' } },
    { code: 'CP', name: '캡', parent: null, sortOrder: 10, attributes: { nameEn: 'Cap' } },
    { code: 'PP', name: '펌프', parent: null, sortOrder: 11, attributes: { nameEn: 'Pump' } },
    {
      code: 'SP',
      name: '스포이드',
      parent: null,
      sortOrder: 12,
      attributes: { nameEn: 'Dropper' },
    },
    { code: 'PK', name: '박킹', parent: null, sortOrder: 13, attributes: { nameEn: 'Packing' } },
    {
      code: 'RF',
      name: '리필파우치',
      parent: null,
      sortOrder: 14,
      attributes: { nameEn: 'Refill Pouch' },
    },
    {
      code: 'ZB',
      name: '지퍼백',
      parent: null,
      sortOrder: 15,
      attributes: { nameEn: 'Zipper Bag' },
    },
    {
      code: 'SF',
      name: '수축필름',
      parent: null,
      sortOrder: 16,
      attributes: { nameEn: 'Shrink Film' },
    },
    {
      code: 'MN',
      name: '설명서/매뉴얼',
      parent: null,
      sortOrder: 17,
      attributes: { nameEn: 'Manual' },
    },
    {
      code: 'CH',
      name: '충전선',
      parent: null,
      sortOrder: 18,
      attributes: { nameEn: 'Charger Cable' },
    },
    { code: 'TL', name: '도구류', parent: null, sortOrder: 19, attributes: { nameEn: 'Tool' } },
    {
      code: 'HD',
      name: '부품/하드웨어',
      parent: null,
      sortOrder: 20,
      attributes: { nameEn: 'Hardware' },
    },
    {
      code: 'BK',
      name: '반제품 (벌크)',
      parent: null,
      sortOrder: 21,
      attributes: { nameEn: 'Bulk' },
    },
    { code: 'MD', name: '금형비', parent: null, sortOrder: 22, attributes: { nameEn: 'Mold' } },
    {
      code: 'RM',
      name: '원료',
      parent: null,
      sortOrder: 23,
      attributes: { nameEn: 'Raw Material' },
    },
    { code: 'ET', name: '기타', parent: null, sortOrder: 24, attributes: { nameEn: 'Etc' } },
    {
      code: 'CT',
      name: '센터용',
      parent: null,
      sortOrder: 25,
      attributes: { nameEn: 'Center', serialFormat: '001~' },
    },
    {
      code: 'SB',
      name: '쇼핑백',
      parent: null,
      sortOrder: 26,
      attributes: { nameEn: 'Shopping Bag' },
    },
    {
      code: 'DP',
      name: '집기/거치대/매대',
      parent: null,
      sortOrder: 27,
      attributes: { nameEn: 'Display' },
    },
    {
      code: 'PM',
      name: '판촉/홍보물',
      parent: null,
      sortOrder: 28,
      attributes: { nameEn: 'Promotional Material' },
    },
    {
      code: 'PG',
      name: '패키지/포장재',
      parent: null,
      sortOrder: 29,
      attributes: { nameEn: 'Package' },
    },
    {
      code: 'CM',
      name: '공용 부자재',
      parent: null,
      sortOrder: 31,
      attributes: { nameEn: 'Common', serialFormat: '001~' },
    },
    { code: 'FC', name: '충진', parent: null, sortOrder: 32, attributes: { nameEn: 'Filling' } },
    {
      code: 'FP',
      name: '충진 및 포장',
      parent: null,
      sortOrder: 33,
      attributes: { nameEn: 'Filling & Packaging' },
    },
    {
      code: 'SV',
      name: '가공/작업/조립/포장',
      parent: null,
      sortOrder: 34,
      attributes: { nameEn: 'Processing Service' },
    },
    {
      code: 'DV',
      name: '개발비',
      parent: null,
      sortOrder: 35,
      attributes: { nameEn: 'Development' },
    },
    { code: 'SM', name: '샘플비', parent: null, sortOrder: 36, attributes: { nameEn: 'Sample' } },
    {
      code: 'LG',
      name: '운송비',
      parent: null,
      sortOrder: 37,
      attributes: { nameEn: 'Logistics' },
    },
    {
      code: 'CF',
      name: '인증비',
      parent: null,
      sortOrder: 38,
      attributes: { nameEn: 'Certification' },
    },
    { code: 'DG', name: '설계비', parent: null, sortOrder: 39, attributes: { nameEn: 'Design' } },
  ],
  STORAGE_LOCATION: [
    { code: 'BOC', name: '본코스메틱', parent: null, sortOrder: 1, attributes: null },
    { code: 'IJC', name: '일진코스메틱', parent: null, sortOrder: 2, attributes: null },
    { code: 'CSM', name: '코스메카코리아', parent: null, sortOrder: 3, attributes: null },
    { code: 'CLB', name: '갈렙이앤씨', parent: null, sortOrder: 4, attributes: null },
    { code: 'MKM', name: '마케모', parent: null, sortOrder: 5, attributes: null },
    { code: 'EZC', name: '이지코어', parent: null, sortOrder: 6, attributes: null },
    { code: 'CTK', name: '씨티케이', parent: null, sortOrder: 7, attributes: null },
    { code: 'RBM', name: '리봄화장품', parent: null, sortOrder: 8, attributes: null },
    { code: 'JPS', name: '제이피에스코스메틱', parent: null, sortOrder: 9, attributes: null },
    { code: 'NNN', name: '뉴앤뉴', parent: null, sortOrder: 10, attributes: null },
    { code: 'BON', name: '본코스메틱', parent: null, sortOrder: 11, attributes: null },
  ],
  CHANNEL: [
    {
      code: 'A',
      name: '자사몰',
      parent: null,
      sortOrder: 1,
      attributes: { rawLabel: 'A. 자사몰', salesPartner: '카페24', outboundType: 'B2C' },
    },
    {
      code: 'B',
      name: '네이버',
      parent: null,
      sortOrder: 2,
      attributes: { rawLabel: 'B. 네이버', salesPartner: '스마트스토어', outboundType: 'B2C' },
    },
    {
      code: 'C',
      name: '국내 B2C',
      parent: null,
      sortOrder: 3,
      attributes: {
        rawLabel: 'C. 국내 B2C',
        salesPartner: '무신사, 지그재그, 카카오 선물하기, w컨셉, KREAM, 29cm 등',
        outboundType: 'B2C',
      },
    },
    {
      code: 'D',
      name: '품고',
      parent: null,
      sortOrder: 4,
      attributes: {
        rawLabel: 'D. 품고',
        salesPartner: '스마트스토어 3PL 창고',
        outboundType: 'B2C 창고',
      },
    },
    {
      code: 'E',
      name: '쿠팡로켓',
      parent: null,
      sortOrder: 5,
      attributes: { rawLabel: 'E. 쿠팡로켓', salesPartner: '쿠팡 로켓배송', outboundType: 'B2B' },
    },
    {
      code: 'F',
      name: '올리브영',
      parent: null,
      sortOrder: 6,
      attributes: { rawLabel: 'F. 올리브영', salesPartner: '올리브영', outboundType: 'B2B' },
    },
    {
      code: 'G',
      name: '국내 B2B',
      parent: null,
      sortOrder: 7,
      attributes: {
        rawLabel: 'G. 국내 B2B',
        salesPartner: '면세점, 무신사 오프라인, 팝업 등',
        outboundType: 'B2B',
      },
    },
    {
      code: 'H',
      name: '아마존 US',
      parent: null,
      sortOrder: 8,
      attributes: { rawLabel: 'H. 아마존 US', salesPartner: '아마존 US', outboundType: 'B2C 창고' },
    },
    {
      code: 'I',
      name: '아마존 JP',
      parent: null,
      sortOrder: 9,
      attributes: { rawLabel: 'I. 아마존 JP', salesPartner: '아마존 JP', outboundType: 'B2C 창고' },
    },
    {
      code: 'J',
      name: '해외 창고',
      parent: null,
      sortOrder: 10,
      attributes: {
        rawLabel: 'J. 해외 창고',
        salesPartner: '해외 출고용 창고 이동 (3PL - 로딧, 미르글로벌 ) / 해외용 물류센터 입고',
        outboundType: 'B2C 창고',
      },
    },
    {
      code: 'K',
      name: '해외 B2C',
      parent: null,
      sortOrder: 11,
      attributes: {
        rawLabel: 'K. 해외 B2C',
        salesPartner: '무신사 글로벌, 알리 익스프레스 등',
        outboundType: 'B2C',
      },
    },
    {
      code: 'L',
      name: '해외 B2B',
      parent: null,
      sortOrder: 12,
      attributes: {
        rawLabel: 'L. 해외 B2B',
        salesPartner: '예스스타일, 미르글로벌, 글램픽 등',
        outboundType: 'B2B',
      },
    },
    {
      code: 'M',
      name: '공구',
      parent: null,
      sortOrder: 13,
      attributes: { rawLabel: 'M. 공구', salesPartner: '공동구매', outboundType: 'B2C' },
    },
    {
      code: 'N',
      name: '마케팅 & 센터',
      parent: null,
      sortOrder: 14,
      attributes: {
        rawLabel: 'N. 마케팅 & 센터',
        salesPartner: '마케팅, 증정, 센터 / 아카데미 출고',
        outboundType: '기타',
      },
    },
    {
      code: 'O',
      name: 'CS',
      parent: null,
      sortOrder: 15,
      attributes: {
        rawLabel: 'O. CS',
        salesPartner: 'CS 재출고 / 교환 / 보상 등',
        outboundType: '기타',
      },
    },
    {
      code: 'P',
      name: '기타',
      parent: null,
      sortOrder: 16,
      attributes: {
        rawLabel: 'P. 기타',
        salesPartner: '제조사 출고 / 본사 샘플 / 업체 샘플 / 기타 등',
        outboundType: '기타',
      },
    },
  ],
};
