import { useState } from 'react';

/** Token image with a monogram fallback when there is no image or it fails to load. */
export function TokenAvatar({ image, symbol, size = 36 }: { image: string | null; symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.36)) };
  if (image && !failed) {
    return <img className="avatar" src={image} alt="" width={size} height={size} style={style} loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <span className="avatar avatar--mono" style={style} aria-hidden="true">
      {symbol.replace(/^\$/, '').slice(0, 2).toUpperCase() || '?'}
    </span>
  );
}
