/** Every booking page says plainly that this is a fictional demo. */
export function DemoBanner() {
  return (
    <aside
      aria-label="Demo notice"
      className="border-l-8 border-bottle bg-hivis px-4 py-3 font-bold text-bottle"
    >
      Fictional demo: Quillwheel Cycle Works is not a real business. Nothing
      here is real, and no personal details are collected or stored.
    </aside>
  );
}
