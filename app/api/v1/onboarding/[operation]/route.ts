import { NextRequest } from "next/server";
import { invokeVerification, json, readRequest } from "@/lib/verification-server";

export const runtime = "nodejs";
const steps = new Set(["authorize", "read", "start", "finish", "complete", "cancel"]);

export async function POST(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (operation !== "start" && operation !== "result" && operation !== "interaction") {
    return json({ message: "Operación inexistente." }, 404);
  }

  const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (operation !== "interaction" && !token) return json({ message: "Se requiere un token de integración." }, 401);
  if (operation === "interaction" && request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ message: "Solicitud no admitida." }, 403);
  }

  const functionName = process.env.ONBOARDING_FUNCTION_NAME;
  if (!functionName) return json({ message: "El servicio de verificación no está configurado." }, 503);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ message: "Usa application/json." }, 415);
  }

  let input;
  try {
    input = await readRequest(request);
  } catch {
    return json({ message: "No pudimos leer la solicitud." }, 400);
  }

  if (!input || typeof input !== "object") return json({ message: "Solicitud inválida." }, 400);
  if (operation === "interaction") {
    const { ticket, step, front, back, proof } = input;
    if (typeof ticket !== "string" || ticket.length > 1024 || !steps.has(step)) {
      return json({ message: "El enlace o la operación no es válida." }, 400);
    }
    return invokeVerification(functionName, { action: "workflowInteraction", ticket, step, front, back, proof });
  }
  if (operation === "result") {
    return invokeVerification(functionName, { action: "workflowResult", token, workflowId: input.workflowId });
  }

  const response = await invokeVerification(functionName, {
    action: "workflowStart", token, reference: input.reference, numeroIdentidad: input.numeroIdentidad,
  });
  if (!response.ok) return response;
  const { ticket, ...workflow } = await response.json();
  if (typeof ticket !== "string") return json({ message: "No pudimos generar el enlace." }, 502);
  const url = new URL("/onboarding", process.env.ONBOARDING_CAPTURE_ORIGIN || request.nextUrl.origin);
  url.hash = new URLSearchParams({ ticket }).toString();
  return json({ ...workflow, onboardingUrl: url.toString() }, 201);
}
