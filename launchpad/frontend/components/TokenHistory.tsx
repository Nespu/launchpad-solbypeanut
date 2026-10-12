   'use client';

   import { useEffect, useState } from 'react';
   import Link from 'next/link';
   import { useWallet } from '@solana/wallet-adapter-react';

   type CreatedToken = {
     mintAddress: string;
     name: string;
     symbol: string;
     imageUrl: string;
     poolAddress: string | null;
     status: string;
     createdAt: string;
   };

   const STATUS_LABELS: Record<string, string> = {
     completed: 'Completado',
     processing: 'Procesando',
     pending: 'Pendiente',
     failed: 'Fallido',
   };

   const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

   export default function TokenHistory() {
     const { publicKey } = useWallet();
     const [tokens, setTokens] = useState<CreatedToken[]>([]);
     const [loading, setLoading] = useState(false);
     const [error, setError] = useState('');

     useEffect(() => {
       let active = true;
       if (!publicKey) {
         setTokens([]);
         setError('');
         setLoading(false);
         return () => { active = false; };
       }

       setLoading(true);
       setError('');
       const wallet = encodeURIComponent(publicKey.toBase58());
       fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/my-tokens?userWallet=${wallet}`)
         .then(async (response) => {
           const data = await response.json();
           if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar tus tokens.');
           return data.tokens as CreatedToken[];
         })
         .then((data) => { if (active) setTokens(data); })
         .catch((err: unknown) => {
           if (active) setError(err instanceof Error ? err.message : 'No se pudieron cargar tus tokens.');
         })
         .finally(() => { if (active) setLoading(false); });

       return () => { active = false; };
     }, [publicKey]);

     return (
       <section className="max-w-4xl mx-auto mt-10">
         <div className="mb-5">
           <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>HISTORIAL</div>
           <h2 className="font-display text-xl mb-2">Tokens creados</h2>
           <p className="text-sm text-[var(--muted)]">Tokens registrados para la wallet conectada.</p>
         </div>

         {!publicKey ? (
           <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Conecta tu wallet para ver el historial.</div>
         ) : loading ? (
           <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Cargando tokens...</div>
         ) : error ? (
           <div className="glass-card p-6 rounded-2xl text-sm text-red-400">{error}</div>
         ) : tokens.length === 0 ? (
           <div className="glass-card p-6 text-center rounded-2xl text-sm text-[var(--muted)]">Todavía no hay tokens registrados para esta wallet.</div>
         ) : (
           <div className="space-y-4">
             {tokens.map((token) => (
               <article key={token.mintAddress} className="glass-card rounded-2xl p-5">
                 <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                   {token.imageUrl ? <img src={token.imageUrl} alt={token.name} className="w-12 h-12 rounded-full object-cover" /> : null}
                   <div className="flex-1 min-w-0">
                     <h3 className="font-display font-semibold">{token.name} ({token.symbol})</h3>
                     <p className="text-xs text-[var(--muted)] mt-1">
                       {new Date(token.createdAt).toLocaleString()} · {token.poolAddress && token.poolAddress !== 'pending' ? 'Pool creada' : 'Sin pool'} · {statusLabel(token.status)}
                     </p>
                   </div>
                   <Link href={`/token/${token.mintAddress}`} className="py-2.5 px-4 rounded-lg font-medium text-sm text-center wire-input">
                     Ver token
                   </Link>
                 </div>
               </article>
             ))}
           </div>
         )}
       </section>
     );
   }
