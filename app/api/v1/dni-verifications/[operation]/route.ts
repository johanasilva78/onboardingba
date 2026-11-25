import { NextRequest } from "next/server";
import { invokeVerification, json, readRequest } from "@/lib/verification-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (operation !== "start" && operation !== "result" && operation !== "capture") {
    return json({ message: "Operación inexistente." }, 404);
  }

  const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (operation !== "capture" && !token) return json({ message: "Se requiere un token de integración." }, 401);
  if (operation === "capture" && request.headers.get("sec-fetch-site") === "cross-site") {
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

  if (operation === "capture") {
    if (!input || typeof input.ticket !== "string" || input.ticket.length > 1024) {
      return json({ message: "El enlace de captura no es válido." }, 400);
    }
    return invokeVerification(functionName, { action: "hostedCapture", ticket: input.ticket });
  }

  if (!input || typeof input.front !== "string" ||
      (operation === "start" ? typeof input.back !== "string" : typeof input.proof !== "string")) {
    return json({ message: "Revisa los datos e inténtalo de nuevo." }, 400);
  }

  if (operation === "result") {
    return invokeVerification(functionName, { action: "integrationResult", token, front: input.front, proof: input.proof });
  }

  const response = await invokeVerification(functionName, { action: "integrationStart", token, front: input.front, back: input.back });
  if (!response.ok) return response;
  const body = await response.json();
  if (body.status === "awaiting_capture" && typeof body.capture?.captureTicket === "string") {
    const captureUrl = new URL("/biometria", process.env.ONBOARDING_CAPTURE_ORIGIN || request.nextUrl.origin);
    captureUrl.hash = new URLSearchParams({ ticket: body.capture.captureTicket }).toString();
    body.captureUrl = captureUrl.toString();
    delete body.capture.captureTicket;
  }
  return json(body, response.status);
}
