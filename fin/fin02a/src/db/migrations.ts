/**
 * 현재 앱이 요구하는 마이그레이션 ID 집합. readiness 는 개수가 아니라 이 집합이 전부 fin_schema_migrations 에 있는지 확인한다.
 * db/migrations 디렉터리와 정확히 일치해야 하며 test/app.test.ts 가 디렉터리 목록과 대조한다.
 */
export const REQUIRED_MIGRATIONS: readonly string[] = [
  '0001_fin02a_core.sql',
  '0002_fin02a_integrity.sql',
  '0003_fin02a_run_mode_recovery.sql',
  '0004_fin02c_jobs_leases.sql',
  '0005_fin02c_queue_boundary.sql',
];
