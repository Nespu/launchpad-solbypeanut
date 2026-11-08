'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { walletDisplayName } from '../lib/walletAdapterNames';

type WalletIdentityContextValue = {
  identifiedWallet: string | null;
  walletProviderName: string | null;
  balanceSol: number | null;
  balanceUpdatedAt: number | null;
  balanceLoading: boolean;
  loading: boolean;
  error: string;
  identifyWallet: () => Promise<void>;
  clearWalletIdentity: () => Promise<void>;
};

const WalletIdentityContext = createContext<WalletIdentityContextValue | null>(null);
const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';

async function responseData<T extends { success?: boolean; error?: string } = { success?: boolean; error?: string }>(response: Response): Promise<T> {
  let data: T;
  try {
    data = await response.json() as T;
  } catch {
    throw new Error('La API de Wire respondió con un formato inesperado. Revisa NEXT_PUBLIC_API_URL y la ruta /api/auth.');
  }
  const payload = data as { success?: boolean; error?: string };
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || `La API de Wire respondió con HTTP ${response.status}.`);
  }
  return data;
}

export function WalletIdentityProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const { publicKey, signMessage, wallet } = useWallet();
  const [identifiedWallet, setIdentifiedWallet] = useState<string | null>(null);
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const walletAddress = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!publicKey) {
      setBalanceSol(null);
      setBalanceUpdatedAt(null);
      setBalanceLoading(false);
      return;
    }

    let active = true;
    setBalanceSol(null);
    setBalanceUpdatedAt(null);
    setBalanceLoading(true);
    const refreshBalance = async () => {
      try {
        const lamports = await connection.getBalance(publicKey, 'confirmed');
        if (active) {
          setBalanceSol(lamports / 1_000_000_000);
          setBalanceUpdatedAt(Date.now());
          setBalanceLoading(false);
        }
      } catch {
        if (active) setBalanceLoading(false);
      }
    };

    void refreshBalance();
    let subscriptionId: number | undefined;
    try {
      subscriptionId = connection.onAccountChange(
        publicKey,
        (accountInfo) => {
          if (!active) return;
          setBalanceSol(accountInfo.lamports / 1_000_000_000);
          setBalanceUpdatedAt(Date.now());
          setBalanceLoading(false);
        },
        'confirmed',
      );
    } catch {
      // The periodic RPC refresh below still updates the display if WebSocket is unavailable.
    }
    const intervalId = window.setInterval(() => void refreshBalance(), 15_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      if (subscriptionId !== undefined) void connection.removeAccountChangeListener(subscriptionId);
    };
  }, [connection, publicKey]);

  useEffect(() => {
    let active = true;
    setError('');
    if (!walletAddress) {
      setIdentifiedWallet(null);
      return () => { active = false; };
    }

    const refreshIdentity = () => {
      fetch(`${apiUrl}/api/auth/session`, { credentials: 'include', cache: 'no-store' })
        .then((response) => responseData<{ success: boolean; authenticated: boolean; wallet: string }>(response))
        .then((data) => {
          if (active) setIdentifiedWallet(data.authenticated && data.wallet === walletAddress ? data.wallet : null);
        })
        .catch(() => { if (active) setIdentifiedWallet(null); });
    };
    refreshIdentity();
    window.addEventListener('wire:wallet-session-changed', refreshIdentity);

    return () => {
      active = false;
      window.removeEventListener('wire:wallet-session-changed', refreshIdentity);
    };
  }, [walletAddress]);

  const identifyWallet = useCallback(async () => {
    if (!publicKey) throw new Error('Conecta tu wallet primero.');
    if (!signMessage) throw new Error('Esta wallet no permite firmar mensajes.');

    setLoading(true);
    setError('');
    try {
      const wallet = publicKey.toBase58();
      const challengeResponse = await fetch(`${apiUrl}/api/auth/challenge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      const challenge = await responseData<{ success: boolean; message: string }>(challengeResponse);
      const signatureBytes = await signMessage(new TextEncoder().encode(challenge.message));
      const signatureBase64 = btoa(Array.from(signatureBytes, (byte) => String.fromCharCode(byte)).join(''));
      const verifyResponse = await fetch(`${apiUrl}/api/auth/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, message: challenge.message, signature: signatureBase64 }),
      });
      const verified = await responseData<{ success: boolean; wallet: string }>(verifyResponse);
      setIdentifiedWallet(verified.wallet);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'No se pudo verificar la wallet.';
      setError(message);
      throw caught;
    } finally {
      setLoading(false);
    }
  }, [publicKey, signMessage]);

  const clearWalletIdentity = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiUrl}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      await responseData(response);
      setIdentifiedWallet(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'No se pudo cerrar la identificación.';
      setError(message);
      throw caught;
    } finally {
      setLoading(false);
    }
  }, []);

  const value = useMemo(() => ({
    identifiedWallet,
    walletProviderName: walletDisplayName(wallet?.adapter.name),
    balanceSol,
    balanceUpdatedAt,
    balanceLoading,
    loading,
    error,
    identifyWallet,
    clearWalletIdentity,
  }), [identifiedWallet, wallet, balanceSol, balanceUpdatedAt, balanceLoading, loading, error, identifyWallet, clearWalletIdentity]);

  return <WalletIdentityContext.Provider value={value}>{children}</WalletIdentityContext.Provider>;
}

export function useWalletIdentity() {
  const context = useContext(WalletIdentityContext);
  if (!context) throw new Error('useWalletIdentity must be used inside WalletIdentityProvider');
  return context;
}
