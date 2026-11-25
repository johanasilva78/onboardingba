import { NextRequest } from "next/server";
import { invokeVerification, json, readRequest } from "@/lib/verification-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (operation !== "start" && operation !== "result") {
    return json({ message: "Operación inexistente." }, 404);
  }

  const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json({ message: "Se requiere un token de integración." }, 401);

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

  if (!input || typeof input.front !== "string" ||
      (operation === "start" ? typeof input.back !== "string" : typeof input.proof !== "string")) {
    return json({ message: "Revisa los datos e inténtalo de nuevo." }, 400);
  }

  return invokeVerification(functionName, operation === "start"
    ? { action: "integrationStart", token, front: input.front, back: input.back }
    : { action: "integrationResult", token, front: input.front, proof: input.proof });
}
