'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CircleDashed, CircleDot, Clock3, RefreshCw } from 'lucide-react';

type TaskStatus = 'complete' | 'ready_for_validation' | 'in_progress' | 'pending' | 'blocked';

type ProgressTask = {
  id: string;
  title: string;
  status: TaskStatus;
  progressPercent?: number;
  note: string;
};

type ProgressPhase = {
  id: string;
  title: string;
  items: ProgressTask[];
};

type ProgressSnapshot = {
  title: string;
  summary: string;
  pollIntervalSeconds: number;
  method: string;
  updatedAt: string;
  phases: ProgressPhase[];
};

const STATUS_META: Record<TaskStatus, { label: string; Icon: typeof Check; color: string }> = {
  complete: { label: 'Cerrado', Icon: Check, color: 'var(--success)' },
  ready_for_validation: { label: 'Listo para validar', Icon: CircleDot, color: 'var(--wire-green)' },
  in_progress: { label: 'En curso', Icon: Clock3, color: '#e9b54b' },
  pending: { label: 'Pendiente', Icon: CircleDashed, color: 'var(--muted)' },
  blocked: { label: 'Bloqueado', Icon: AlertTriangle, color: 'var(--danger)' },
};

function getTaskProgressPercent(task: ProgressTask) {
  if (task.status === 'complete') return 100;
  if (task.status === 'ready_for_validation') return 80;
  if (task.status !== 'in_progress') return 0;
  if (typeof task.progressPercent !== 'number' || !Number.isFinite(task.progressPercent)) return 50;
  return Math.max(1, Math.min(99, Math.round(task.progressPercent as number)));
}

function getCounts(phases: ProgressPhase[]) {
  const tasks = phases.flatMap((phase) => phase.items);
  const points = tasks.reduce((sum, task) => sum + getTaskProgressPercent(task) / 100, 0);
  const counts = tasks.reduce<Record<TaskStatus, number>>((result, task) => {
    result[task.status] += 1;
    return result;
  }, { complete: 0, ready_for_validation: 0, in_progress: 0, pending: 0, blocked: 0 });

  return {
    total: tasks.length,
    points,
    percent: tasks.length ? Number(((points / tasks.length) * 100).toFixed(2)) : 0,
    counts,
  };
}

function formatPercent(value: number) {
  return new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'hora no disponible';
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function ProjectProgressDashboard() {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let mounted = true;
    let request: AbortController | null = null;

    const refresh = async () => {
      if (request) return;
      request = new AbortController();
      if (mounted) setRefreshing(true);

      try {
        const response = await fetch('/api/project-progress', {
          cache: 'no-store',
          signal: request.signal,
        });
        if (!response.ok) throw new Error('No se pudo leer el avance guardado.');
        const next = await response.json() as ProgressSnapshot;
        if (!Array.isArray(next.phases)) throw new Error('El archivo de avance tiene un formato inesperado.');
        if (mounted) {
          setSnapshot(next);
          setError('');
        }
      } catch (cause) {
        if (mounted && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(cause instanceof Error ? cause.message : 'No se pudo actualizar el avance.');
        }
      } finally {
        request = null;
        if (mounted) setRefreshing(false);
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      request?.abort();
    };
  }, []);

  const counts = useMemo(() => getCounts(snapshot?.phases ?? []), [snapshot]);
  const nextTask = snapshot?.phases.flatMap((phase) => phase.items).find((task) => task.status === 'in_progress');
  const remaining = 100 - counts.percent;

  if (!snapshot) {
    return (
      <section className="mx-auto max-w-5xl py-12" aria-live="polite">
        <h1 className="font-display text-3xl font-semibold sm:text-4xl">Progreso de Wire</h1>
        <p className="mt-4 text-[var(--muted)]">{error || 'Leyendo los hitos del proyecto…'}</p>
        {error && (
          <button type="button" onClick={() => window.location.reload()} className="wire-button wire-button-quiet mt-5">
            <RefreshCw size={15} aria-hidden="true" /> Reintentar
          </button>
        )}
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-5xl pb-16">
      <section aria-labelledby="progress-title" className="border-b border-[var(--line)] pb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <h1 id="progress-title" className="font-display text-3xl font-semibold tracking-[-0.03em] sm:text-5xl">
              Progreso de Wire
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] sm:text-base">
              {snapshot.summary} Este panel relee el avance guardado cada {snapshot.pollIntervalSeconds} segundos.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="wire-button wire-button-quiet min-h-11"
            aria-label="Actualizar el progreso ahora"
          >
            <RefreshCw size={15} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
            Actualizar
          </button>
        </div>

        <div className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div>
              <p className="text-sm font-medium text-[var(--muted)]">Avance estimado del proyecto</p>
            <p className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-4xl font-semibold tabular-nums text-[var(--text)] sm:text-6xl">{formatPercent(counts.percent)}%</span>
                <span className="text-sm text-[var(--muted)]">completado</span>
              </p>
            </div>
            <p className="text-sm font-medium text-[var(--wire-green)]">Falta {formatPercent(remaining)}%</p>
          </div>

          <div
            className="mt-5 h-3 overflow-hidden rounded-full bg-[var(--surface-3)]"
            role="progressbar"
            aria-label="Avance estimado de los hitos del proyecto Wire"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={counts.percent}
            aria-valuetext={`${formatPercent(counts.percent)}% completado; falta ${formatPercent(remaining)}%`}
          >
            <div
              className="h-full rounded-full bg-[var(--wire-green)] transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${counts.percent}%` }}
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-y-4 border-t border-[var(--line)] pt-4 sm:grid-cols-4">
            <Metric label="Hitos cerrados" value={`${counts.counts.complete} / ${counts.total}`} />
            <Metric label="Listos para validar" value={String(counts.counts.ready_for_validation)} />
            <Metric label="En curso" value={String(counts.counts.in_progress)} />
            <Metric label="Pendientes o bloqueados" value={String(counts.counts.pending + counts.counts.blocked)} />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted)]">
              <p role="status" aria-atomic="true">
              Avance: {formatPercent(counts.percent)}% completado; falta {formatPercent(remaining)}%. Último cambio: {formatUpdatedAt(snapshot.updatedAt)}
            </p>
            <p>Revisión automática cada {snapshot.pollIntervalSeconds} s</p>
          </div>
          {error && <p className="mt-3 text-sm text-[var(--danger)]" role="status">{error} Se conserva el último avance recibido.</p>}
        </div>

        {nextTask && (
          <p className="mt-5 border-l-2 border-[var(--wire-green)] pl-4 text-sm leading-6 text-[var(--muted)]">
            <span className="font-semibold text-[var(--text)]">En curso:</span> {nextTask.title}
          </p>
        )}
        <p className="mt-4 max-w-3xl text-xs leading-5 text-[var(--muted)]">{snapshot.method}</p>
      </section>

      <section className="mt-8" aria-labelledby="phases-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="phases-title" className="font-display text-2xl font-semibold">Todo lo que falta cerrar</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">El alcance incluye el núcleo de Wire, validaciones y las funciones avanzadas del roadmap.</p>
          </div>
          <p className="text-xs text-[var(--muted)]">{snapshot.phases.length} áreas · {counts.total} hitos</p>
        </div>

        <div className="mt-5">
          {snapshot.phases.map((phase, index) => {
            const phaseCounts = getCounts([phase]);
            const openByDefault = index === 0 || phase.items.some((task) => task.status === 'in_progress');

            return (
              <details key={phase.id} open={openByDefault} className="group border-t border-[var(--line)] py-4 last:border-b">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 rounded-md py-2 focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                    <span className="font-display text-lg font-semibold">{phase.title}</span>
                    <span className="text-xs tabular-nums text-[var(--muted)]">{phaseCounts.percent}%</span>
                  </span>
                  <span className="flex min-w-24 items-center gap-3">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                      <span className="block h-full rounded-full bg-[var(--wire-green)]" style={{ width: `${phaseCounts.percent}%` }} />
                    </span>
                    <span className="text-xs text-[var(--muted)]">{phaseCounts.counts.complete}/{phaseCounts.total}</span>
                  </span>
                </summary>

                <ul className="mt-3 divide-y divide-[var(--line)]">
                  {phase.items.map((task) => {
                    const status = STATUS_META[task.status];
                    const StatusIcon = status.Icon;
                    return (
                      <li key={task.id} className="grid min-w-0 gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                        <div className="flex min-w-0 gap-3">
                          <StatusIcon size={16} className="mt-0.5 shrink-0" color={status.color} aria-hidden="true" />
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold leading-5">{task.title}</h3>
                            <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--muted)] [overflow-wrap:anywhere]">{task.note}</p>
                          </div>
                        </div>
                        <span className="ml-7 mt-1 flex items-center gap-2 text-xs font-medium sm:ml-0 sm:mt-0" style={{ color: status.color }}>
                          {status.label}
                          {task.status === 'in_progress' && <span className="font-mono tabular-nums">{getTaskProgressPercent(task)}%</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="pr-3">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
