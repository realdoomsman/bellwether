import { useState } from 'react';

/**
 * Token image over a monogram. The monogram shows while the image loads, stays if there is no
 * image or it fails, and the box is sized up front so nothing shifts when the image arrives.
 */
export function TokenAvatar({ image, symbol, size = 36 }: { image: string | null; symbol: string; size?: number }) {
  // Keyed by URL so a new image (e.g. navigating between tokens) starts from the monogram again.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.36)) };
  const isLoaded = image !== null && loaded === image;
  return (
    <span className={`avatar avatar--mono ${isLoaded ? 'is-loaded' : ''}`} style={style} aria-hidden="true">
      <span className="avatar__mono">{symbol.replace(/^\$/, '').slice(0, 2).toUpperCase() || '?'}</span>
      {image && failed !== image && (
        <img
          className="avatar__img"
          src={image}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(image)}
          onError={() => setFailed(image)}
        />
      )}
    </span>
  );
}
