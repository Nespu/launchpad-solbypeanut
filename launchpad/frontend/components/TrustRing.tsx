'use client';

import { useWireLocale } from './LocaleProvider';

interface TrustRingProps {
  active: number;
  total?: number;
}

export default function TrustRing({ active, total = 3 }: TrustRingProps) {
  const { t } = useWireLocale();
  const safeTotal = Math.max(total, 1);
  const safeActive = Math.max(0, Math.min(active, safeTotal));
  const size = 104;
  const radius = 43;
  const circumference = 2 * Math.PI * radius;
  const segmentLength = circumference / safeTotal - 8;

  return (
    <div
      className="trust-ring"
      role="img"
      aria-label={t('{active} de {total} controles de seguridad activados', { active: safeActive, total: safeTotal })}
    >
      <svg className="trust-ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth="2" />
        {Array.from({ length: safeTotal }).map((_, index) => (
          <circle
            key={index}
            className={index < safeActive ? 'trust-ring-segment is-active' : 'trust-ring-segment'}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={index < safeActive ? 'var(--wire-green)' : 'var(--line)'}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
            transform={`rotate(${(360 / safeTotal) * index - 90} ${size / 2} ${size / 2})`}
          />
        ))}
      </svg>
      <span className="trust-ring-center">
        <strong>{safeActive}<span>/{safeTotal}</span></strong>
        <small>{t('ACTIVOS')}</small>
      </span>
    </div>
  );
}
