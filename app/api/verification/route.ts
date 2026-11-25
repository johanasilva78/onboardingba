import { NextRequest } from "next/server";
import { invokeVerification, json, readRequest } from "@/lib/verification-server";

export const runtime = "nodejs";

const actions = new Set(["authorize", "read", "start", "finish"]);

export async function POST(request: NextRequest) {
  const functionName = process.env.ONBOARDING_FUNCTION_NAME;
  if (!functionName) return json({ message: "La verificación real está desactivada." }, 503);

  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ message: "Solicitud no admitida." }, 415);
  }

  let input;
  try {
    input = await readRequest(request);
  } catch {
    return json({ message: "No pudimos leer la solicitud." }, 400);
  }
  if (!input || typeof input !== "object" || !actions.has(input.action) ||
      typeof input.code !== "string" || input.code.length > 128) {
    return json({ message: "Revisa los datos e inténtalo de nuevo." }, 400);
  }

  return invokeVerification(functionName, input);
}
