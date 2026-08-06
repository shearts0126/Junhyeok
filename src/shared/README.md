# 공유 계층

전 모듈이 사용하는 공통 코드. 특정 도메인에 속하지 않는 것만 둔다.

```
src/shared/
├─ health.ts        헬스체크 (T0-1)
├─ errors/          공통 오류코드 체계 (T0-3)
├─ types/           공통 타입
├─ db/              PrismaClient, 트랜잭션 헬퍼 (T0-2)
├─ auth/            세션, 역할 가드, ActorContext (T0-6)
├─ audit/           AuditLogger (T0-7)
├─ decimal/         Decimal 유틸 — Number() 변환 금지 (T0-4)
├─ excel/           exceljs 리더·라이터 (R1a-1 / R1a-4)
└─ jobs/            pg-boss 클라이언트 (T4-1, R1a-4)
```

> 디렉터리는 해당 작업에서 생성한다. T0-1 은 `health.ts` 와 빈 `errors/`·`types/` 만 둔다.
