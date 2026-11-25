import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import lru_cache
from unicodedata import normalize
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

LOG = logging.getLogger(__name__)
REGION = os.getenv("AWS_REGION", "us-east-1")
MAX_ENCODED_IMAGE = 420_000
DNI = re.compile(r"(?<![0-9])([0-9]{4})[ \u00a0‐–-]?([0-9]{4})[ \u00a0‐–-]?([0-9]{5})(?![0-9])")
DATE = re.compile(r"([0-9]{2})\s*[./‐–-]\s*([0-9]{2})\s*[./‐–-]\s*([0-9]{4})")
PERSON_NAME = re.compile(r"[^\W\d_]+(?:[ .’'‐–-]+[^\W\d_]+)*")
FIELD_LABELS = {
    "givenNames": (r"NOMBRES?|FORENAMES?|GIVEN NAMES?", r"FORENAMES?|GIVEN NAMES?"),
    "surnames": (r"APELLIDOS?|SURNAMES?|LAST NAMES?", r"SURNAMES?|LAST NAMES?"),
    "birthDate": (r"(?:FECHA DE )?NACIMIENTO|DATE OF BIRTH", r"DATE OF BIRTH"),
    "expiryDate": (r"(?:FECHA DE )?(?:VENCIMIENTO|EXPIRACI[ÓO]N)|DATE OF EXPIRY", r"DATE OF EXPIRY"),
    "nationality": (r"NACIONALIDAD|NATIONALITY", r"NATIONALITY"),
    "birthplace": (r"LUGAR DE NACIMIENTO|PLACE OF BIRTH", r"PLACE OF BIRTH"),
    "residenceMunicipality": (r"MUNICIPIO(?: DE DOMICILIO)?|MUNICIPALITY", r"MUNICIPALITY"),
    "residenceDepartment": (r"DEPARTAMENTO(?: DE DOMICILIO)?|DEPARTMENT", r"DEPARTMENT"),
}
FRONT_FIELDS = ("givenNames", "surnames", "birthDate", "expiryDate", "nationality", "birthplace")
BACK_FIELDS = ("residenceMunicipality", "residenceDepartment")
ADDRESS_LABEL = re.compile(r"^(?:DOMICILIO(?:\s*/\s*ADDRESS)?|ADDRESS)\s*:?\s*$", re.I)
DEPARTMENTS = set((
    "ATLANTIDA", "CHOLUTECA", "COLON", "COMAYAGUA", "COPAN", "CORTES", "EL PARAISO",
    "FRANCISCO MORAZAN", "GRACIAS A DIOS", "INTIBUCA", "ISLAS DE LA BAHIA", "LA PAZ",
    "LEMPIRA", "OCOTEPEQUE", "OLANCHO", "SANTA BARBARA", "VALLE", "YORO",
))
LABEL_PATTERNS = {
    field: re.compile(rf"^(?:{label})\b(?:(?:\s*/\s*|\s+)(?:{translation})\b)?\s*[:/]*\s*", re.I)
    for field, (label, translation) in FIELD_LABELS.items()
}
OTHER_LABEL = re.compile(
    r"^(?:REP[ÚU]BLICA DE HONDURAS|REGISTRO NACIONAL|DOCUMENTO NACIONAL|RNP\b|N[ÚU]MERO DE "
    r"|ID NUMBER|NACIONALIDAD|NATIONALITY|LUGAR DE NACIMIENTO|PLACE OF BIRTH|FECHA DE EMISI[ÓO]N"
    r"|DATE OF ISSUE|FIRMA|SIGNATURE)\b",
    re.I,
)
SDK_CONFIG = Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 2})


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@lru_cache(maxsize=None)
def client(service):
    return boto3.client(service, region_name=REGION, config=SDK_CONFIG)


def secret(name):
    return client("secretsmanager").get_secret_value(SecretId=os.environ[name])["SecretString"]


def code_allowed(value, expected):
    return (
        isinstance(value, str) and isinstance(expected, str) and len(expected) >= 24
        and hmac.compare_digest(value.strip().encode(), expected.encode())
    )


def proof_encode(claims, key):
    content = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(key.encode(), content.encode(), "sha256").hexdigest()
    return content + "." + signature


def proof_decode(value, purpose, key):
    try:
        if not isinstance(value, str) or len(value) > 1024:
            raise ValueError
        content, signature = value.split(".")
        expected = hmac.new(key.encode(), content.encode(), "sha256").hexdigest()
        if not hmac.compare_digest(signature.encode(), expected.encode()):
            raise ValueError
        claims = json.loads(base64.urlsafe_b64decode(content + "=" * (-len(content) % 4)))
        if claims["purpose"] == purpose and claims["expires"] > time.time():
            return claims
    except (ValueError, TypeError, KeyError, binascii.Error):
        pass
    raise RequestError(409, "La comprobación caducó. Vuelve al paso anterior y lee el documento de nuevo.")


def image_bytes(encoded):
    try:
        if isinstance(encoded, str) and 100 <= len(encoded) <= MAX_ENCODED_IMAGE:
            image = base64.b64decode(encoded, validate=True)
            if image.startswith(b"\xff\xd8\xff") and image.endswith(b"\xff\xd9"):
                return image
    except (ValueError, binascii.Error):
        pass
    raise RequestError(400, "Vuelve a cargar una foto JPG legible del documento.")


def digest(image):
    return hashlib.sha256(image).hexdigest()


def scan_lines(textract, image):
    response = textract.detect_document_text(Document={"Bytes": image})
    return [
        (normalize("NFC", block["Text"][:200].strip()), block.get("Geometry", {}).get("BoundingBox"))
        for block in response.get("Blocks", [])
        if block.get("BlockType") == "LINE" and (block.get("Text") or "").strip() and block.get("Confidence", 0) >= 75
    ]


def find_dni(lines):
    candidates = {"-".join(match.groups()) for line in lines for match in DNI.finditer(line)}
    return next(iter(candidates)) if len(candidates) == 1 else None


def next_line_index(lines, index):
    _, box = lines[index]
    if not box:
        return index + 1 if index + 1 < len(lines) else None

    candidates = []
    for candidate_index, (_, other) in enumerate(lines):
        if not other:
            continue
        vertical = other["Top"] - box["Top"]
        horizontal = abs(other["Left"] - box["Left"])
        if box["Height"] * 0.6 <= vertical <= 0.09 and horizontal <= 0.045:
            candidates.append((vertical, horizontal, candidate_index))
    return min(candidates)[2] if candidates else None


def parse_field(field, value):
    if field in ("birthDate", "expiryDate"):
        match = DATE.fullmatch(value)
        if match:
            day, month, year = map(int, match.groups())
            try:
                return date(year, month, day).isoformat()
            except ValueError:
                pass
        return None

    if OTHER_LABEL.match(value) or any(pattern.match(value) for pattern in LABEL_PATTERNS.values()):
        return None
    return value if len(value) <= 100 and PERSON_NAME.fullmatch(value) else None


def extract_fields(scan, fields_to_read):
    fields = {}
    for field in fields_to_read:
        pattern = LABEL_PATTERNS[field]
        candidates = set()
        for index, (text, _) in enumerate(scan):
            match = pattern.match(text)
            if match:
                raw_value = text[match.end():]
                if not raw_value:
                    next_index = next_line_index(scan, index)
                    raw_value = scan[next_index][0] if next_index is not None else ""
                value = parse_field(field, raw_value)
                if value:
                    candidates.add(value)
        fields[field] = next(iter(candidates)) if len(candidates) == 1 else None
    return fields


def extract_address(scan):
    fields = extract_fields(scan, BACK_FIELDS)
    if any(fields.values()):
        return fields

    labels = [index for index, (text, _) in enumerate(scan) if ADDRESS_LABEL.fullmatch(text)]
    if not labels:
        pairs = set()
        for index, (text, _) in enumerate(scan):
            municipality = parse_field("residenceMunicipality", text)
            next_index = next_line_index(scan, index) if municipality else None
            if next_index is None:
                continue
            department = scan[next_index][0]
            department_key = normalize("NFKD", department.upper()).encode("ascii", "ignore").decode()
            if " ".join(department_key.split()) in DEPARTMENTS:
                pairs.add((municipality, department))
        if len(pairs) == 1:
            return dict(zip(BACK_FIELDS, pairs.pop()))
    elif len(labels) == 1:
        municipality = next_line_index(scan, labels[0])
        department = next_line_index(scan, municipality) if municipality is not None else None
        if department is not None:
            values = [parse_field(field, scan[index][0]) for field, index in zip(BACK_FIELDS, (municipality, department))]
            if all(values):
                return dict(zip(BACK_FIELDS, values))
    return fields


def check_authenticity(access, number, front, back):
    url = access.get("authenticityUrl", "")
    api_key = access.get("authenticityApiKey", "")
    if not url or not api_key:
        return "unavailable"

    try:
        origin = urlsplit(url)
        if origin.scheme != "https" or not origin.hostname or origin.username or origin.fragment:
            return "unavailable"
        payload = json.dumps({"country": "HN", "type": "DNI", "number": number, "front": front, "back": back})
        request = Request(url, data=payload.encode(), headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key
        }, method="POST")
        with build_opener(NoRedirect).open(request, timeout=4) as response:
            result = json.loads(response.read(4096))
        if isinstance(result, dict) and result.get("status") in ("verified", "rejected"):
            return result["status"]
    except (OSError, ValueError, TypeError):
        LOG.warning("Authenticity provider unavailable")
    return "unavailable"


def read_document(event, access, key):
    front = image_bytes(event.get("front"))
    back = image_bytes(event.get("back"))
    if front == back:
        raise RequestError(400, "Carga una foto diferente para cada lado del DNI.")
    textract = client("textract")
    with ThreadPoolExecutor(max_workers=2) as pool:
        front_task = pool.submit(scan_lines, textract, front)
        back_task = pool.submit(scan_lines, textract, back)
        front_scan = front_task.result()
        back_scan = back_task.result()
    front_lines = [line for line, _ in front_scan]
    back_lines = [line for line, _ in back_scan]
    if not back_lines:
        raise RequestError(422, "No pudimos leer el reverso del DNI. Carga una foto más legible.")

    document_number = find_dni(front_lines)
    authenticity = "unavailable"
    proof = ""
    if document_number:
        authenticity = check_authenticity(access, document_number, event["front"], event["back"])
        if authenticity != "rejected":
            proof = proof_encode({
                "purpose": "document", "front": digest(front), "expires": int(time.time()) + 900
            }, key)
    return {
        "documentNumber": document_number,
        "numeroIdentidad": document_number.replace("-", "") if document_number else None,
        "fields": {**extract_fields(front_scan, FRONT_FIELDS), **extract_address(back_scan)},
        "lines": list(dict.fromkeys(front_lines + back_lines))[:35],
        "authenticity": authenticity,
        "proof": proof
    }


def start_liveness(event, key, integration_authenticity=None):
    claims = proof_decode(event.get("proof"), "document", key)
    credentials = client("sts").assume_role(
        RoleArn=os.environ["LIVENESS_STREAM_ROLE_ARN"],
        RoleSessionName="OnboardingLiveness",
        DurationSeconds=900
    )["Credentials"]
    session = client("rekognition").create_face_liveness_session(
        ClientRequestToken=str(uuid.uuid4()),
        Settings={
            "AuditImagesLimit": 0,
            "ChallengePreferences": [{"Type": "FaceMovementChallenge"}],
        },
    )["SessionId"]
    session_claims = {
        "purpose": "liveness", "front": claims["front"], "session": session,
        "expires": int(time.time()) + 180,
    }
    if integration_authenticity is not None:
        session_claims.update(purpose="integrationLiveness", authenticity=integration_authenticity)
    return {
        "sessionId": session,
        "challengeType": "FaceMovementChallenge",
        "region": REGION,
        "proof": proof_encode(session_claims, key),
        "credentials": {
            "accessKeyId": credentials["AccessKeyId"],
            "secretAccessKey": credentials["SecretAccessKey"],
            "sessionToken": credentials["SessionToken"]
        }
    }


def finish_liveness(event, key, integration=False):
    claims = proof_decode(event.get("proof"), "integrationLiveness" if integration else "liveness", key)
    front = image_bytes(event.get("front"))
    if not hmac.compare_digest(claims["front"], digest(front)):
        raise RequestError(400, "La imagen cambió durante la sesión. Vuelve a leer el DNI.")
    rekognition = client("rekognition")
    session = rekognition.get_face_liveness_session_results(SessionId=claims["session"])
    if integration and session.get("Status") in {"CREATED", "IN_PROGRESS"}:
        return {"liveness": "pending", "faceMatch": "pending"}
    ref_image = session.get("ReferenceImage", {}).get("Bytes")
    liveness_threshold = float(os.environ.get("LIVENESS_THRESHOLD", "90"))
    if session.get("Status") != "SUCCEEDED" or session.get("Confidence", 0) < liveness_threshold or not ref_image:
        return {"liveness": "retry", "faceMatch": "pending"}

    try:
        result = rekognition.compare_faces(
            SourceImage={"Bytes": ref_image}, TargetImage={"Bytes": front},
            SimilarityThreshold=float(os.environ.get("FACE_MATCH_THRESHOLD", "95")),
            QualityFilter="AUTO"
        )
        matches = bool(result.get("FaceMatches"))
    except ClientError as error:
        if error.response["Error"]["Code"] not in {"InvalidParameterException", "InvalidImageFormatException"}:
            raise
        matches = False

    return {"liveness": "passed", "faceMatch": "passed" if matches else "review"}


def start_integration(event, access, key):
    document = read_document(event, access, key)
    proof = document.pop("proof")
    document.pop("lines")
    if document["authenticity"] == "rejected":
        return {"status": "rejected_document", "document": document}
    if not proof:
        return {"status": "retry_document", "document": document}
    session = start_liveness({"proof": proof}, key, document["authenticity"])
    return {"status": "awaiting_capture", "document": document, "capture": session}


def integration_result(event, key):
    claims = proof_decode(event.get("proof"), "integrationLiveness", key)
    result = finish_liveness(event, key, integration=True)
    authenticity = claims["authenticity"]
    if result["liveness"] == "pending":
        status = "awaiting_capture"
    elif result["liveness"] == "retry":
        status = "retry_capture"
    elif result["faceMatch"] == "passed" and authenticity == "verified":
        status = "verified"
    else:
        status = "review"
    return {**result, "authenticity": authenticity, "status": status}


def handler(event, _context):
    try:
        action = event.get("action")
        integration = action in ("integrationStart", "integrationResult")
        if not integration and action not in ("authorize", "read", "start", "finish"):
            raise RequestError(400, "Solicitud inválida.")
        access = json.loads(secret("ACCESS_SECRET_ARN"))
        if integration:
            token = access.get("integrationToken")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
                raise RequestError(503, "La integración bancaria no está habilitada.")
            if not code_allowed(event.get("token"), token):
                raise RequestError(403, "El token de integración no es válido.")
        elif not code_allowed(event.get("code"), access.get("accessCode")):
            raise RequestError(403, "El código de acceso no es válido.")
        if action == "authorize":
            return {"status": 200, "body": {"ok": True}}

        key = secret("PROOF_SECRET_ARN")
        if action == "read":
            result = read_document(event, access, key)
        elif action == "start":
            result = start_liveness(event, key)
        elif action == "integrationStart":
            result = start_integration(event, access, key)
        elif action == "integrationResult":
            result = integration_result(event, key)
        else:
            result = finish_liveness(event, key)
        return {"status": 200, "body": result}
    except RequestError as error:
        return {"status": error.status, "body": {"message": str(error)}}
    except ClientError as error:
        code = error.response["Error"]["Code"]
        if code == "SessionNotFoundException":
            return {"status": 409, "body": {"message": "La sesión de cámara caducó. Activa la cámara para iniciar otra."}}
        if code in {"BadDocumentException", "UnsupportedDocumentException", "InvalidImageFormatException"}:
            return {"status": 422, "body": {"message": "No pudimos leer la imagen. Carga una foto nueva del DNI."}}
        LOG.warning("AWS verification request failed: %s", code)
    except Exception as error:
        LOG.warning("Verification failed: %s", type(error).__name__)
    return {"status": 502, "body": {"message": "El servicio de verificación no respondió. Inténtalo de nuevo."}}
