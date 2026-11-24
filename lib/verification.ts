export type Authenticity = "verified" | "rejected" | "unavailable";

export type DocumentResult = {
  documentNumber: string | null;
  lines: string[];
  authenticity: Authenticity;
  proof: string;
};

export type LivenessSession = {
  sessionId: string;
  region: string;
  proof: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
};

export type VerificationResult = {
  liveness: "passed" | "retry";
  faceMatch: "passed" | "review" | "pending";
};

export type VerificationRequest = { code: string } & (
  | { action: "authorize" }
  | { action: "read"; front: string; back: string }
  | { action: "start"; proof: string }
  | { action: "finish"; front: string; proof: string }
);

export const exampleDocument: DocumentResult = {
  documentNumber: "0000-0000-00000",
  lines: ["DOCUMENTO DE EJEMPLO", "MARÍA EJEMPLO", "0000-0000-00000"],
  authenticity: "unavailable",
  proof: ""
};
