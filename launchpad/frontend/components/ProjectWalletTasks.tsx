'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ExternalLink, RefreshCw } from 'lucide-react';
import { getWalletVaultMetadata } from '../lib/walletVault';
import { listSavedProjectWalletSwapTasks, type SavedProjectWalletSwapTask } from '../lib/projectWalletSwapTask';
import { useWireLocale } from './LocaleProvider';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

type TaskState = 'ready' | 'pending' | 'paused' | 'partial' | 'completed' | 'failed' | 'stopped';
type Filter = 'all' | TaskState;

function taskState(item: SavedProjectWalletSwapTask): TaskState {
  const rows = item.task.rows;
  const pending = rows.some((row) => row.status === 'pending');
  const confirmed = rows.some((row) => row.status === 'confirmed');
  const reviewed = rows.some((row) => row.status === 'reviewed');
  const failed = rows.some((row) => row.status === 'failed');
  const cancelled = rows.some((row) => row.status === 'cancelled');

  if (pending) return 'pending';
  if (item.task.runStatus === 'stopped') return 'stopped';
  if (item.task.runStatus === 'failed') return 'failed';
  if (item.task.runStatus === 'completed') return 'completed';
  if (item.task.runStatus === 'paused') return 'paused';
  if (cancelled && !reviewed) return 'stopped';
  if (confirmed && (reviewed || failed)) return 'partial';
  if (failed) return 'failed';
  if (reviewed) return 'ready';
  if (confirmed) return 'completed';
  if (cancelled) return 'stopped';
  return 'ready';
}

function taskStateLabel(state: TaskState, t: (key: string) => string) {
  const labels: Record<TaskState, string> = {
    ready: t('Lista para revisar'),
    pending: t('Firma pendiente de verificar'),
    paused: t('Pausada; requiere nueva autorización'),
    partial: t('Parcial'),
    completed: t('Completada'),
    failed: t('Fallida'),
    stopped: t('Detenida'),
  };
  return labels[state];
}

function taskStateTone(state: TaskState) {
  if (state === 'completed') return 'text-[var(--success)]';
  if (state === 'pending' || state === 'failed') return 'text-[var(--danger)]';
  if (state === 'partial' || state === 'paused') return 'text-[var(--warning)]';
  return 'text-[var(--wire-green)]';
}

function taskCounts(item: SavedProjectWalletSwapTask) {
  return item.task.rows.reduce((counts, row) => {
    counts[row.status] += 1;
    return counts;
  }, { reviewed: 0, confirmed: 0, pending: 0, failed: 0, cancelled: 0 });
}

function lamportsToSol(value: string) {
  const lamports = BigInt(value);
  const whole = lamports / 1_000_000_000n;
  const fraction = String(lamports % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function rowStatusLabel(status: SavedProjectWalletSwapTask['task']['rows'][number]['status'], t: (key: string) => string) {
  const labels = {
    reviewed: t('Revisada; sin enviar'),
    confirmed: t('Confirmada'),
    pending: t('Firma pendiente de verificar'),
    failed: t('Fallida'),
    cancelled: t('Cancelada antes de firmar'),
  };
  return labels[status];
}

function rowStatusTone(status: SavedProjectWalletSwapTask['task']['rows'][number]['status']) {
  if (status === 'confirmed') return 'text-[var(--success)]';
  if (status === 'pending' || status === 'failed') return 'text-[var(--danger)]';
  if (status === 'cancelled') return 'text-[var(--muted)]';
  return 'text-[var(--wire-green)]';
}

export default function ProjectWalletTasks() {
  const { locale, t } = useWireLocale();
  const [tasks, setTasks] = useState<SavedProjectWalletSwapTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const metadata = await getWalletVaultMetadata();
      setTasks(listSavedProjectWalletSwapTasks(metadata.wallets, window.localStorage));
    } catch {
      setError(t('No se pudo leer la bóveda o el almacenamiento local.'));
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const onStorageChange = () => { void refresh(); };
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('wire:project-wallet-swap-task-updated', onStorageChange);
    return () => {
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('wire:project-wallet-swap-task-updated', onStorageChange);
    };
  }, [refresh]);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: tasks.length, ready: 0, pending: 0, paused: 0, partial: 0, completed: 0, failed: 0, stopped: 0 };
    for (const item of tasks) result[taskState(item)] += 1;
    return result;
  }, [tasks]);

  const visibleTasks = useMemo(() => tasks.filter((item) => filter === 'all' || taskState(item) === filter), [filter, tasks]);
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: t('Todas') },
    { id: 'ready', label: t('Por revisar') },
    { id: 'pending', label: t('Firmas pendientes') },
    { id: 'paused', label: t('Pausadas') },
    { id: 'partial', label: t('Parciales') },
    { id: 'completed', label: t('Completadas') },
    { id: 'failed', label: t('Fallidas') },
    { id: 'stopped', label: t('Detenidas') },
  ];

  return (
    <section className="wire-panel grid gap-5 p-4 sm:p-6" aria-labelledby="project-wallet-tasks-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="project-wallet-tasks-title" className="font-display text-xl font-semibold">{t('Mis tareas')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{t('Revisa y retoma secuencias guardadas para compras y ventas multiwallet.')}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
          <RefreshCw size={15} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          {t('Actualizar lista')}
        </button>
      </header>

      <p className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--muted)]">
        {t('Las secuencias se guardan en este navegador. Al iniciar una corrida revisada, autorizas la firma automática local de sus operaciones en Devnet; requiere la bóveda desbloqueada y la página abierta. Las claves no salen de la bóveda.')}
      </p>

      {error ? <div className="rounded-lg border border-[var(--danger)]/50 p-3 text-sm text-[var(--danger)]" role="alert">{error}</div> : null}

      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label={t('Filtrar tareas')}>
        {filters.map(({ id, label }) => (
          <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id} className={`wire-button min-h-11 shrink-0 px-3 text-xs ${filter === id ? 'wire-button-primary' : 'wire-button-secondary'}`}>
            {label} <span className="ml-1 font-mono">{counts[id]}</span>
          </button>
        ))}
      </nav>

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--muted)]" role="status">{t('Cargando tareas…')}</p>
      ) : visibleTasks.length === 0 ? (
        <div className="grid gap-2 border-t border-[var(--line)] py-8 text-center">
          <h3 className="font-semibold">{tasks.length === 0 ? t('Todavía no hay secuencias guardadas') : t('No hay tareas en este filtro')}</h3>
          <p className="mx-auto max-w-xl text-sm leading-relaxed text-[var(--muted)]">
            {tasks.length === 0
              ? t('Prepara una compra o venta multiwallet en la ficha de un token. La secuencia aparecerá aquí para revisar su estado.')
              : t('Elige otro filtro para ver las demás secuencias.')}
          </p>
          {tasks.length === 0 ? <p><Link href="/wallets" className="wire-button wire-button-secondary mt-2 min-h-11 px-3">{t('Abrir Mis wallets')}</Link></p> : null}
        </div>
      ) : (
        <ul className="grid gap-3" aria-label={t('Lista de tareas guardadas')}>
          {visibleTasks.map((item) => {
            const state = taskState(item);
            const countsForTask = taskCounts(item);
            const quoteAsset = item.quoteMint === SOL_MINT ? 'SOL' : 'USDC';
            const taskName = item.task.side === 'sell'
              ? t('Venta multiwallet')
              : item.task.delayMaxSeconds > 0 ? t('Timed Buys') : t('Compra multiwallet');
            const updatedAt = new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(item.savedAt);
            return (
              <li key={item.storageKey} className="grid gap-3 border-t border-[var(--line)] py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="grid min-w-0 gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="font-semibold">{taskName}</h3>
                    <span className={`text-xs font-semibold ${taskStateTone(state)}`} role="status">{taskStateLabel(state, t)}</span>
                  </div>
                  <p className="break-all font-mono text-xs text-[var(--muted)]">{item.mintAddress}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                    <span>{t('Wallets')}: {item.task.selected.length}</span>
                    <span>{t('Tope visible')}: {item.task.maxTotalSpend} {quoteAsset}</span>
                    <span>{item.launchPlatform === 'PUMP_FUN' ? 'Pump.fun / PumpSwap' : 'Raydium'}</span>
                    <span>{t('Actualizada')}: {updatedAt}</span>
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {t('Confirmadas')}: {countsForTask.confirmed}/{item.task.rows.length}
                    {countsForTask.pending > 0 ? ` · ${t('Pendientes de verificar')}: ${countsForTask.pending}` : ''}
                    {countsForTask.failed > 0 ? ` · ${t('Fallidas')}: ${countsForTask.failed}` : ''}
                    {countsForTask.reviewed > 0 ? ` · ${t('Por revisar')}: ${countsForTask.reviewed}` : ''}
                    {countsForTask.cancelled > 0 ? ` · ${t('Canceladas')}: ${countsForTask.cancelled}` : ''}
                  </p>
                  {state === 'pending' ? <p className="text-xs text-[var(--danger)]">{t('Comprueba esta firma en Devnet antes de preparar otra operación.')}</p> : null}
                </div>
                <div className="sm:min-w-48">
                  <Link href={`/token/${encodeURIComponent(item.mintAddress)}`} className="wire-button wire-button-secondary min-h-11 justify-center px-3 text-sm">
                    {t('Abrir y revisar')} <ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                </div>
                <details className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:col-span-2">
                  <summary className="cursor-pointer rounded-md text-sm font-semibold focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]">
                    {t('Ejecuciones y resultados de esta secuencia')} · {item.task.rows.length}
                  </summary>
                  <ol className="grid gap-2">
                    {item.task.rows.map((row) => (
                      <li key={row.wallet.address} className="grid gap-2 rounded-lg border border-[var(--line)] p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="break-words text-sm font-semibold">{row.wallet.label || t('Wallet sin nombre')}</h4>
                            <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{row.wallet.address}</p>
                          </div>
                          <span className={`text-xs font-semibold ${rowStatusTone(row.status)}`} role="status">{rowStatusLabel(row.status, t)}</span>
                        </div>
                        <dl className="grid gap-x-5 gap-y-1 text-xs sm:grid-cols-2">
                          <div><dt className="text-[var(--muted)]">{t('Operación')}</dt><dd>{row.quote.side === 'buy' ? t('Comprar {symbol}', { symbol: row.quote.outputSymbol }) : t('Vender {symbol}', { symbol: row.quote.inputSymbol })}</dd></div>
                          <div><dt className="text-[var(--muted)]">{t('Importe revisado')}</dt><dd className="font-mono">{row.amountIn} {row.quote.inputSymbol}</dd></div>
                          <div><dt className="text-[var(--muted)]">{t('Salida estimada / mínimo')}</dt><dd className="font-mono">{row.quote.amountOut} / {row.quote.minimumAmountOut} {row.quote.outputSymbol}</dd></div>
                          <div><dt className="text-[var(--muted)]">{t('Fee de pool estimado')}</dt><dd className="font-mono">{row.quote.estimatedPoolFee} {row.quote.inputSymbol}</dd></div>
                          <div><dt className="text-[var(--muted)]">{t('Fee de red estimado')}</dt><dd className="font-mono">{lamportsToSol(row.networkFeeLamports)} SOL</dd></div>
                        </dl>
                        {row.detail ? <p className="break-words rounded-md bg-[var(--surface-2)] p-2 text-xs text-[var(--muted)]">{row.detail}</p> : null}
                        {row.historyPending ? <p className="text-xs text-[var(--warning)]">{t('Confirmada en Devnet; el registro de Wire sigue pendiente.')}</p> : null}
                        <div className="flex flex-wrap gap-2">
                          {row.signature ? <a href={`https://explorer.solana.com/tx/${encodeURIComponent(row.signature)}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-quiet min-h-11 justify-center px-3 text-xs">{row.status === 'failed' ? t('Ver firma fallida en Explorer') : t('Ver firma en Explorer')} <ExternalLink size={12} aria-hidden="true" /></a> : null}
                          {row.previousSignature ? <a href={`https://explorer.solana.com/tx/${encodeURIComponent(row.previousSignature)}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-quiet min-h-11 justify-center px-3 text-xs">{t('Ver firma anterior en Explorer')} <ExternalLink size={12} aria-hidden="true" /></a> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
