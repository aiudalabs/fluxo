"use client";

// Mis credenciales (docs/16) · NIVEL CUENTA, no proyecto. Las credenciales son TUYAS: las cargás una
// vez acá, se guardan cifradas en la bóveda de Fluxo, y se siembran solas en los Actions secrets de
// TODOS tus proyectos (actuales y nuevos). Reemplaza el re-tipear el token en cada proyecto.

import { useCallback, useEffect, useState } from "react";
import { activeToken } from "@/lib/supabaseClient";
import { TopBar } from "@/components/shell/TopBar";

type Cred = { name: string; label: string; description: string; docsUrl?: string; optional?: boolean; set: boolean; updatedAt: string | null };

export default function CredentialsPage() {
  const [creds, setCreds] = useState<Cred[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  const load = useCallback(async () => {
    const tok = activeToken();
    try {
      const res = await fetch("/api/account/credentials", { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      if (!res.ok) { setState("error"); return; }
      const data = (await res.json()) as { credentials: Cred[] };
      setCreds(data.credentials ?? []);
      setState("ready");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (name: string) => {
    const value = (values[name] ?? "").trim();
    if (value.length < 10) { setNote("El valor parece vacío o muy corto."); return; }
    setBusy(name); setNote("");
    try {
      const tok = activeToken();
      const res = await fetch("/api/account/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ name, value }),
      });
      const data = (await res.json()) as { saved?: boolean; propagation?: Array<{ repo: string; seeded: string[]; failed: unknown[] }>; error?: string };
      if (!res.ok) { setNote(data.error ?? "No se pudo guardar."); return; }
      const repos = data.propagation?.length ?? 0;
      const okRepos = (data.propagation ?? []).filter((p) => p.seeded.includes(name)).length;
      setNote(repos ? `Guardada y sembrada en ${okRepos}/${repos} de tus repos.` : "Guardada. (Conectá GitHub para sembrarla en tus repos.)");
      setValues((v) => ({ ...v, [name]: "" }));
      await load();
    } catch { setNote("No se pudo guardar."); }
    finally { setBusy(null); }
  };

  const syncAll = async () => {
    setBusy("__sync__"); setNote("");
    try {
      const tok = activeToken();
      const res = await fetch("/api/account/credentials/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { synced?: number; error?: string };
      setNote(res.ok ? `Sincronizado a ${data.synced ?? 0} repo(s).` : (data.error ?? "No se pudo sincronizar."));
    } catch { setNote("No se pudo sincronizar."); }
    finally { setBusy(null); }
  };

  return (
    <>
      <TopBar />
      <div className="dash">
        <div className="dash-head">
          <div>
            <div className="dash-eye">Cuenta</div>
            <h1>Mis credenciales</h1>
          </div>
          <span className="sub">Tuyas, no de cada proyecto — se cargan una vez y se siembran solas en todos tus repos.</span>
          <button className="dash-cta" disabled={busy === "__sync__"} onClick={() => void syncAll()}>
            {busy === "__sync__" ? "Sincronizando…" : "↻ Sincronizar a mis proyectos"}
          </button>
        </div>

        {note && <p style={{ color: "var(--ink3)", fontSize: 13, margin: "0 0 12px" }}>{note}</p>}

        {state === "loading" ? (
          <p style={{ color: "var(--ink4)" }}>Cargando…</p>
        ) : state === "error" ? (
          <p style={{ color: "var(--accent)" }}>No se pudieron cargar las credenciales. ¿Sesión iniciada?</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
            {creds.map((c) => (
              <div key={c.name} className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <strong style={{ fontSize: 15 }}>{c.label}</strong>
                  {c.optional && <span style={{ fontSize: 11, color: "var(--ink4)" }}>opcional</span>}
                  <span className="sp" style={{ flex: 1 }} />
                  <span style={{ fontSize: 12.5, color: c.set ? "var(--emerald)" : "var(--ink4)", fontWeight: 600 }}>
                    {c.set ? `🟢 Configurada${c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleDateString()}` : ""}` : "⚪ No configurada"}
                  </span>
                </div>
                <p style={{ fontSize: 13, color: "var(--ink3)", margin: 0, lineHeight: 1.5 }}>{c.description}</p>
                {c.docsUrl && <a href={c.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "var(--navy)" }}>Cómo obtenerla ↗</a>}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <input
                    className="inp" type="password" autoComplete="off"
                    placeholder={c.set ? "Pegá un valor nuevo para rotarla…" : "Pegá el valor…"}
                    value={values[c.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
                    style={{ flex: 1, fontFamily: "var(--mono)" }}
                  />
                  <button className="btn primary" disabled={busy === c.name || !(values[c.name] ?? "").trim()} onClick={() => void save(c.name)}>
                    {busy === c.name ? "Guardando…" : c.set ? "Rotar" : "Guardar"}
                  </button>
                </div>
              </div>
            ))}
            <p style={{ fontSize: 12, color: "var(--ink4)", margin: "4px 0 0" }}>
              El valor se guarda cifrado en la bóveda de Fluxo (nunca se muestra de vuelta) y se siembra en los
              Actions secrets de tus repos. Un proyecto nuevo hereda tus credenciales con «Sincronizar».
            </p>
          </div>
        )}
      </div>
    </>
  );
}
