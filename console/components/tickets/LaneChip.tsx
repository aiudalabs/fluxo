"use client";

// LaneChip — el "assignee" de una story: el agente/lane responsable (owner).
// Color determinista por nombre de lane, avatar con la inicial. Es la cue de
// escaneo nº1 en JIRA/Linear; antes el owner no se mostraba en ningún lado.

// Paleta = roles MD3 (flipean con el tema). Los dos hex fijos que había acá
// (violeta/teal) desaparecían sobre el scheme dark.
const LANE_COLORS: [string, string][] = [
  ["var(--md-tertiary)", "var(--navy-soft)"],
  ["var(--md-success)", "var(--emerald-soft)"],
  ["var(--md-warning)", "var(--amber-soft)"],
  ["var(--md-error)", "var(--danger-soft)"],
  ["var(--md-on-surface-variant)", "color-mix(in srgb, var(--md-on-surface-variant) 12%, transparent)"],
  ["var(--md-primary)", "var(--accent-soft)"],
];

function laneColor(lane: string): [string, string] {
  let h = 0;
  for (let i = 0; i < lane.length; i++) h = (h * 31 + lane.charCodeAt(i)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

export function LaneChip({ lane, title }: { lane: string; title?: string }) {
  const [color, soft] = laneColor(lane);
  return (
    <span className="lane-chip" style={{ color, background: soft }} title={title ?? lane}>
      <span className="lane-avatar" style={{ background: color }}>
        {lane.slice(0, 1).toUpperCase()}
      </span>
      {lane}
    </span>
  );
}
