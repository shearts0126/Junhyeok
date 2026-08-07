import { getPrismaClient } from '@/shared/db';

/**
 * 사용자·역할·권한 조회 (T0-6).
 *
 * ⚠️ 인증 성공만으로 로컬 `user` 행을 **자동 생성하지 않는다.** 그런 경로를
 *    만들면 승인되지 않은 Supabase 계정이 SCM 시스템 사용자가 된다.
 *    사용자 생성·초대는 T0-6 범위 밖이다.
 */

export interface UserAuthorization {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

/** 조회 인터페이스. 테스트에서 대역을 주입할 수 있게 분리한다. */
export interface UserAuthorizationReader {
  findByUserId(userId: string): Promise<UserAuthorization | null>;
}

/** Prisma 구현. */
export const prismaUserAuthorizationReader: UserAuthorizationReader = {
  async findByUserId(userId: string): Promise<UserAuthorization | null> {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        active: true,
        userRoles: {
          select: {
            role: {
              select: {
                roleCode: true,
                rolePermissions: {
                  select: { permission: { select: { permissionKey: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (user === null) return null;

    const roles: string[] = [];
    const permissions: string[] = [];
    for (const userRole of user.userRoles) {
      roles.push(userRole.role.roleCode);
      for (const rolePermission of userRole.role.rolePermissions) {
        permissions.push(rolePermission.permission.permissionKey);
      }
    }

    // 중복 제거·정렬은 createActorContext 가 담당한다.
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      active: user.active,
      roles,
      permissions,
    };
  },
};

export interface RoleSummary {
  readonly roleCode: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
}

export interface RoleReader {
  listRoles(): Promise<readonly RoleSummary[]>;
}

export const prismaRoleReader: RoleReader = {
  async listRoles(): Promise<readonly RoleSummary[]> {
    const prisma = getPrismaClient();

    const roles = await prisma.role.findMany({
      orderBy: { roleCode: 'asc' },
      select: {
        roleCode: true,
        roleName: true,
        rolePermissions: {
          select: { permission: { select: { permissionKey: true } } },
        },
      },
    });

    return roles.map((role) => ({
      roleCode: role.roleCode,
      roleName: role.roleName,
      permissions: role.rolePermissions
        .map((rolePermission) => rolePermission.permission.permissionKey)
        .sort((a, b) => a.localeCompare(b, 'en')),
    }));
  },
};
