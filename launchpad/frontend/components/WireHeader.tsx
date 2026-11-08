'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

type WireHeaderProps = {
  children: ReactNode;
  className?: string;
  intro?: boolean;
};

export default function WireHeader({ children, className = '', intro = false }: WireHeaderProps) {
  const headerRef = useRef<HTMLElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isPastHeader, setIsPastHeader] = useState(false);

  useEffect(() => {
    const updateScrollState = () => {
      setIsScrolled(window.scrollY > 24);
      setIsPastHeader((headerRef.current?.getBoundingClientRect().bottom ?? 1) <= 0);
    };
    updateScrollState();
    window.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('resize', updateScrollState);
    return () => {
      window.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
    };
  }, []);

  return (
    <header
      ref={headerRef}
      className={`wire-header ${intro ? 'is-intro' : ''} ${className} ${isScrolled ? 'is-scrolled' : ''} ${isPastHeader ? 'has-scrolled-past-header' : ''}`}
    >
      {children}
    </header>
  );
}
