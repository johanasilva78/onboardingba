"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { LivenessCapture } from "@/lib/verification";

const LivenessCamera = dynamic(() => import("./LivenessCamera"), {
  ssr: false,
  loading: () => <p role="status">Preparando la cámara…</p>,
});

export function HostedCapture() {
  const [session, setSession] = useState<LivenessCapture>();
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setError("");
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
    if (!ticket) {
      setError("Abre el enlace de captura desde la app del banco.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/v1/dni-verifications/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok) {
        setError(response.status === 409
          ? "El enlace venció. Solicita una nueva captura desde la app del banco."
          : "No pudimos abrir la sesión. Vuelve a intentarlo.");
        return;
      }
      setSession(await response.json());
      window.history.replaceState(window.history.state, "", "/biometria");
    } catch {
      setError("No pudimos conectarnos. Vuelve a intentarlo.");
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    window.location.replace("/biometria/cancelada");
  }

  return (
    <main className="shell">
      <section className="panel hosted-capture">
        <img className="wordmark" src="/logo-atlantida-red.svg" alt="Banco Atlántida" width={192} height={50} />
        <h1>Prueba de vida</h1>
        <p className="lede">Centra tu rostro en el óvalo y sigue las indicaciones. Esta prueba enviará un video corto a AWS para verificar tu identidad.</p>
        {session ? (
          <div className="camera">
            <LivenessCamera
              session={session}
              onFinish={async () => { window.location.replace("/biometria/completada"); }}
              onExit={message => {
                if (message) {
                  setSession(undefined);
                  setFinished(true);
                  setError(message + " Solicita una nueva captura desde la app del banco.");
                } else {
                  cancel();
                }
              }}
            />
          </div>
        ) : (
          <>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <button className="secondary" type="button" onClick={cancel} disabled={pending}>Volver a la app</button>
              {!finished && (
                <button className="primary" type="button" onClick={start} disabled={pending}>
                  {pending ? "Preparando la cámara…" : "Activar cámara"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
