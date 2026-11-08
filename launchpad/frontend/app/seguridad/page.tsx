'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, BadgeCheck, CircleAlert, Coins, KeyRound, ShieldCheck } from 'lucide-react';
import WalletAccountPanel from '../../components/WalletAccountPanel';
import WireHeader from '../../components/WireHeader';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { useWireLocale } from '../../components/LocaleProvider';

const sections = [
  {
    title: 'Firma y wallet',
    body: 'Las operaciones requieren tu aprobación en la wallet conectada. Revisá la red, el importe y los detalles que muestra la wallet antes de firmar. Wire nunca necesita tu frase semilla ni tu clave privada.',
    icon: KeyRound,
  },
  {
    title: 'Autoridades del token',
    body: 'Durante la creación podés elegir revocar las autoridades de mint, freeze y actualización de metadata. Solo se revocan las opciones que seleccionás; revisá el formulario y la transacción antes de aprobarla. Revocar una autoridad no garantiza el valor ni la seguridad económica del token.',
    icon: BadgeCheck,
  },
  {
    title: 'Fees y liquidez',
    body: 'Antes de firmar, el formulario muestra el fee de plataforma según la configuración vigente y las opciones de seguridad elegidas. La comisión de red se muestra por separado en la wallet. Cada proveedor puede retirar hasta el 100% de sus propios LP, por lo que la liquidez puede reducirse o desaparecer. Retirar los LP no elimina la pool ni sus cuentas de Solana.',
    icon: Coins,
  },
];

export default function SecurityPage() {
  const { t } = useWireLocale();
  return (
    <main className="wire-shell min-h-screen px-4 py-4 sm:px-6 md:px-8 md:py-8">
      <div className="wire-container">
        <WireHeader className="mb-12">
          <Link href="/" className="flex min-h-11 items-center gap-3 rounded-md" aria-label={t('Wire, inicio')}>
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--wire-green)]"><ShieldCheck size={19} aria-hidden="true" /></span>
            <span><span className="block font-display text-lg font-semibold leading-none text-white">wire</span><span className="mt-1 block text-xs text-[var(--muted)]">{t('Centro de seguridad')}</span></span>
          </Link>
          <nav className="wire-header-actions" aria-label={t('Navegación de seguridad')}>
            <LanguageSwitcher />
            <Link href="/" className="wire-button wire-button-quiet"><ArrowLeft size={15} aria-hidden="true" />{t('Volver al launcher')}</Link>
            <WalletAccountPanel />
          </nav>
        </WireHeader>

        <section className="mx-auto w-full max-w-5xl" aria-labelledby="security-title">
          <header className="wire-security-hero">
            <span className="wire-security-hero-icon"><ShieldCheck size={25} aria-hidden="true" /></span>
            <p className="wire-kicker mt-5">{t('WIRE · INFORMACIÓN PARA DECIDIR')}</p>
            <h1 id="security-title" className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-5xl">{t('Seguridad y riesgos')}</h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--muted)] sm:text-base">{t('Antes de firmar, revisa qué autoriza cada transacción. Aquí tienes un resumen claro de las operaciones y los riesgos del entorno Devnet.')}</p>
          </header>

          <div className="wire-security-grid mt-8">
            {sections.map(({ title, body, icon: Icon }) => (
              <article key={title} className="wire-security-card">
                <span className="wire-security-card-icon"><Icon size={19} aria-hidden="true" /></span>
                <h2>{t(title)}</h2>
                <p>{t(body)}</p>
              </article>
            ))}
          </div>

          <aside className="wire-risk-notice mt-4" aria-label={t('Aviso de riesgo')}>
            <CircleAlert size={20} aria-hidden="true" />
            <div><h2>{t('Los activos digitales implican riesgos')}</h2><p>{t('Crear un token o una pool no garantiza demanda, precio, liquidez ni la recuperación de fondos. Verifica las direcciones y cada transacción en la red correspondiente. Esta información no es asesoramiento financiero ni legal.')}</p></div>
          </aside>

          <section id="guia-rapida" className="mt-10 border-t border-[var(--line)] pt-8" aria-labelledby="quick-guide-title">
            <h2 id="quick-guide-title" className="font-display text-xl font-semibold sm:text-2xl">{t('footer.guide')}</h2>
            <ol className="mt-3 divide-y divide-[var(--line)]">
              <li className="grid gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div>
                  <h3 className="font-semibold">{t('Wallet conectada, pools invisibles')}</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Tener la wallet conectada no inicia sesión en Wire. Abre el panel Wallet y pulsa «Iniciar sesión con firma»; es una firma gratuita, no envía SOL. Después se cargarán aquí las pools y actividad de esta dirección.')}</p>
                </div>
                <Link href="/manage-liquidity" className="wire-button wire-button-secondary min-h-10 w-fit px-3 text-xs">{t('Administrar liquidez')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="grid gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div>
                  <h3 className="font-semibold">{t('Token creado; tu pool sigue pendiente')}</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Si cerraste el aviso, vuelve al launcher con la misma wallet: el último resultado de creación se conserva en este navegador. Desde ahí puedes crear la pool, abrir los detalles o ver la transacción.')}</p>
                </div>
                <Link href="/" className="wire-button wire-button-secondary min-h-10 w-fit px-3 text-xs">{t('Volver al launcher')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('Antes de firmar')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Consulta el fee de plataforma en el resumen del formulario. La comisión de red se muestra aparte en tu wallet; revisa red e importes antes de aprobar.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Tengo que comprar mi propio token?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('No. Comprar o vender es opcional y sirve para intercambiar usando el mercado disponible. Una compra propia no demuestra interés de otros usuarios ni garantiza precio o volumen.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Cómo enviar tokens a varias wallets?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Token Disperse transfiere tokens que ya tienes a direcciones públicas o wallets de proyecto. No compra, vende ni genera volumen de mercado. Puedes elegir la wallet conectada o una wallet de la bóveda como origen. Antes de cada firma, revisa destinatarios, cantidades, SOL opcional, rent de cuentas y fees. Cada lote requiere aprobación manual en tu wallet. La pausa solo habilita la siguiente revisión; no firma ni envía. Si una firma queda pendiente o el resultado es incierto, verifica su estado en Explorer; Wire no reenvía esa transacción automáticamente.')}</p>
                <Link href="/wallets" className="wire-button wire-button-secondary mt-3 min-h-11 w-fit px-3 text-xs">{t('Mis wallets')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Por qué aparece saldo LP cero?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('El saldo LP corresponde a la wallet consultada. Cero LP significa que esa dirección no tiene una posición retirable; no significa que el mercado o toda la pool hayan desaparecido. Comprueba la wallet y abre la dirección en Explorer.')}</p>
                <Link href="/manage-liquidity" className="wire-button wire-button-secondary mt-3 min-h-10 w-fit px-3 text-xs">{t('Administrar liquidez')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué significa quemar tokens LP?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Los tokens LP representan tu parte en una pool. Quemarlos los destruye permanentemente: no retira ni devuelve los activos. Para recuperar esos activos, usa Retirar liquidez. Antes de firmar, verifica la wallet, la pool, la cantidad y la tarifa estimada. Una quema confirmada no se puede deshacer.')}</p>
                <Link href="/manage-liquidity" className="wire-button wire-button-secondary mt-3 min-h-10 w-fit px-3 text-xs">{t('Administrar liquidez')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué pasa al bloquear LP durante 180 días?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Streamflow guarda los LP en un escrow hasta la fecha indicada. Durante ese plazo no podrás retirarlos ni usarlos para salir de la pool. La revisión muestra el fee en LP, el cargo del proveedor y el SOL estimado antes de firmar. Al vencer, conecta la misma wallet en Streamflow para reclamarlos. Wire no puede cancelar ni acelerar el bloqueo; revisa wallet, pool, cantidad, fecha y cargos. Bloquear no es lo mismo que quemar LP.')}</p>
                <Link href="/manage-liquidity" className="wire-button wire-button-secondary mt-3 min-h-10 w-fit px-3 text-xs">{t('Administrar liquidez')}<ArrowRight size={14} aria-hidden="true" /></Link>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué mercado usa un token de Pump.fun?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Antes de graduarse, los intercambios se cotizan en la curva de Pump.fun. Después pueden usar la pool PumpSwap. Wire consulta una cotización de ejemplo y muestra el mercado que respondió; revisa la cotización vigente y cada firma antes de operar.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Por qué el historial sigue pendiente después de confirmar?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('La confirmación de Devnet y el registro en el historial son pasos separados. «Reintentar historial» verifica y guarda la misma firma; no vuelve a enviar ni repetir el swap. Si la firma todavía no está confirmada, compruébala en Explorer y usa «Verificar firma» antes de preparar otra operación.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿La cotización es un precio garantizado?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('No. Es una estimación del estado actual de la pool en Devnet. Puede cambiar antes de firmar, no es un historial de precios ni garantiza que la operación se complete.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué hace la vigilancia del mercado?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Consulta una cotización pequeña de referencia cada 30 segundos mientras el panel está abierto. Si lo activas con el vault desbloqueado, al aparecer el mercado Wire vuelve a cotizar cada wallet y prepara una revisión. No firma ni envía; revisas y apruebas cada operación por separado.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué autoriza Timed Buys?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Timed Buys requiere una autorización nueva para cada secuencia. Antes de iniciarla, revisa todas las wallets y direcciones, cantidades, cotizaciones, slippage, fees, límite agregado, pausa y límite de fallos consecutivos confirmados. Al pulsar Iniciar, autorizas a la bóveda local a firmar y enviar esas compras por separado en Devnet mientras la página siga abierta. Una cotización fuera de los límites, un fallo de conexión, una firma incierta, una wallet pendiente, el bloqueo de la bóveda o el cierre de la página detienen la secuencia; los fallos confirmados solo permiten pasar a la siguiente wallet hasta el límite autorizado. Wire no reintenta automáticamente una wallet fallida ni continúa después de recargar. Tus compras no son demanda de terceros.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué hace el disparador de compra al abrir el mercado?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('El disparador funciona solo en Devnet, tras una autorización independiente para la lista visible de wallets, sus importes, el tope total, el slippage, la espera, el límite de fallos consecutivos y la reserva de 0.02 SOL por wallet. Durante 15 minutos consulta el mercado cada 5 segundos. Al encontrar una cotización válida, prepara la secuencia y Timed Buys firma y envía sin otra aprobación manual; el precio, la salida y las comisiones exactas no se conocen al armarlo. Ocultar la página, bloquear la bóveda, cerrar o recargar cancela la espera y no se reanuda. Una cotización fuera de límites, un fallo de conexión, una firma incierta o una wallet pendiente detienen la secuencia; los fallos confirmados solo permiten pasar a la siguiente wallet hasta el límite autorizado. Wire no reintenta automáticamente una wallet fallida. Tus compras no representan demanda de terceros.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Cómo reintento una compra fallida?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Wire no repite automáticamente una compra fallida. Puedes re-cotizar esa wallet para revisar una nueva transacción, importe y comisión; la wallet vuelve a estado revisado y exige una nueva autorización antes de firmar. Si una firma sigue pendiente o incierta, primero verifica su estado en Explorer; Wire bloquea el reintento mientras exista una firma pendiente.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué puedo cancelar de una secuencia?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Puedes cancelar las wallets que siguen revisadas pero no se han firmado ni enviado. Una transacción firmada o enviada no se puede retirar de Solana; verifica su firma en Explorer y no la reenvíes mientras su estado sea incierto.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Qué significa PnL parcial?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Wire calcula el PnL realizado FIFO solo con costos conocidos y actividad compatible. El escaneo incluye swaps cargados y cuentas abiertas o ATA canónicas de esos mints; mints sin cargar, cuentas no asociadas cerradas y operaciones no compatibles pueden faltar. Un costo desconocido no se cuenta como ganancia.')}</p>
              </li>
              <li className="py-5">
                <h3 className="font-semibold">{t('¿Cómo registra Wire los depósitos y retiros de liquidez?')}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Wire reconoce movimientos de LP solo en pools Raydium registradas cuando los datos de la transacción coinciden. El inventario refleja el depósito o retiro, pero la base de costo queda desconocida, así que el PnL puede seguir parcial. Esto no valora tu posición ni significa que la pool haya desaparecido.')}</p>
              </li>
            </ol>
          </section>
        </section>
      </div>
    </main>
  );
}
