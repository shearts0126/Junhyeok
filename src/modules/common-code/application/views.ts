/**
 * 공통코드 외부 표현 (T0-8).
 *
 * 내부 UUID(`groupId`, `parentCodeId`)를 그대로 내보내지 않고,
 * 그룹은 `groupCode`, 부모는 `{ id, groupCode, code, name }` 로 표현한다.
 */

export interface CodeGroupView {
  readonly groupCode: string;
  readonly groupName: string;
  readonly parentGroupCode: string | null;
  readonly sortOrder: number;
  readonly active: boolean;
  /** 그룹의 전체 코드 수 (비활성 포함) */
  readonly codeCount: number;
  readonly activeCodeCount: number;
}

export interface CodeParentView {
  readonly id: string;
  readonly groupCode: string;
  readonly code: string;
  readonly name: string;
}

export interface CodeView {
  readonly id: string;
  readonly groupCode: string;
  readonly code: string;
  readonly name: string;
  readonly parent: CodeParentView | null;
  readonly sortOrder: number;
  readonly attributes: unknown;
  readonly active: boolean;
  /** ISO 8601 */
  readonly updatedAt: string;
}

/** DB 조회 결과 → CodeView. `include` 로 부모와 부모의 그룹까지 읽은 행을 받는다. */
export interface CodeRowForView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly attributes: unknown;
  readonly active: boolean;
  readonly updatedAt: Date;
  readonly group: { readonly groupCode: string };
  readonly parentCode:
    | ({
        readonly id: string;
        readonly code: string;
        readonly name: string;
        readonly group: { readonly groupCode: string };
      } | null)
    | undefined;
}

export function toCodeView(row: CodeRowForView): CodeView {
  const parent = row.parentCode ?? null;
  return {
    id: row.id,
    groupCode: row.group.groupCode,
    code: row.code,
    name: row.name,
    parent:
      parent === null
        ? null
        : {
            id: parent.id,
            groupCode: parent.group.groupCode,
            code: parent.code,
            name: parent.name,
          },
    sortOrder: row.sortOrder,
    attributes: row.attributes ?? null,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}
