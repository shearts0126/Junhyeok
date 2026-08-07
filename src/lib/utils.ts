import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind 클래스 병합 유틸 (shadcn/ui 표준).
 * 조건부 클래스를 clsx 로 합친 뒤 tailwind-merge 로 충돌 클래스를 정리한다.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
