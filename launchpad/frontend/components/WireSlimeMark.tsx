'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef } from 'react';

export default function WireSlimeMark() {
  const markRef = useRef<HTMLDivElement>(null);
  const displacementRef = useRef<SVGFEDisplacementMapElement>(null);
  const frameRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => { reducedMotionRef.current = media.matches; };
    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  const resetMark = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    displacementRef.current?.setAttribute('scale', '0');
    markRef.current?.style.setProperty('--wire-slime-rotate-x', '0deg');
    markRef.current?.style.setProperty('--wire-slime-rotate-y', '0deg');
    markRef.current?.style.setProperty('--wire-slime-shift-x', '0px');
    markRef.current?.style.setProperty('--wire-slime-shift-y', '0px');
  }, []);

  const deformMark = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || reducedMotionRef.current) return;
    const mark = markRef.current;
    const displacement = displacementRef.current;
    if (!mark || !displacement) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
    const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    const force = Math.min(1, Math.hypot(x, y) / Math.SQRT2);

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      displacement.setAttribute('scale', String(Math.round(8 + force * 26)));
      mark.style.setProperty('--wire-slime-rotate-x', `${-y * 4}deg`);
      mark.style.setProperty('--wire-slime-rotate-y', `${x * 5}deg`);
      mark.style.setProperty('--wire-slime-shift-x', `${x * 4}px`);
      mark.style.setProperty('--wire-slime-shift-y', `${y * 4}px`);
      frameRef.current = null;
    });
  }, []);

  return (
    <div
      ref={markRef}
      className="wire-slime-mark"
      onPointerMove={deformMark}
      onPointerLeave={resetMark}
    >
      <svg className="wire-slime-filter-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="wire-slime-warp" x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence type="fractalNoise" baseFrequency="0.014 0.026" numOctaves="2" seed="7" result="wireTexture" />
            <feDisplacementMap
              ref={displacementRef}
              in="SourceGraphic"
              in2="wireTexture"
              scale="0"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
      <Image
        src="/wire-logo-grok.png"
        alt="Símbolo de Wire"
        width={512}
        height={416}
        priority
        draggable={false}
      />
    </div>
  );
}
