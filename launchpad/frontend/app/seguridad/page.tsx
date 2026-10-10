import Link from 'next/link';

const sections = [
  {
    title: 'Firma y wallet',
    body: 'Las operaciones requieren tu aprobación en la wallet conectada. Revisá la red, el importe y los detalles que muestra la wallet antes de firmar. Wire nunca necesita tu frase semilla ni tu clave privada.',
  },
  {
    title: 'Autoridades del token',
    body: 'Durante la creación podés elegir revocar las autoridades de mint, freeze y actualización de metadata. Solo se revocan las opciones que seleccionás; revisá el formulario y la transacción antes de aprobarla. Revocar una autoridad no garantiza el valor ni la seguridad económica del token.',
  },
  {
    title: 'Fees y liquidez',
    body: 'Antes de firmar, el formulario muestra el fee de plataforma según la configuración vigente y las opciones de seguridad elegidas. La comisión de red se muestra por separado en la wallet. La liquidez se aporta al crear la pool; el límite de 95% aplica a cada retiro y no garantiza que quede liquidez permanente, ya que se pueden hacer retiros adicionales.',
  },
  {
    title: 'Riesgos',
    body: 'Crear un token o una pool no garantiza demanda, precio, liquidez ni posibilidad de recuperar fondos. Los activos digitales pueden perder todo su valor. Verificá las direcciones y las transacciones en la red correspondiente. La información de esta página no es asesoramiento financiero ni legal.',
  },
];

export default function SecurityPage() {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <Link href="/" className="text-sm text-[var(--muted)] hover:text-white">← Volver a Wire</Link>
        <header className="mt-8 mb-8">
          <div className="text-xs font-mono mb-2" style={{ color: 'var(--wire-green)' }}>WIRE</div>
          <h1 className="text-3xl font-display font-semibold mb-3">Seguridad y riesgos</h1>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Información sobre las firmas, las autoridades y los fees del flujo actual. Revisá cada operación en tu wallet antes de aprobarla.
          </p>
        </header>

        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.title} className="glass-card rounded-xl p-5 md:p-6">
              <h2 className="font-semibold mb-2">{section.title}</h2>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{section.body}</p>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
