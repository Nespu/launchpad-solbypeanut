export type WireToastTone = 'error' | 'success' | 'info';

export type WireToastAction = {
  label: string;
  onClick: () => void;
};

export type WireToastInput = {
  title: string;
  message: string;
  tone?: WireToastTone;
  action?: WireToastAction;
  duration?: number;
};

export function notifyToast(toast: WireToastInput) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WireToastInput>('wire:toast', { detail: toast }));
}

export function userFacingError(error: unknown, fallback: string, translate?: (key: string) => string) {
  const message = error instanceof Error ? error.message : '';

  if (/user rejected|user declined|rejected the request|request rejected/i.test(message)) {
    return translate?.('wallet.error.rejected') ?? 'Rechazaste la solicitud en tu wallet. No se completó la operación.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return translate?.('wallet.error.network') ?? 'No pudimos conectar con el servidor. Comprueba que siga activo e inténtalo de nuevo.';
  }
  if (message === 'Esta wallet no permite firmar mensajes.') return translate?.('wallet.error.signatureUnsupported') ?? message;
  if (message === 'Conecta tu wallet primero.') return translate?.('wallet.error.connectFirst') ?? message;
  if (message === 'No se pudo verificar la wallet.') return translate?.('wallet.error.verify') ?? message;
  if (message === 'No se pudo cerrar la identificación.') return translate?.('wallet.error.signOut') ?? message;

  return message ? (translate?.(message) ?? message) : fallback;
}
