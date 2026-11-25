import { notFound } from "next/navigation";

export default async function CaptureOutcome({ params }: { params: Promise<{ estado: string }> }) {
  const { estado } = await params;
  if (estado !== "completada" && estado !== "cancelada") notFound();

  return (
    <main className="shell">
      <section className="panel final-panel">
        <h1>{estado === "completada" ? "Captura enviada" : "Captura cancelada"}</h1>
        <p className="lede">Vuelve a la app del banco para continuar.</p>
      </section>
    </main>
  );
}
