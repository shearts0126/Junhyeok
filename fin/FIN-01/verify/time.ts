/**
 * 원천 시간대 → UTC 변환(외부 의존 없이 Intl 로 처리).
 * 계획서 §5: UTC 시각과 원천 시간대를 함께 저장하고, 날짜를 임의 이동하지 않는다.
 */

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** 특정 시간대의 벽시계 시각(YYYY-MM-DDTHH:mm:ss)을 UTC ISO 문자열로 변환한다. */
export function localToUtc(local: string, timeZone: string): string {
  const m = DT_RE.exec(local);
  if (!m) throw new Error(`로컬 시각 형식 오류: ${local}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // 1차 추정: 벽시계 값을 UTC 로 간주한 뒤 해당 시간대 오프셋만큼 보정한다(2회 반복으로 DST 경계 처리).
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i += 1) {
    const offset = tzOffsetMs(guess, timeZone);
    guess = Date.UTC(y, mo - 1, d, h, mi, s) - offset;
  }
  return new Date(guess).toISOString();
}

function tzOffsetMs(epochMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - epochMs;
}

/** 'YYYYMMDD' → 'YYYY-MM-DD' */
export function yyyymmddToIso(v: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) throw new Error(`YYYYMMDD 형식 오류: ${v}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 'YYYYMMDD' + 'HHmmss' → 'YYYY-MM-DDTHH:mm:ss' */
export function yyyymmddHhmmssToLocal(date: string, time: string): string {
  const t = /^(\d{2})(\d{2})(\d{2})$/.exec(time);
  if (!t) throw new Error(`HHmmss 형식 오류: ${time}`);
  return `${yyyymmddToIso(date)}T${t[1]}:${t[2]}:${t[3]}`;
}

/** 요일 기반 영업일 판정(주말만). 공휴일은 별도 달력 입력이 필요하므로 여기서 판정하지 않는다. */
export function isWeekend(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
