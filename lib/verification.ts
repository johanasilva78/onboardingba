export type Authenticity = "verified" | "rejected" | "unavailable";

export type DocumentFields = {
  givenNames: string | null;
  surnames: string | null;
  birthDate: string | null;
  expiryDate: string | null;
  nationality?: string | null;
  birthplace?: string | null;
  residenceMunicipality?: string | null;
  residenceDepartment?: string | null;
};

export type DocumentResult = {
  documentNumber: string | null;
  numeroIdentidad?: string | null;
  fields?: DocumentFields;
  lines: string[];
  authenticity: Authenticity;
  proof: string;
};

export type LivenessCapture = {
  sessionId: string;
  challengeType?: "FaceMovementChallenge";
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
};

export type LivenessSession = LivenessCapture & { proof: string };

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
  fields: { givenNames: "MARÍA", surnames: "EJEMPLO", birthDate: "1990-07-25", expiryDate: "2030-10-05" },
  lines: ["DOCUMENTO DE EJEMPLO", "MARÍA EJEMPLO", "0000-0000-00000", "25-07-1990", "05-10-2030"],
  authenticity: "unavailable",
  proof: ""
};
