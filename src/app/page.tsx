import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { getHealthStatus, SERVICE_NAME } from '@/shared/health';

/**
 * T0-1 확인용 랜딩 페이지.
 * 업무 화면은 R1a-1 이후 각 모듈의 presentation 계층에서 구현한다.
 */
export default function HomePage() {
  const health = getHealthStatus();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <p className="text-muted-foreground font-mono text-sm">{SERVICE_NAME}</p>
        <h1 className="text-3xl font-semibold tracking-tight">DEEPPOINT SCM OS</h1>
        <p className="text-muted-foreground text-sm">
          구매·발주, 공급계획, 재고, WMS 실행, S&amp;OP를 통합한 내부 SCM 운영 시스템입니다.
        </p>
      </header>

      <section className="bg-card rounded-lg border p-5">
        <h2 className="mb-3 text-sm font-medium">기동 상태</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">status</dt>
          <dd className="font-mono">{health.status}</dd>
          <dt className="text-muted-foreground">environment</dt>
          <dd className="font-mono">{health.environment}</dd>
          <dt className="text-muted-foreground">checks</dt>
          <dd className="font-mono">{health.checks.length}건 (T0-1: 외부 의존성 없음)</dd>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">현재 단계</h2>
        <p className="text-muted-foreground text-sm">
          <span className="font-mono">R1a-0 / T0-1</span> — 프로젝트 초기화 완료. 데이터베이스,
          인증, 업무 모듈은 후속 작업에서 구현합니다.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/api/health">헬스체크 응답 보기</Link>
        </Button>
      </section>
    </main>
  );
}
