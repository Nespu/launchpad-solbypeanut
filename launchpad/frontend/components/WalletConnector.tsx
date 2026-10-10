'use client';

import dynamic from 'next/dynamic';

// WalletMultiButton renderiza distinto en el servidor (no sabe si hay wallet
// conectada) que en el navegador (donde sí lo sabe) → eso causa un error de
// hidratación de React. La solución es que este botón NUNCA se renderice en
// el servidor, solo en el cliente, con { ssr: false }.
const WalletMultiButton = dynamic(
  () =>
    import('@solana/wallet-adapter-react-ui').then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export default function WalletConnector() {
  return (
    <WalletMultiButton className="!bg-purple-600 hover:!bg-purple-700 !rounded-lg !h-10 !text-sm" />
  );
}
