import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ProjectProgressDashboard from '../../components/ProjectProgressDashboard';
import WireHeader from '../../components/WireHeader';
import Image from 'next/image';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Progreso de Wire',
  robots: { index: false, follow: false },
};

export default function ProjectProgressPage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  return (
    <main className="wire-shell min-h-screen px-4 py-4 sm:px-6 md:px-8 md:py-8">
      <div className="wire-container">
        <WireHeader className="mb-10">
          <Link href="/" className="flex min-h-11 items-center gap-3 rounded-md" aria-label="Wire, inicio">
            <Image src="/wire-logo-grok.png" alt="" width={34} height={28} priority />
            <span>
              <span className="block font-display text-lg font-semibold leading-none text-white">wire</span>
              <span className="mt-1 block text-xs text-[var(--muted)]">Seguimiento del proyecto</span>
            </span>
          </Link>
          <nav className="wire-header-actions" aria-label="Navegación">
            <Link href="/" className="wire-button wire-button-quiet">Volver al launchpad</Link>
          </nav>
        </WireHeader>

        <ProjectProgressDashboard />
      </div>
    </main>
  );
}
