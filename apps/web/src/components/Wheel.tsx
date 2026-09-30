const SPOKES = 24;
const HUB_RADIUS = 18;
const RIM_RADIUS = 168;

const spokes = Array.from({ length: SPOKES }, (_, index) => {
  const angle = (index / SPOKES) * Math.PI * 2;
  return {
    x1: (200 + Math.cos(angle) * HUB_RADIUS).toFixed(2),
    y1: (200 + Math.sin(angle) * HUB_RADIUS).toFixed(2),
    x2: (200 + Math.cos(angle) * RIM_RADIUS).toFixed(2),
    y2: (200 + Math.sin(angle) * RIM_RADIUS).toFixed(2),
  };
});

/** Decorative spoked wheel for the hero. Hidden from assistive technology. */
export function Wheel({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 400 400"
      className={`wheel-turn ${className}`}
      fill="none"
      stroke="currentColor"
    >
      <circle cx="200" cy="200" r="188" strokeWidth="16" />
      <circle cx="200" cy="200" r={RIM_RADIUS} strokeWidth="4" />
      {spokes.map((spoke) => (
        <line key={`${spoke.x2}-${spoke.y2}`} {...spoke} strokeWidth="2" />
      ))}
      <circle
        cx="200"
        cy="200"
        r={HUB_RADIUS}
        strokeWidth="8"
        fill="var(--color-celeste)"
      />
    </svg>
  );
}
