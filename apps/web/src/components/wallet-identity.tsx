import { useEffect, useId, useState } from "react";
import { chainLogo } from "../lib/chain-logos";

/** The address's bytes, as numbers 0–255: the seed for its avatar. */
const bytesOf = (address: string) =>
  Array.from({ length: 12 }, (_, i) => parseInt(address.slice(2 + i * 2, 4 + i * 2), 16) || 0);

/**
 * A soft gradient orb drawn from the address: two or three saturated colours blended with a blur
 * and a highlight, so two wallets look different at a glance and none look flat. When the wallet
 * app's own icon is known (Talisman, Phantom, Rabby…) it sits on the orb as a small badge.
 */
export function WalletAvatar({
  address,
  size = 28,
  walletIcon,
  walletName,
}: {
  address: string;
  size?: number;
  walletIcon?: string;
  walletName?: string;
}) {
  const id = useId().replace(/:/g, "");
  const b = bytesOf(address.toLowerCase());
  const h1 = (b[0]! / 255) * 360;
  const h2 = h1 + 50 + (b[1]! % 110);
  const h3 = h1 + 160 + (b[2]! % 80);
  const c1 = `hsl(${h1} 82% 58%)`;
  const c2 = `hsl(${h2} 88% 56%)`;
  const c3 = `hsl(${h3} 80% 66%)`;
  const turn = (b[3]! / 255) * 360;
  const blob1 = { x: 8 + (b[4]! % 24), y: 8 + (b[5]! % 24), r: 11 + (b[6]! % 8) };
  const blob2 = { x: 6 + (b[7]! % 28), y: 6 + (b[8]! % 28), r: 7 + (b[9]! % 6) };
  const badge = Math.round(size * 0.42);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="block">
        <defs>
          <linearGradient id={`${id}g`} gradientTransform={`rotate(${turn} .5 .5)`}>
            <stop offset="0" stopColor={c1} />
            <stop offset="1" stopColor={c2} />
          </linearGradient>
          <radialGradient id={`${id}h`} cx=".3" cy=".25" r=".6">
            <stop offset="0" stopColor="#fff" stopOpacity=".45" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}b`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <clipPath id={`${id}c`}>
            <circle cx="20" cy="20" r="20" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}c)`}>
          <rect width="40" height="40" fill={`url(#${id}g)`} />
          <circle cx={blob1.x} cy={blob1.y} r={blob1.r} fill={c3} filter={`url(#${id}b)`} />
          <circle
            cx={blob2.x}
            cy={blob2.y}
            r={blob2.r}
            fill={`hsl(${h2 + 30} 90% 78%)`}
            opacity=".8"
            filter={`url(#${id}b)`}
          />
          <rect width="40" height="40" fill={`url(#${id}h)`} />
        </g>
        <circle cx="20" cy="20" r="19.5" fill="none" stroke="#fff" strokeOpacity=".14" />
      </svg>
      {walletIcon && (
        <img
          src={walletIcon}
          alt={walletName ? `${walletName}` : ""}
          width={badge}
          height={badge}
          className="absolute -right-0.5 -bottom-0.5 rounded-[30%] bg-surface ring-2 ring-surface"
          style={{ width: badge, height: badge }}
        />
      )}
    </span>
  );
}

/** A network's logo, or a lettered disc when there's no logo for it. */
export function NetworkLogo({
  chainId,
  name,
  size = 16,
}: {
  chainId: number | undefined;
  name?: string;
  size?: number;
}) {
  const src = chainLogo(chainId);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken)
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/12 font-mono text-soft"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.5) }}
    >
      {(name ?? "?")
        .replace(/^Chain\s+/, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

type WithIcons = {
  icon?: string;
  rkDetails?: { iconUrl?: string | (() => Promise<string>) };
};

/** The wallet app's own icon: from EIP-6963 discovery, or RainbowKit's wallet list. */
export function useWalletIcon(connector: WithIcons | undefined | null): string | undefined {
  const direct =
    connector?.icon ??
    (typeof connector?.rkDetails?.iconUrl === "string" ? connector.rkDetails.iconUrl : undefined);
  const lazy =
    typeof connector?.rkDetails?.iconUrl === "function" ? connector.rkDetails.iconUrl : undefined;
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (direct || !lazy) return;
    let live = true;
    void lazy()
      .then((url) => live && setLoaded(url))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [direct, lazy]);
  return direct?.trim() || loaded;
}
