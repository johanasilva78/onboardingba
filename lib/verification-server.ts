import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NextRequest, NextResponse } from "next/server";

const maxBytes = 850_000;

export function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readRequest(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export async function invokeVerification(functionName: string, input: unknown) {
  try {
    const lambda = new LambdaClient({ region: process.env.ONBOARDING_REGION || "us-east-1" });
    const response = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(input))
    }), { abortSignal: AbortSignal.timeout(29_000) });
    if (response.FunctionError || !response.Payload) throw new Error("Falló la función");
    const result = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
        !result.body || typeof result.body !== "object") throw new Error("Respuesta inválida");
    return json(result.body, result.status);
  } catch {
    return json({ message: "La verificación está temporalmente indisponible. Inténtalo nuevamente." }, 502);
  }
}
