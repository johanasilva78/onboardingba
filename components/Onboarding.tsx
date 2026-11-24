"use client";

import dynamic from "next/dynamic";
import { useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import {
  BadgeCheck, Camera, Check, CircleHelp, Clock3, CreditCard, FileCheck2,
  FileText, Fingerprint, IdCard, Info, LockKeyhole, ScanFace, ShieldCheck, Upload, X
} from "lucide-react";
import { preparePhoto } from "@/lib/photo";
import {
  exampleDocument, type DocumentResult, type LivenessSession,
  type VerificationRequest, type VerificationResult
} from "@/lib/verification";

const LivenessCamera = dynamic(() => import("./LivenessCamera"), {
  ssr: false,
  loading: () => <p role="status">Preparando la cámara…</p>
});
const steps = ["Inicio", "Documento", "Biometría", "Revisión"];
const demoResult: VerificationResult = { liveness: "passed", faceMatch: "passed" };

async function request<T>(input: VerificationRequest): Promise<T> {
  const response = await fetch("/api/verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.message ?? "No pudimos conectar con el servicio. Inténtalo de nuevo.");
  }
  return data;
}

function IdentityArt() {
  return (
    <div className="identity-art" aria-hidden="true">
      <div className="art-orbit orbit-outer" />
      <div className="art-orbit orbit-inner" />
      <div className="art-grid" />
      <div className="scan-frame"><i /><i /><i /><i /></div>
      <div className="art-card">
        <div className="art-card-head"><CreditCard size={16} /> IDENTIDAD DIGITAL</div>
        <div className="art-card-body">
          <div className="art-avatar"><ScanFace size={37} strokeWidth={1.4} /></div>
          <div className="art-lines"><i /><i /><i /></div>
        </div>
        <div className="art-card-foot"><i /><Fingerprint size={23} strokeWidth={1.3} /></div>
      </div>
      <div className="art-shield"><ShieldCheck size={26} strokeWidth={1.7} /></div>
    </div>
  );
}

function PhotoInput({ id, label, image, onChange, disabled }: {
  id: string; label: string; image: string; disabled: boolean;
  onChange: (file: File | null) => void;
}) {
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onChange(file);
  }

  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!disabled && file) onChange(file);
  }

  return (
    <div className="photo-input">
      <label htmlFor={id} className={"upload-box" + (image ? " has-photo" : "")}
        onDragOver={event => event.preventDefault()} onDrop={drop}>
        {image
          ? <img src={`data:image/jpeg;base64,${image}`} alt={label + " del DNI"} />
          : <span className="upload-icon"><Upload size={21} /></span>}
        <strong>{label}</strong>
        <span>{image ? "Cambiar imagen" : "Selecciona una foto JPG o PNG"}</span>
      </label>
      <input className="visually-hidden" id={id} type="file" accept="image/jpeg,image/png"
        onChange={pick} disabled={disabled} />
      {image && <button className="photo-remove" type="button" aria-label={`Quitar foto: ${label}`}
        onClick={() => onChange(null)} disabled={disabled}><X size={17} /></button>}
    </div>
  );
}

function ResultRow({ icon, label, detail, status, passed }: {
  icon: ReactNode; label: string; detail: string; status: string; passed: boolean;
}) {
  return <div className="result-row">
    <span className="feature-icon">{icon}</span>
    <div><strong>{label}</strong><p>{detail}</p></div>
    <span className={"status-pill" + (passed ? " passed" : "")}>{passed && <Check size={14} />}{status}</span>
  </div>;
}

export function Onboarding({ connected }: { connected: boolean }) {
  const [step, setStep] = useState(0);
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [doc, setDoc] = useState<DocumentResult | null>(null);
  const [session, setSession] = useState<LivenessSession | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [help, setHelp] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);

  function go(next: number) {
    setError("");
    setHelp(false);
    setStep(next);
    window.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() => document.getElementById("step-title")?.focus({ preventScroll: true }));
  }

  function restart() {
    setConsent(false);
    setCode("");
    setFront("");
    setBack("");
    setDoc(null);
    setSession(null);
    setResult(null);
    setNeedsReview(false);
    go(0);
  }

  async function run(label: string, work: () => Promise<void>) {
    setPending(label);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ocurrió un error. Inténtalo de nuevo.");
    } finally {
      setPending("");
    }
  }

  async function choosePhoto(side: "front" | "back", file: File | null) {
    await run("Preparando imagen…", async () => {
      const photo = file ? await preparePhoto(file) : "";
      if (side === "front") setFront(photo);
      else setBack(photo);
      setDoc(null);
      setResult(null);
    });
  }

  async function start() {
    if (!consent || (connected && !code.trim())) return;
    await run("Comprobando acceso…", async () => {
      if (connected) await request({ action: "authorize", code });
      go(1);
    });
  }

  async function readDocument() {
    await run("Leyendo documento…", async () => {
      setDoc(connected ? await request<DocumentResult>({ action: "read", code, front, back }) : exampleDocument);
    });
  }

  async function startLiveness() {
    if (!doc) return;
    setResult(null);
    await run(connected ? "Preparando cámara…" : "Ejecutando simulación…", async () => {
      if (connected) {
        setSession(await request<LivenessSession>({ action: "start", code, proof: doc.proof }));
      } else {
        setResult(demoResult);
        go(3);
      }
    });
  }

  async function finishLiveness() {
    if (!session) return;
    setSession(null);
    await run("Consultando resultados…", async () => {
      const verification = await request<VerificationResult>({ action: "finish", code, front, proof: session.proof });
      setResult(verification);
      if (verification.liveness === "passed") go(3);
      else setError("La prueba de vida requiere otro intento. Colócate frente a la cámara con luz uniforme.");
    });
  }

  function finish() {
    setNeedsReview(result?.faceMatch !== "passed" || doc?.authenticity !== "verified");
    setFront("");
    setBack("");
    setDoc(null);
    setSession(null);
    setResult(null);
    setCode("");
    go(4);
  }

  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <div className="wordmark" aria-label="Banco Atlántida">
          <span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>
          <span>Banco<strong>Atlántida</strong></span>
        </div>
        <button type="button" className="help-button" aria-expanded={help} aria-controls="help-panel"
          onClick={() => setHelp(!help)}><CircleHelp size={19} /> <span>Ayuda</span></button>
      </div>
    </header>
    <main className="shell">
      {help && <aside className="help-panel" id="help-panel">
        <div><strong>Ayuda con la verificación</strong>
          <p>Usa un DNI legible y un dispositivo con cámara. Si tienes dificultades o prefieres atención asistida, consulta los canales oficiales del banco.</p>
          <a href="https://bancatlan.hn/" target="_blank" rel="noreferrer">Ir al sitio de Banco Atlántida</a>
        </div>
        <button type="button" className="icon-button" aria-label="Cerrar ayuda" onClick={() => setHelp(false)}><X size={20} /></button>
      </aside>}
      <nav aria-label="Progreso de la verificación" className="progress">
        <ol>{steps.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""}
          aria-current={index === step ? "step" : undefined}>
          <span className="step-number">{index < step ? <Check size={16} /> : index + 1}</span><span>{label}</span>
        </li>)}</ol>
      </nav>

      {step === 0 && <>
        <section className="hero">
          <div className="hero-copy">
            <div className="portal-label"><span /> {connected ? "PILOTO CON ACCESO RESTRINGIDO" : "DEMO DE ONBOARDING"}</div>
            <h1 id="step-title" tabIndex={-1}>Verifica<br />tu identidad<span>.</span></h1>
            <p>Confirma quién eres con tu documento de identidad y una breve prueba con la cámara.</p>
            <div className="hero-details"><span><Clock3 size={17} /> Unos minutos</span><span><LockKeyhole size={16} /> Proceso guiado</span></div>
          </div>
          <IdentityArt />
        </section>

        <section className="welcome-card" aria-labelledby="welcome-title">
          <h2 id="welcome-title">Antes de comenzar</h2>
          <div className="features">
            <div><span className="feature-icon"><IdCard size={22} /></span><strong>Documento de identidad</strong><p>Ten a mano tu DNI hondureño.</p></div>
            <div><span className="feature-icon"><Camera size={21} /></span><strong>Cámara disponible</strong><p>Busca un lugar con buena luz.</p></div>
            <div><span className="feature-icon"><ShieldCheck size={22} /></span><strong>Comparación facial</strong><p>Contrastaremos tu rostro con la foto del DNI.</p></div>
          </div>
          <div className="welcome-actions">
            {!connected && <p className="notice"><Info size={18} /> Esta demo usa datos ficticios y no solicita imágenes personales.</p>}
            <label className="consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
              {connected
                ? "Autorizo el tratamiento de las fotos del DNI y la transmisión de video a AWS para verificar mi identidad en este piloto."
                : "Entiendo que esta es una simulación con datos de ejemplo."}
            </label>
            {connected && <label className="access-code">Código de acceso
              <input type="password" autoComplete="off" maxLength={128} value={code} onChange={event => setCode(event.target.value)} />
            </label>}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" type="button" onClick={start} disabled={!consent || Boolean(pending) || (connected && !code.trim())}>
              {pending || "Comenzar verificación"}
            </button>
          </div>
        </section>
      </>}

      {step === 1 && <section className="panel">
        <span className="feature-icon section-icon"><IdCard size={26} /></span>
        <h1 id="step-title" tabIndex={-1}>Documento de identidad</h1>
        <p className="lede">{connected
          ? "Sube fotos nítidas del frente y del reverso de tu DNI. Mantén todos los bordes visibles y evita los reflejos."
          : "Carga un DNI ficticio para recorrer la lectura de documento sin usar información personal."}</p>
        {connected && <div className="photo-grid">
          <PhotoInput id="front" label="Frente del DNI" image={front} disabled={Boolean(pending)} onChange={file => void choosePhoto("front", file)} />
          <PhotoInput id="back" label="Reverso del DNI" image={back} disabled={Boolean(pending)} onChange={file => void choosePhoto("back", file)} />
        </div>}
        {doc && <div className="ocr-result">
          <div className="ocr-heading"><FileText size={20} /><strong>Datos leídos del documento</strong></div>
          <dl><dt>Número de DNI</dt><dd>{doc.documentNumber || "No se pudo leer el número con claridad"}</dd></dl>
          {doc.lines.length > 0 && <details><summary>Ver texto reconocido</summary><ul>
            {doc.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul></details>}
          {connected && doc.proof && <button type="button" className="text-button" disabled={Boolean(pending)}
            onClick={readDocument}>{pending || "Volver a leer el documento"}</button>}
          {doc.authenticity === "rejected" && <p className="error" role="alert">El proveedor no pudo validar este documento. Puedes volver a cargar las fotos o cerrar el proceso.</p>}
        </div>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="secondary" type="button" disabled={Boolean(pending)} onClick={() => go(0)}>Atrás</button>
          {doc?.documentNumber && doc.authenticity !== "rejected"
            ? <button className="primary" type="button" disabled={Boolean(pending)} onClick={() => go(2)}>Continuar a biometría</button>
            : <button className="primary" type="button" disabled={Boolean(pending) || (connected && (!front || !back))}
              onClick={readDocument}>{pending || (connected ? "Leer documento" : "Cargar documento de ejemplo")}</button>}
        </div>
      </section>}

      {step === 2 && <section className="panel">
        <span className="feature-icon section-icon"><ScanFace size={26} /></span>
        <h1 id="step-title" tabIndex={-1}>Prueba de vida</h1>
        <p className="lede">{connected
          ? "Mira hacia la cámara y sigue las indicaciones. Compararemos la imagen de la prueba con la foto de tu DNI."
          : "Simula la prueba de vida y la comparación con la foto del documento de ejemplo."}</p>
        {session ? <div className="camera">
          <LivenessCamera key={session.sessionId} session={session} onFinish={finishLiveness}
            onExit={message => { setSession(null); if (message) setError(message); }} />
        </div> : <div className="biometric-guide">
          <div className="guide-face"><ScanFace size={58} strokeWidth={1.35} /></div>
          <div><strong>Para una buena captura</strong>
            <ul><li>Mantén el rostro visible y sin accesorios que lo cubran.</li><li>Colócate frente a una fuente de luz uniforme.</li></ul>
          </div>
        </div>}
        {error && <p className="error" role="alert">{error}</p>}
        {!session && <div className="actions">
          <button className="secondary" type="button" onClick={() => go(1)} disabled={Boolean(pending)}>Atrás</button>
          <button className="primary" type="button" onClick={startLiveness} disabled={Boolean(pending)}>
            {pending || (connected ? "Activar cámara" : "Simular verificación biométrica")}
          </button>
        </div>}
      </section>}

      {step === 3 && doc && result && <section className="panel">
        <span className="feature-icon section-icon"><FileCheck2 size={26} /></span>
        <h1 id="step-title" tabIndex={-1}>Resultados de la verificación</h1>
        <p className="lede">{connected ? "Revisa el resultado de cada comprobación." : "Resultados simulados con el documento de ejemplo."}</p>
        <div className="results">
          <ResultRow icon={<IdCard size={21} />} label="Lectura del documento" detail={doc.documentNumber ?? "Número sin identificar"} status="Leído" passed />
          <ResultRow icon={<Camera size={20} />} label="Prueba de vida" detail="Presencia frente a la cámara"
            status={connected ? "Completada" : "Simulada"} passed />
          <ResultRow icon={<ScanFace size={21} />} label="Comparación facial" detail="Rostro comparado con el retrato del DNI"
            status={result.faceMatch === "passed" ? (connected ? "Coincide" : "Simulada") : "Requiere revisión"} passed={result.faceMatch === "passed"} />
          <ResultRow icon={<ShieldCheck size={21} />} label="Autenticidad del documento"
            detail={doc.authenticity === "verified" ? "Confirmada por el proveedor documental" : "Sin confirmación de una fuente de autenticidad"}
            status={doc.authenticity === "verified" ? "Verificada" : "Sin verificar"} passed={doc.authenticity === "verified"} />
        </div>
        <div className="actions">
          <button className="secondary" type="button" onClick={() => { setResult(null); go(2); }}>Atrás</button>
          <button className="primary" type="button" onClick={finish}>Finalizar</button>
        </div>
      </section>}

      {step === 4 && <section className="panel final-panel">
        <span className="feature-icon section-icon">{connected && needsReview ? <FileCheck2 size={32} /> : <BadgeCheck size={32} />}</span>
        <h1 id="step-title" tabIndex={-1}>{connected ? (needsReview ? "Verificación por confirmar" : "Verificación completada") : "Simulación completada"}</h1>
        <p className="lede">{connected
          ? (needsReview ? "Al menos una comprobación necesita confirmación. Si necesitas continuar, comunícate con el equipo del piloto." : "Se completaron las comprobaciones de identidad de este piloto.")
          : "Recorriste la lectura de documento, la prueba de vida y la comparación facial con datos de ejemplo."}</p>
        <button className="primary" type="button" onClick={restart}>Volver al inicio</button>
      </section>}
      {step > 0 && step < 4 && !session && <button className="exit-button" onClick={restart} type="button" disabled={Boolean(pending)}>Salir de la verificación</button>}
    </main>
    <footer className="footer">
      <div><span className="footer-brand">Banco Atlántida</span><span>{connected ? "Piloto de verificación" : "Prototipo de demostración"}</span></div>
      <a href="https://bancatlan.hn/" target="_blank" rel="noreferrer">Sitio oficial</a>
    </footer>
  </>;
}
