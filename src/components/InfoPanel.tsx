'use client';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function InfoPanel({
  title,
  description,
  url,
  onDismiss,
}: {
  title: string;
  description: string;
  url: string;
  onDismiss: () => void;
}) {
  return (
    <div className="info-panel" role="status">
      <div className="info-panel-corner tl" />
      <div className="info-panel-corner tr" />
      <div className="info-panel-corner bl" />
      <div className="info-panel-corner br" />
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="info-panel-close">
        ×
      </button>
      <div className="info-panel-title">{title}</div>
      {description && <p className="info-panel-desc">{description}</p>}
      <a href={url} target="_blank" rel="noopener noreferrer" className="info-panel-link">
        {hostnameOf(url)} ↗
      </a>
    </div>
  );
}
