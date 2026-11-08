'use client';

import { Download, Share2 } from 'lucide-react';
import { useState } from 'react';
import { useWireLocale } from './LocaleProvider';
import { notifyToast, userFacingError } from './toastEvents';

type ShareToken = {
  mintAddress: string;
  name: string;
  symbol: string;
  imageUrl: string;
};

type RenderedCard = { blob: Blob; includesLogo: boolean };

function loadLogo(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Token image could not be loaded'));
    image.src = url;
  });
}

async function renderShareCard(token: ShareToken): Promise<RenderedCard> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');

  const background = context.createLinearGradient(0, 0, 1200, 630);
  background.addColorStop(0, '#101a12');
  background.addColorStop(1, '#070a08');
  context.fillStyle = background;
  context.fillRect(0, 0, 1200, 630);
  context.strokeStyle = 'rgba(124, 255, 92, .18)';
  context.lineWidth = 2;
  context.strokeRect(32, 32, 1136, 566);

  context.fillStyle = '#7cff5c';
  context.font = '700 24px Arial, sans-serif';
  context.fillText('WIRE  ·  SOLANA DEVNET', 72, 92);
  context.fillStyle = '#e8f0e9';
  const title = token.name.trim().slice(0, 32) || 'Wire token';
  let titleSize = 58;
  context.font = `700 ${titleSize}px Arial, sans-serif`;
  while (titleSize > 34 && context.measureText(title).width > 650) {
    titleSize -= 2;
    context.font = `700 ${titleSize}px Arial, sans-serif`;
  }
  context.fillText(title, 72, 210, 650);
  context.fillStyle = '#9eada1';
  context.font = '600 30px Arial, sans-serif';
  context.fillText(`$${token.symbol.slice(0, 12)}`, 76, 260);

  let includesLogo = false;
  if (token.imageUrl) {
    try {
      const logo = await loadLogo(token.imageUrl);
      context.save();
      context.beginPath();
      context.arc(930, 300, 142, 0, Math.PI * 2);
      context.clip();
      context.drawImage(logo, 788, 158, 284, 284);
      context.restore();
      includesLogo = true;
    } catch {
      // The preview can still be shared when a public image host blocks canvas access.
    }
  }

  if (!includesLogo) {
    context.beginPath();
    context.arc(930, 300, 142, 0, Math.PI * 2);
    context.fillStyle = 'rgba(124, 255, 92, .1)';
    context.fill();
    context.strokeStyle = 'rgba(124, 255, 92, .5)';
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = '#7cff5c';
    context.font = '700 112px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText((token.symbol || token.name || 'W').slice(0, 1).toUpperCase(), 930, 300);
    context.textAlign = 'start';
    context.textBaseline = 'alphabetic';
  }

  context.fillStyle = '#839087';
  context.font = '500 19px monospace';
  context.fillText('MINT', 72, 500);
  context.fillStyle = '#dce5dd';
  context.font = '500 20px monospace';
  context.fillText(token.mintAddress, 72, 535, 1030);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not export card')), 'image/png');
  });
  return { blob, includesLogo };
}

export default function ShareTokenCard({ token }: { token: ShareToken }) {
  const { t } = useWireLocale();
  const [busy, setBusy] = useState<'download' | 'share' | null>(null);
  const shareUrl = typeof window === 'undefined' ? '' : window.location.href;

  const getFileName = () => `${token.symbol.replace(/[^a-z0-9-_]/gi, '').slice(0, 24) || 'wire-token'}-devnet.png`;

  const downloadCard = async () => {
    setBusy('download');
    try {
      const { blob, includesLogo } = await renderShareCard(token);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = getFileName();
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      notifyToast({
        title: t('Tarjeta descargada'),
        message: includesLogo ? t('La imagen incluye el logo y datos públicos del token.') : t('El servidor de imágenes no permitió exportar el logo; la tarjeta incluye el símbolo y los datos públicos.'),
      });
    } catch (error) {
      notifyToast({ title: t('No se pudo descargar la tarjeta'), message: userFacingError(error, t('Inténtalo de nuevo.'), t) });
    } finally {
      setBusy(null);
    }
  };

  const shareCard = async () => {
    setBusy('share');
    try {
      const rendered = await renderShareCard(token);
      const file = new File([rendered.blob], getFileName(), { type: 'image/png' });
      const shareData = {
        title: `${token.name} (${token.symbol})`,
        text: `${t('Token creado en Solana Devnet')} · ${shareUrl}`,
        files: [file],
      };
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share(shareData);
      } else if (navigator.share) {
        await navigator.share({ title: shareData.title, text: shareData.text });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        notifyToast({ title: t('Enlace copiado'), message: t('Comparte este enlace para abrir la ficha pública del token.') });
      }
      if (!rendered.includesLogo && navigator.share) {
        notifyToast({ title: t('Tarjeta compartida'), message: t('El servidor de imágenes no permitió exportar el logo; se compartieron el símbolo y los datos públicos.') });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      notifyToast({ title: t('No se pudo compartir'), message: userFacingError(error, t('Inténtalo de nuevo.'), t) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="wire-share-section" aria-labelledby="share-token-heading">
      <div className="wire-share-preview" aria-hidden="true">
        <div className="wire-share-preview-copy">
          <span>WIRE <i /> SOLANA DEVNET</span>
          <strong>{token.name}</strong>
          <small>${token.symbol}</small>
          <code>{token.mintAddress}</code>
        </div>
        {token.imageUrl ? (
          <img src={token.imageUrl} alt="" className="wire-share-preview-image" />
        ) : (
          <span className="wire-share-preview-symbol">{(token.symbol || token.name || 'W').slice(0, 1).toUpperCase()}</span>
        )}
      </div>
      <div className="wire-share-actions">
        <h3 id="share-token-heading">{t('Comparte tu token')}</h3>
        <p>{t('Descarga una tarjeta con el logo y los datos públicos, o comparte la ficha del token.')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="wire-button wire-button-primary" onClick={downloadCard} disabled={busy !== null}>
            <Download size={16} aria-hidden="true" />{busy === 'download' ? t('Generando tarjeta…') : t('Descargar tarjeta PNG')}
          </button>
          <button type="button" className="wire-button wire-button-secondary" onClick={shareCard} disabled={busy !== null}>
            <Share2 size={16} aria-hidden="true" />{busy === 'share' ? t('Preparando para compartir…') : t('Compartir')}
          </button>
        </div>
      </div>
    </section>
  );
}
