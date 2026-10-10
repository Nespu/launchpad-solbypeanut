'use client';

interface TrustRingProps {
  active: number; // 0-3
  total?: number;
}

const COLORS = ['#7CFF5C', '#8B7CFF', '#3ddc84'];

export default function TrustRing({ active, total = 3 }: TrustRingProps) {
  const r = 38;
  const circumference = 2 * Math.PI * r;
  const gap = 4;
  const segLen = circumference / total - gap;

  return (
    <div className="relative w-[88px] h-[88px] flex-shrink-0">
      <svg width="88" height="88" viewBox="0 0 88 88" className="-rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
        {Array.from({ length: total }).map((_, i) => (
          <circle
            key={i}
            cx="44"
            cy="44"
            r={r}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${i < active ? segLen : 0} ${circumference}`}
            transform={`rotate(${(360 / total) * i} 44 44)`}
            style={{ transition: 'stroke-dasharray .35s ease' }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display font-semibold text-xl leading-none">{active}/{total}</span>
        <span className="text-[9px] tracking-wider text-[var(--muted)] mt-1">TRUST</span>
      </div>
    </div>
  );
}
