import { notFound } from "next/navigation";

export default async function OnboardingOutcome({ params }: { params: Promise<{ estado: string }> }) {
  const { estado } = await params;
  if (estado !== "completado" && estado !== "cancelado") notFound();

  return (
    <main className="shell">
      <section className="panel final-panel">
        <h1>{estado === "completado" ? "Resultados enviados" : "Verificación cancelada"}</h1>
        <p className="lede">Vuelve a la app del banco para continuar.</p>
      </section>
    </main>
  );
}
