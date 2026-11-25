# Onboarding Banco Atlántida

Experiencia web en español para recorrer la verificación de identidad de una persona con DNI hondureño. Usa Next.js App Router, React 19 y TypeScript en el frontend, y una Lambda en Python en el backend. AWS Amplify Hosting ejecuta el frontend y sus rutas de servidor.

La POC se centra en el DNI físico hondureño del formato introducido en 2021, emitido por el Registro Nacional de las Personas (RNP). El DNI digital queda para una etapa posterior, sujeta a confirmación del banco.

## Probar la experiencia

Con Node.js 22 o posterior:

```bash
npm ci
npm run dev
```

Abre [127.0.0.1:3000](http://127.0.0.1:3000). Con `ONBOARDING_FUNCTION_NAME` vacía, puedes cargar dos imágenes ficticias JPG o PNG para probar la selección, el reemplazo y la vista previa. La demo mantiene los archivos en el navegador y muestra datos de ejemplo al simular la lectura. También puedes usar el documento de ejemplo directamente.

```bash
npm run typecheck
npm test
npm run build
```

Las pruebas de la Lambda usan Python 3.11 o posterior y simulan las respuestas de AWS.

## Comprobaciones del piloto

| Comprobación | Implementación |
| --- | --- |
| Lectura del DNI | Amazon Textract lee el frente y el reverso. Se muestran el número de DNI, los nombres, los apellidos y las fechas de nacimiento y vencimiento que se puedan identificar en el frente. El número debe ser único y legible para continuar. |
| Prueba de vida | Amazon Rekognition Face Liveness abre una sesión de video con el componente oficial de Amplify. La Lambda consulta el resultado de AWS. Si no se alcanza el umbral, se puede repetir la captura. |
| Comparación facial | La Lambda coteja el fotograma de la sesión con el retrato del frente del DNI mediante Rekognition CompareFaces. Una coincidencia insuficiente queda pendiente de revisión. |
| Autenticidad | Un proveedor autorizado puede confirmar el documento. Si no hay proveedor o su respuesta es inconclusa, se indica «Sin verificar». El reconocimiento del texto no confirma la emisión del DNI. |

El frontend llama a `/api/verification`. La ruta usa el rol de ejecución de Amplify para invocar la Lambda. El navegador recibe credenciales temporales con permiso exclusivo para iniciar la transmisión de vida. La Lambda vincula por firma el frente leído con la sesión, consulta la decisión en AWS y limita la vigencia de cada paso.

La aplicación mantiene las fotos y los resultados en memoria durante la sesión. No genera un expediente, guarda evidencias en S3 ni comunica una decisión de apertura de cuenta. «Verificación por confirmar» indica el resultado que vio la persona y requiere seguimiento por el equipo del piloto. Antes de usar datos reales, el equipo debe aprobar el aviso de privacidad, las transferencias a AWS y al proveedor, los umbrales y el canal de atención asistida.

## Configurar AWS

1. Despliega la Lambda con AWS SAM en una región compatible con Textract y Face Liveness. El ejemplo usa Virginia del Norte.

   ```bash
   sam deploy --guided --template-file lambda/template.yaml \
     --stack-name onboardingba --region us-east-1 --capabilities CAPABILITY_NAMED_IAM
   ```

   La plantilla genera el código del piloto y una clave independiente para las sesiones en AWS Secrets Manager. Comparte únicamente el `accessCode` con los participantes autorizados. Los valores iniciales de los umbrales son 90 para vida y 95 para comparación facial. Son parámetros del piloto.

2. Conecta este repositorio en Amplify Hosting como una aplicación Next.js SSR. Configura `ONBOARDING_FUNCTION_NAME` con la salida `VerificationFunctionName` y `ONBOARDING_REGION` con la región de la Lambda. Amplify usa el archivo `amplify.yml` incluido.

3. Asigna a Amplify un [rol SSR Compute de IAM](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html) con `lambda:InvokeFunction` sobre el ARN exacto de `VerificationFunctionArn`. La interfaz usa HTTPS en Amplify. Para apuntar al mismo servicio desde desarrollo local, puedes configurar las dos variables en `.env.local` y usar credenciales de AWS con el mismo alcance.

4. Usa un navegador con cámara y el código de acceso suministrado desde `PilotAccessSecretArn`. Recorre la lectura, la cámara y el resultado con una identidad de prueba autorizada antes de abrir el piloto a participantes.

## Invocar la extracción del DNI

El punto de entrada es [`handler.handler`](lambda/handler.py) y la función de extracción es `read_document`. La ruta Next.js envía esta misma estructura a la Lambda de forma síncrona:

```json
{
  "action": "read",
  "code": "<accessCode del piloto>",
  "front": "<JPEG del frente en base64>",
  "back": "<JPEG del reverso en base64>"
}
```

La interfaz convierte JPG o PNG a JPEG antes de enviarlos. Para invocar la Lambda directamente, usa JPEG en base64 sin el prefijo `data:`, con un máximo de 420 000 caracteres por lado. La respuesta exitosa incluye `documentNumber` para mostrar y `numeroIdentidad` como cadena de 13 dígitos sin separadores para integración. Ambos conservan los ceros iniciales.

En `fields`, el anverso aporta `givenNames`, `surnames`, `birthDate`, `expiryDate`, `nationality` y `birthplace`. El reverso aporta `residenceMunicipality` y `residenceDepartment` si las etiquetas son legibles. Los campos ilegibles o ambiguos se devuelven como `null` y las fechas válidas llevan el formato `AAAA-MM-DD`. La respuesta también incluye `lines`, `authenticity` y `proof`.

La clasificación automática del documento y sus caras, la lectura de MRZ, QR y códigos de barras, y las reglas de vencimiento, mayoría de edad y cotejo entre caras quedan como propuestas por validar con el banco.

## Conectar autenticidad documental

Configura las propiedades `authenticityUrl` y `authenticityApiKey` en el JSON del secreto `PilotAccessSecretArn`, conservando `accessCode`. La URL debe ser HTTPS y pertenecer a un proveedor autorizado para procesar documentos hondureños.

El proveedor recibe un POST autenticado con `Authorization: Bearer <credencial>`. Las fotos se envían como JPEG en base64 y `number` lleva el DNI leído.

```json
{
  "country": "HN",
  "type": "DNI",
  "number": "0000-0000-00000",
  "front": "<base64>",
  "back": "<base64>"
}
```

Lee la respuesta JSON del proveedor como `{"status":"verified"}` para confirmación y `{"status":"rejected"}` para rechazo. Un valor distinto, un error o un proveedor ausente se muestran como «Sin verificar». El proyecto no incluye credenciales ni una conexión habilitada a un registro oficial.

## Referencias

- [DANAConnect Onboarding](https://github.com/mlastra-dana/DANAConnect_Onboarding)
- [Banco Atlántida Honduras](https://bancatlan.hn/)
- [Documento Nacional de Identificación de Honduras](https://www.rnp.hn/sites/rnpweb/DNI)
- [Amazon Rekognition Face Liveness](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness.html)
