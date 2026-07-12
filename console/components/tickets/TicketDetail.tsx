"use client";

// TicketDetail (F6P-05) · el drawer JIRA de v1, PORTADO: la STORY (no su ejecución) —
// id/sprint/epic, lane+repo, banner de agente-perdido, descripción, criterios de
// aceptación, dependencias clickeables (navegan el grafo sin cerrar), y los links a
// PR/sesión/run. Recuperación de una story `failed`: reencolar.
//
// Data re-point vs v1: las acciones van directo a Supabase (RLS). El reencolado usa la
// transición LEGAL de v2 failed→ready (v2 no tiene failed→backlog; ready la vuelve a
// hacer despachable). export/dispatch/delete quedan para el backend F5. El Board recarga
// solo por Realtime tras la mutación.

import { useEffect, useState } from "react";
import { useProject } from "@/lib/project";
import type { OrchestratorTicket } from "@/lib/types";
import { LaneChip } from "@/components/tickets/LaneChip";
import { AGENT_LOST_TOKEN, statusToken } from "@/lib/statusToken";
import { isAgentLost } from "@/lib/agentLost";
import { useT } from "@/lib/i18n";

function acceptanceLines(accept?: string): string[] {
  if (!accept) return [];
  return accept.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
}

export function TicketDetail({ ticket, onClose, onOpenTicket }: {
  ticket: OrchestratorTicket | null;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
}) {
  const t = useT();
  const { projectId, supabase } = useProject();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = !!ticket;
  const acs = acceptanceLines(ticket?.acceptance);

  useEffect(() => { setActionError(null); }, [ticket?.id]);

  // Reencolar / recuperar: failed→ready (transición legal de v2), limpiando run_id y el
  // marcador agent_lost. El trigger de state-machine valida; el Board recarga por Realtime.
  async function doRequeue(confirm: boolean) {
    if (!ticket) return;
    if (confirm && !window.confirm(t("tickets.detail.requeueConfirm"))) return;
    setBusy(true);
    setActionError(null);
    const { error } = await supabase
      .from("stories")
      .update({ status: "ready", run_id: null, agent_lost: null })
      .eq("project_id", projectId)
      .eq("key", ticket.id);
    setBusy(false);
    if (error) setActionError(error.message);
    else onClose();
  }

  return (
    <>
      <div className={`overlay ${open ? "on" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "on" : ""}`} aria-hidden={!open}>
        {ticket && (
          <>
            <div className="dh">
              <div>
                <div className="tk">
                  {ticket.id}
                  {ticket.sprint_id ? ` · ${ticket.sprint_id}` : ""}
                  {ticket.epic_id ? ` · ${ticket.epic_id}` : ""}
                </div>
                <h3>{ticket.title}</h3>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`pill ${statusToken(ticket.status).pill}`}>{t(`tickets.statusLabel.${ticket.status}`)}</span>
                <button className="x" onClick={onClose}>✕</button>
              </div>
            </div>

            <div className="db">
              {(ticket.owner || ticket.repo) && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {ticket.owner && <LaneChip lane={ticket.owner} title={t("tickets.detail.laneTitle")} />}
                  {ticket.repo && (
                    <span className="tag" style={{ fontSize: 11 }} title={ticket.repo}>
                      {ticket.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                    </span>
                  )}
                </div>
              )}

              {isAgentLost(ticket) && (
                <div className="td-agent-lost" style={{
                  display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", marginBottom: 14,
                  borderRadius: 6, background: AGENT_LOST_TOKEN.soft, border: `1px solid ${AGENT_LOST_TOKEN.border}`,
                  color: AGENT_LOST_TOKEN.color, fontSize: 12,
                }}>
                  <span aria-hidden>{AGENT_LOST_TOKEN.icon}</span>
                  <span><strong>{t("tickets.detail.agentLostTitle")}</strong><br />{ticket.agent_lost}</span>
                </div>
              )}

              <div className="eyebrow acc">{t("tickets.detail.description")}</div>
              {ticket.body ? <p className="td-body">{ticket.body}</p> : <p className="td-empty">{t("tickets.detail.noDescription")}</p>}

              {acs.length > 0 && (
                <>
                  <div className="eyebrow acc" style={{ marginTop: 20 }}>{t("tickets.detail.acceptance")} · {acs.length}</div>
                  <ul className="td-acs">
                    {acs.map((ac, i) => <li key={i}><span className="td-ac-mark">✓</span>{ac}</li>)}
                  </ul>
                </>
              )}

              {ticket.deps && ticket.deps.length > 0 && (
                <>
                  <div className="eyebrow acc" style={{ marginTop: 20 }}>{t("tickets.detail.dependencies")}</div>
                  <div className="td-deps">
                    {ticket.deps.map((d) => (
                      <button key={d} className="td-dep click" onClick={() => onOpenTicket(d)} title={t("tickets.rowTitle")}>{d} →</button>
                    ))}
                  </div>
                </>
              )}

              <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
                {ticket.session_url && (
                  <a className="btn primary" style={{ width: "100%", textAlign: "center" }} href={ticket.session_url} target="_blank" rel="noreferrer">
                    {t("tickets.detail.viewSession")}
                  </a>
                )}
                {ticket.pr_url && (
                  <a className="btn ghost" style={{ width: "100%", textAlign: "center" }} href={ticket.pr_url} target="_blank" rel="noreferrer">
                    {t("tickets.detail.viewPR")}
                  </a>
                )}
                {!ticket.session_url && !ticket.pr_url && <div className="td-empty">{t("tickets.detail.notRun")}</div>}

                {isAgentLost(ticket) && (
                  <button className="btn primary" style={{ width: "100%" }} onClick={() => doRequeue(false)} disabled={busy}
                    title={t("tickets.detail.recover")}>
                    {busy ? t("tickets.detail.requeueing") : t("tickets.detail.recover")}
                  </button>
                )}
                {ticket.status === "failed" && !isAgentLost(ticket) && (
                  <button className="btn ghost" style={{ width: "100%", color: "var(--danger)" }} onClick={() => doRequeue(true)} disabled={busy}
                    title={t("tickets.detail.requeue")}>
                    {busy ? t("tickets.detail.requeueing") : t("tickets.detail.requeue")}
                  </button>
                )}

                {actionError && (
                  <div style={{ padding: "8px 12px", background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 4, fontSize: 12, color: "var(--accent)" }}>
                    {actionError}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
