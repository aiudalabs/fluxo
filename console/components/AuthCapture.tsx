"use client";

// AuthCapture (F5-P8 A) · levanta el JWT de sesión que el callback de OAuth dejó en el
// fragment (#gh_session=…), lo guarda en localStorage y limpia la URL — sin recargar. Se
// monta una vez en el layout raíz. También muestra un error de auth si vino en la query.

import { useEffect } from "react";
import { setSessionToken } from "@/lib/supabaseClient";

export function AuthCapture() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (hash.startsWith("#") && hash.includes("gh_session=")) {
      const params = new URLSearchParams(hash.slice(1));
      const jwt = params.get("gh_session");
      if (jwt) {
        setSessionToken(jwt);
        // Limpiar el fragment de la URL (no dejar el token a la vista).
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        // Recargar el estado que dependa de la sesión.
        window.location.reload();
      }
    }
  }, []);
  return null;
}
