import type { Queryable } from '../db/client';

/** 기본 식별 구조: 법인, 원천 시스템, 원천 계정(소속 법인), 외부 코드 ↔ 내부 코드 매핑. */

export type SourceKind = 'BANK' | 'SALES' | 'DELIVERY' | 'ADS' | 'ACCOUNTING' | 'FX';
export type MappingEntityType =
  'LEGAL_ENTITY' | 'BANK_ACCOUNT' | 'COUNTERPARTY' | 'PRODUCT' | 'BRAND' | 'CHANNEL' | 'AD_ACCOUNT';

export interface LegalEntity {
  id: number;
  code: string;
  name: string;
}

export interface SourceAccount {
  id: string;
  legalEntityId: number;
  sourceSystem: string;
  externalAccountId: string;
  alias: string;
  currency: string | null;
  activeFrom: string;
  activeTo: string | null;
}

export async function ensureLegalEntity(
  db: Queryable,
  code: string,
  name: string,
): Promise<LegalEntity> {
  const r = await db.query<{ id: number; code: string; name: string }>(
    `INSERT INTO fin_legal_entities (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, code, name`,
    [code, name],
  );
  const row = r.rows[0];
  if (!row) throw new Error('법인 저장 실패');
  return row;
}

export async function ensureSourceSystem(
  db: Queryable,
  code: string,
  kind: SourceKind,
  name: string,
): Promise<void> {
  await db.query(
    `INSERT INTO fin_source_systems (code, kind, name) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name`,
    [code, kind, name],
  );
}

export interface NewSourceAccount {
  legalEntityId: number;
  sourceSystem: string;
  externalAccountId: string;
  alias: string;
  currency?: string;
  activeFrom: string;
}

export async function createSourceAccount(
  db: Queryable,
  input: NewSourceAccount,
): Promise<SourceAccount> {
  const r = await db.query<SourceAccountRow>(
    `INSERT INTO fin_source_accounts (legal_entity_id, source_system, external_account_id, alias, currency, active_from)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, legal_entity_id, source_system, external_account_id, alias, currency, active_from::text, active_to::text`,
    [
      input.legalEntityId,
      input.sourceSystem,
      input.externalAccountId,
      input.alias,
      input.currency ?? null,
      input.activeFrom,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('원천 계정 저장 실패');
  return toAccount(row);
}

export async function getSourceAccount(db: Queryable, id: string): Promise<SourceAccount | null> {
  const r = await db.query<SourceAccountRow>(
    `SELECT id, legal_entity_id, source_system, external_account_id, alias, currency, active_from::text, active_to::text
     FROM fin_source_accounts WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  return row ? toAccount(row) : null;
}

interface SourceAccountRow {
  id: string;
  legal_entity_id: number;
  source_system: string;
  external_account_id: string;
  alias: string;
  currency: string | null;
  active_from: string;
  active_to: string | null;
}

function toAccount(row: SourceAccountRow): SourceAccount {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    sourceSystem: row.source_system,
    externalAccountId: row.external_account_id,
    alias: row.alias,
    currency: row.currency,
    activeFrom: row.active_from,
    activeTo: row.active_to,
  };
}

export interface NewExternalMapping {
  sourceSystem: string;
  sourceAccountId?: string;
  entityType: MappingEntityType;
  externalCode: string;
  internalId: string;
  validFrom: string;
  validTo?: string;
}

export async function addExternalMapping(db: Queryable, m: NewExternalMapping): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO fin_external_mappings (source_system, source_account_id, entity_type, external_code, internal_id, valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      m.sourceSystem,
      m.sourceAccountId ?? null,
      m.entityType,
      m.externalCode,
      m.internalId,
      m.validFrom,
      m.validTo ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('매핑 저장 실패');
  return row.id;
}

/**
 * 외부 코드 → 내부 ID. 계정 범위 매핑이 시스템 범위 매핑보다 우선한다.
 * 매핑이 없으면 null 을 돌려주며 호출자는 원본 코드를 보존해야 한다(임의 생성 금지).
 */
export async function resolveExternalCode(
  db: Queryable,
  q: {
    sourceSystem: string;
    sourceAccountId: string | null;
    entityType: MappingEntityType;
    externalCode: string;
    onDate: string;
  },
): Promise<string | null> {
  const r = await db.query<{ internal_id: string }>(
    `SELECT internal_id FROM fin_external_mappings
     WHERE source_system = $1 AND entity_type = $2 AND external_code = $3
       AND (source_account_id = $4 OR source_account_id IS NULL)
       AND valid_from <= $5::date AND (valid_to IS NULL OR valid_to >= $5::date)
     ORDER BY (source_account_id IS NULL) ASC, valid_from DESC
     LIMIT 1`,
    [q.sourceSystem, q.entityType, q.externalCode, q.sourceAccountId, q.onDate],
  );
  return r.rows[0]?.internal_id ?? null;
}
