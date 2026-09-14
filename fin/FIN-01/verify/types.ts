/**
 * FIN-01 검증용 표준 레코드 타입.
 *
 * 계획서 §5 데이터 구조의 필수 필드만 옮긴 것이며, 새 데이터 모델을 설계하지 않는다.
 * 금액은 전부 십진수 문자열(decimal.ts 참조).
 */

export type LegalEntity = 'DEEPPOINT' | 'DISTROVA' | 'UNMAPPED';

export type SourceSystem =
  | 'BANK_KFTC_OPENBANKING'
  | 'BANK_AGGREGATOR'
  | 'SALES_SABANGNET'
  | 'SALES_CAFE24'
  | 'DELIVERY_EXCEL'
  | 'ADS_META'
  | 'ADS_GOOGLE'
  | 'ADS_NAVER'
  | 'ADS_COUPANG'
  | 'ADS_TIKTOK'
  | 'ACCOUNTING_WEHAGO'
  | 'FX_KOREAEXIM'
  | 'FX_ECOS';

/** source_runs: 대상 기간, 수집 시각, 원천 최신일, 결과·오류 */
export interface SourceRun {
  sourceSystem: SourceSystem;
  accountAlias: string;
  periodFrom: string; // YYYY-MM-DD (원천 시간대 기준)
  periodTo: string;
  collectedAtUtc: string; // ISO-8601 UTC
  sourceLatestDate?: string; // 원천 자료 기준일(수집 시각과 구분)
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
  note?: string;
}

/** source_records: 원천키, payload 해시, 관측 버전 */
export interface SourceRecord {
  sourceSystem: SourceSystem;
  accountAlias: string;
  sourceKey: string;
  payloadHash: string;
  observedVersion: number;
  firstSeenRunId: string;
  lastSeenRunId: string;
}

/** bank_transactions */
export interface BankTransaction {
  legalEntity: LegalEntity;
  accountAlias: string;
  currency: string;
  sourceKey: string;
  occurredAtLocal: string; // YYYY-MM-DDTHH:mm:ss (원천 시간대)
  sourceTz: string;
  occurredAtUtc: string;
  direction: 'IN' | 'OUT';
  amount: string;
  balanceAfter?: string;
  description: string;
}

/** bank_balances */
export interface BankBalance {
  legalEntity: LegalEntity;
  accountAlias: string;
  currency: string;
  asOfDate: string;
  balance: string;
  balanceKind: 'END_OF_DAY' | 'AT_INQUIRY';
  observedAtUtc: string;
}

/** sales_events */
export type SalesEventType = 'PAID' | 'SHIPPED' | 'CANCELLED' | 'REFUNDED' | 'RETURNED';

export interface SalesEvent {
  legalEntity: LegalEntity;
  channel: string;
  saleType: 'CONSUMER' | 'DELIVERY';
  sourceSystem: SourceSystem;
  orderId: string;
  lineId: string;
  eventId: string;
  eventType: SalesEventType;
  eventDateLocal: string; // YYYY-MM-DD
  eventAtLocal?: string; // YYYY-MM-DDTHH:mm:ss, 원천이 시각을 주는 경우
  sourceTz: string;
  currency: string;
  /** 부호 있는 순매출(취소/환불/반품은 음수). 공급가/세포함 여부는 amountBasis 로 구분 */
  netAmount: string;
  amountBasis: 'SUPPLY' | 'GROSS_INCL_VAT' | 'UNKNOWN';
  taxAmount?: string;
  discountAmount?: string;
  productCode: string;
  quantity: string;
  /** 취소·환불·반품이 연결되는 원거래 이벤트 ID */
  linkedEventId?: string;
}

/** ad_daily_spend */
export interface AdDailySpend {
  legalEntity: LegalEntity;
  platform: 'META' | 'GOOGLE' | 'NAVER' | 'COUPANG' | 'TIKTOK';
  adAccountAlias: string;
  date: string; // 원천 계정 시간대 기준 일자
  sourceTz: string;
  currency: string;
  spend: string;
  taxBasis: 'EXCL_VAT' | 'INCL_VAT' | 'UNKNOWN';
  sourceVersion: string; // 수집 실행 ID. 같은 (계정,일자) 재수집 시 대체
}

/** ad_balances */
export interface AdBalance {
  legalEntity: LegalEntity;
  platform: AdDailySpend['platform'];
  adAccountAlias: string;
  observedAtUtc: string;
  currency: string;
  balance: string;
  balanceKind: 'PREPAID_REMAINING' | 'POSTPAID_OWED' | 'UNKNOWN';
}

/** accounting_lines */
export interface AccountingLine {
  legalEntity: LegalEntity;
  fiscalPeriod: string; // YYYY-MM
  accountCode: string;
  amount: string;
  dataShape: 'MONTHLY' | 'CUMULATIVE';
  voucherId?: string;
  lineId?: string;
  version: string;
}

/** fx_rates */
export interface FxRate {
  currency: string;
  asOfDate: string; // 환율 기준일
  appliedForDate?: string; // 휴일 대체 시 실제 적용 보고일
  rateType: string; // 예: 'KOREAEXIM_DEAL_BAS_R', 'ECOS_731Y001_0000001'
  rate: string;
  source: SourceSystem;
  collectedAtUtc: string;
}
