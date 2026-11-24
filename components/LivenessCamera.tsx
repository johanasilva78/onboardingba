"use client";

import { FaceLivenessDetectorCore } from "@aws-amplify/ui-react-liveness";
import { ThemeProvider } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import type { LivenessSession } from "@/lib/verification";

export default function LivenessCamera({ session, onFinish, onExit }: {
  session: LivenessSession;
  onFinish: () => Promise<void>;
  onExit: (message?: string) => void;
}) {
  return (
    <ThemeProvider theme={{ name: "atlantida", tokens: { colors: { brand: { primary: {
      10: { value: "#fff1f2" }, 80: { value: "#bf1026" }, 90: { value: "#9b1020" },
      100: { value: "#760c18" }
    } } } } }}>
      <FaceLivenessDetectorCore
        sessionId={session.sessionId}
        region={session.region}
        config={{ credentialProvider: async () => session.credentials }}
        onAnalysisComplete={onFinish}
        onUserCancel={() => onExit()}
        onError={({ state }) => {
          if (state === "CAMERA_ACCESS_ERROR" || state === "DEFAULT_CAMERA_NOT_FOUND_ERROR") {
            onExit("Conecta una cámara física y permite el acceso en tu navegador para continuar.");
          } else if (state === "CAMERA_FRAMERATE_ERROR") {
            onExit("La cámara no alcanza la velocidad requerida. Usa otra cámara o dispositivo.");
          } else {
            onExit("No pudimos completar la prueba. Vuelve a activar la cámara para intentar de nuevo.");
          }
        }}
        displayText={{
          startScreenBeginCheckText: "Comenzar prueba de vida",
          goodFitCaptionText: "Posición correcta",
          goodFitAltText: "Rostro centrado dentro del óvalo",
          tooFarCaptionText: "Acércate un poco",
          tooFarAltText: "Rostro demasiado lejos de la cámara",
          photosensitivityWarningHeadingText: "Advertencia de fotosensibilidad",
          photosensitivityWarningBodyText: "Esta prueba puede mostrar luces de colores. Si eres sensible a ellas, cancela la prueba y solicita atención asistida.",
          photosensitivityWarningInfoText: "La pantalla puede mostrar luces de colores que cambian rápidamente.",
          photosensitivityWarningLabelText: "Más información sobre fotosensibilidad",
          cameraNotFoundHeadingText: "Cámara no disponible",
          cameraNotFoundMessageText: "Conecta una cámara y verifica que el navegador tenga permiso para usarla.",
          cameraMinSpecificationsHeadingText: "La cámara no cumple los requisitos",
          cameraMinSpecificationsMessageText: "Prueba con una cámara física que capture al menos 15 imágenes por segundo.",
          retryCameraPermissionsText: "Revisar permisos de cámara",
          waitingCameraPermissionText: "Esperando permiso para usar la cámara…",
          a11yVideoLabelText: "Vista previa de la cámara",
          hintCenterFaceText: "Centra tu rostro",
          hintCenterFaceInstructionText: "Ubica tu rostro dentro del óvalo.",
          hintMoveFaceFrontOfCameraText: "Mira hacia la cámara",
          hintTooManyFacesText: "Debe aparecer una sola persona",
          hintHoldFaceForFreshnessText: "Mantén el rostro quieto",
          hintTooCloseText: "Aléjate un poco",
          hintTooFarText: "Acércate un poco",
          hintConnectingText: "Conectando…",
          hintVerifyingText: "Verificando…",
          hintCheckCompleteText: "Captura completada",
          recordingIndicatorText: "Grabando",
          cancelLivenessCheckText: "Cancelar prueba"
        }}
      />
    </ThemeProvider>
  );
}
