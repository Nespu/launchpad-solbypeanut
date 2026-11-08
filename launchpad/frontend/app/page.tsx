'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import WalletConnector from '../components/WalletConnector';
import WalletAccountPanel from '../components/WalletAccountPanel';
import WireHeader from '../components/WireHeader';
import TokenForm from '../components/TokenForm';
import MemeCoinConstellations from '../components/MemeCoinConstellations';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { useWireLocale } from '../components/LocaleProvider';

const FLOW_STEPS = [
  { number: '01', title: 'Define el token', description: 'Nombre, símbolo e imagen para identificarlo.' },
  { number: '02', title: 'Completa metadatos', description: 'Agrega descripción y enlaces públicos opcionales.' },
  { number: '03', title: 'Configura la oferta', description: 'Elige supply y SOL para la pool posterior.' },
  { number: '04', title: 'Define seguridad', description: 'Decide qué autoridades conservar o revocar.' },
  { number: '05', title: 'Revisa y crea', description: 'Confirma red y costos antes de firmar.' },
];

export default function Home() {
  const { connected, connecting } = useWallet();
  const { t } = useWireLocale();
  const [walletCheckComplete, setWalletCheckComplete] = useState(false);
  const [introReady, setIntroReady] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    setShowIntro(window.localStorage.getItem('wire:intro-complete:v1') !== 'true');
    setIntroReady(true);
    const timeout = window.setTimeout(() => setWalletCheckComplete(true), 800);
    return () => window.clearTimeout(timeout);
  }, []);

  const beginLaunch = () => {
    window.localStorage.setItem('wire:intro-complete:v1', 'true');
    window.dispatchEvent(new Event('wire:intro-state'));
    setShowIntro(false);
    window.setTimeout(() => {
      const stage = document.getElementById('launch-stage');
      stage?.focus();
      stage?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const replayIntro = () => {
    window.localStorage.removeItem('wire:intro-complete:v1');
    window.dispatchEvent(new Event('wire:intro-state'));
    setShowIntro(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main className={`wire-shell min-h-screen px-4 py-4 sm:px-6 md:px-8 md:py-8 ${introReady && showIntro ? 'wire-shell-intro' : ''}`}>
      {introReady && showIntro && <div className="wire-intro-atmosphere" aria-hidden="true" />}
      {introReady && showIntro && <MemeCoinConstellations />}
      <div className="wire-container">
        <WireHeader intro={introReady && showIntro} className="mb-12">
          <Link href="/" className="flex min-h-11 items-center gap-3 rounded-md" aria-label={t('Wire, inicio')}>
            <Image src="/wire-logo-grok.png" alt="" width={34} height={28} priority />
            <span>
              <span className="block font-display text-lg font-semibold leading-none text-white">wire</span>
          <span className="mt-1 block text-xs text-[var(--muted)]">{t('Launchpad de tokens en Solana')}</span>
            </span>
          </Link>
          <nav className="wire-header-actions" aria-label={t('Navegación principal')}>
            <LanguageSwitcher />
            {introReady && showIntro ? (
              <>
                <Link href="/seguridad" className="wire-button wire-button-quiet min-h-11 text-xs sm:text-sm">
                  <ShieldCheck size={16} aria-hidden="true" />{t('Seguridad y riesgos')}
                </Link>
                <button type="button" onClick={beginLaunch} className="wire-button wire-button-primary min-h-11 px-4 text-xs sm:text-sm">
                  {t('Crear token')}<ArrowRight size={16} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <Link href="/manage-liquidity" className="wire-button wire-button-quiet">
                  {t('Administrar liquidez')}
                </Link>
                <Link href="/tasks" className="wire-button wire-button-quiet">{t('Tareas')}</Link>
                <Link href="/wallets" className="wire-button wire-button-quiet">{t('Mis wallets')}</Link>
                {introReady && <WalletAccountPanel />}
              </>
            )}
          </nav>
        </WireHeader>

        {!introReady ? (
          <div className="min-h-[55vh]" aria-hidden="true" />
        ) : showIntro ? (
          <>
            <section className="wire-welcome mb-12" aria-labelledby="welcome-title">
              <div className="wire-welcome-layout wire-welcome-centered">
                <div className="wire-intro-emblem" aria-hidden="true">
                  <span className="wire-intro-orbit" />
                  <Image src="/wire-logo-grok.png" alt="" width={150} height={122} priority className="wire-intro-logo" />
                </div>
                <div className="wire-welcome-content">
                  <span className="wire-kicker justify-center">{t('Solana Devnet · Launchpad')}</span>
                  <h1 id="welcome-title" className="wire-welcome-title">{t('Tu lanzamiento empieza aquí.')}</h1>
                  <p className="wire-welcome-description">
                    {t('Crea en Solana Devnet, configura liquidez en Raydium y revisa cada operación desde tu wallet.')}
                  </p>
                  <div className="wire-welcome-actions">
                    <button type="button" onClick={beginLaunch} className="wire-button wire-button-primary min-h-12 px-6">
                      {t('Comenzar')}<ArrowRight size={17} aria-hidden="true" />
                    </button>
                    <span className="wire-welcome-note">{t('La wallet te pide confirmar antes de firmar.')}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="wire-intro-how mb-16" aria-labelledby="intro-how-title">
              <div className="wire-intro-heading">
                <h2 id="intro-how-title">{t('Del token al intercambio')}</h2>
                <p>{t('Wire organiza el lanzamiento en pasos claros. Tú revisas cada decisión.')}</p>
              </div>
              <ol className="wire-intro-steps">
                <li>
                  <div><h3>{t('Conecta y define')}</h3><p>{t('Elige nombre, símbolo, imagen y supply. La creación se confirma en tu wallet.')}</p></div>
                </li>
                <li>
                  <div><h3>{t('Revisa la seguridad')}</h3><p>{t('Decide qué autoridades revocar y comprueba los costos antes de firmar.')}</p></div>
                </li>
                <li>
                  <div><h3>{t('Configura la pool')}</h3><p>{t('Aporta tokens y SOL para habilitar intercambios de tu token en Raydium Devnet.')}</p></div>
                </li>
              </ol>
            </section>

            <section className="wire-intro-economics mb-16" aria-label={t('Costos y funcionamiento del mercado')}>
              <div className="wire-intro-pricing" id="precios">
                <h2>{t('Costos antes de firmar')}</h2>
                <p className="wire-intro-price">0.02 <span>SOL</span></p>
                <p className="wire-intro-price-caption">{t('Tarifa base actual de Wire por crear un token.')}</p>
                <dl className="wire-intro-price-list">
                  <div><dt>{t('Opciones de seguridad')}</dt><dd>{t('0 SOL extra actualmente')}</dd></div>
                  <div><dt>{t('Liquidez inicial')}</dt><dd>{t('La defines por separado')}</dd></div>
                  <div><dt>{t('Comisión de red')}</dt><dd>{t('Se muestra en tu wallet')}</dd></div>
                </dl>
                <p className="wire-intro-footnote">{t('Esta es la tarifa base actual. Revisa el resumen del formulario y Phantom para confirmar los importes vigentes antes de firmar.')}</p>
              </div>
              <div className="wire-intro-market">
                <h2>{t('¿Cómo puedes obtener valor?')}</h2>
                <p>{t('La pool permite que otras personas compren y vendan tu token. Si conservas tokens y existe demanda, podrías venderlos; el precio también puede bajar y puedes perder.')}</p>
                <p>{t('Crear un token o una pool no garantiza ingresos. Wire opera aquí en Devnet: los SOL y tokens de prueba no tienen valor real.')}</p>
                <Link href="/seguridad" className="wire-inline-link">{t('Lee los riesgos antes de empezar')}<ArrowRight size={15} aria-hidden="true" /></Link>
              </div>
            </section>

            <section className="wire-intro-cta mb-14" aria-labelledby="intro-cta-title">
              <div><h2 id="intro-cta-title">{t('¿Listo para darle forma?')}</h2><p>{t('Conecta tu wallet y empieza en Devnet.')}</p></div>
              <button type="button" onClick={beginLaunch} className="wire-button wire-button-primary min-h-12 px-6">
                {t('Crear token')}<ArrowRight size={17} aria-hidden="true" />
              </button>
            </section>
          </>
        ) : (
        <>
        <section className="wire-home-hero mb-8 wire-enter" aria-labelledby="home-title">
          <div className="wire-home-hero-copy">
          <div className="wire-kicker mb-5">
            <span className="wire-status-dot" aria-hidden="true" />
            Solana Devnet <span className="wire-home-kicker-divider" aria-hidden="true" /> Launchpad
          </div>
          <h1 id="home-title" className="mb-4 max-w-4xl font-display text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
            {t('Crea tu token. Prepara su mercado en Raydium.')}
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            {t('Define su identidad, configura una pool y revisa cada firma desde tu wallet. El lanzamiento ocurre en Solana Devnet.')}
          </p>
          </div>
          <div className="wire-home-hero-side" aria-label={t('Red activa: Solana Devnet')}>
            <span className="wire-home-network-mark"><span aria-hidden="true" /></span>
            <span><strong>Solana</strong><small>{t('Red de pruebas')}</small></span>
            <span className="wire-home-network-status">{t('ACTIVA')}</span>
          </div>
        </section>

        <section id="launch-stage" tabIndex={-1} className="mb-14 scroll-mt-8 outline-none" aria-label={t('Etapa para conectar wallet o crear un token')}>
          {connected ? (
            <TokenForm />
          ) : walletCheckComplete && !connecting ? (
            <div className="wire-panel wire-enter rounded-2xl p-5 sm:p-7">
              <div className="wire-panel-topline mb-5">
                <span>WIRE / {t('Crear token').toUpperCase()}</span>
                <span>{t('Esperando wallet')}</span>
              </div>
              <div className="max-w-xl">
                <h2 className="mb-2 font-display text-lg font-semibold text-white sm:text-xl">
                  {t('Conecta tu wallet para empezar')}
                </h2>
                <p className="mb-6 text-sm leading-relaxed text-[var(--muted)]">
                  {t('Puedes usar Phantom, Solflare, Backpack u otra wallet de Solana compatible. La transacción se muestra en la wallet antes de firmar.')}
                </p>
                <WalletConnector />
              </div>
            </div>
          ) : (
            <div className="min-h-[190px]" aria-hidden="true" />
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label={t('Pasos para crear un token')}>
          {FLOW_STEPS.map((item, index) => (
            <article
              key={item.number}
              className="wire-flow-card wire-enter min-h-36 rounded-xl p-5"
              style={{ animationDelay: `${index * 45}ms` }}
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="font-mono text-xs text-[var(--wire-green)]">{item.number} / {t('PASO')}</span>
                <span className="h-px w-10 bg-[var(--line)]" aria-hidden="true" />
              </div>
          <h2 className="mb-2 text-sm font-semibold text-white">{t(item.title)}</h2>
              <p className="text-sm leading-relaxed text-[var(--muted)]">{t(item.description)}</p>
            </article>
          ))}
        </section>

        </>
        )}

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] py-5 text-xs text-[var(--muted)]">
          <span>Wire · Solana Devnet</span>
          <div className="flex flex-wrap items-center gap-3">
            {introReady && !showIntro && <button type="button" onClick={replayIntro} className="wire-button wire-button-quiet min-h-10 text-xs">{t('Ver introducción')}</button>}
            <Link href="/seguridad" className="wire-button wire-button-secondary min-h-10 text-xs">
              <ShieldCheck size={15} aria-hidden="true" />{t('Seguridad y riesgos')}
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
