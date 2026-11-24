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
from functools import lru_cache
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

LOG = logging.getLogger(__name__)
REGION = os.getenv("AWS_REGION", "us-east-1")
MAX_ENCODED_IMAGE = 420_000
DNI = re.compile(r"(?<![0-9])([0-9]{4})[ \u00a0‐–-]?([0-9]{4})[ \u00a0‐–-]?([0-9]{5})(?![0-9])")
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


def get_lines(textract, image):
    response = textract.detect_document_text(Document={"Bytes": image})
    return [
        block["Text"][:200].strip()
        for block in response.get("Blocks", [])
        if block.get("BlockType") == "LINE" and block.get("Text") and block.get("Confidence", 0) >= 75
    ]


def find_dni(lines):
    candidates = {"-".join(match.groups()) for line in lines for match in DNI.finditer(line)}
    return next(iter(candidates)) if len(candidates) == 1 else None


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
        front_scan = pool.submit(get_lines, textract, front)
        back_scan = pool.submit(get_lines, textract, back)
        front_lines = front_scan.result()
        back_lines = back_scan.result()
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
        "lines": list(dict.fromkeys(front_lines + back_lines))[:35],
        "authenticity": authenticity,
        "proof": proof
    }


def start_liveness(event, key):
    claims = proof_decode(event.get("proof"), "document", key)
    credentials = client("sts").assume_role(
        RoleArn=os.environ["LIVENESS_STREAM_ROLE_ARN"],
        RoleSessionName="OnboardingLiveness",
        DurationSeconds=900
    )["Credentials"]
    session = client("rekognition").create_face_liveness_session(
        ClientRequestToken=str(uuid.uuid4()), Settings={"AuditImagesLimit": 0}
    )["SessionId"]
    return {
        "sessionId": session,
        "region": REGION,
        "proof": proof_encode({
            "purpose": "liveness", "front": claims["front"], "session": session,
            "expires": int(time.time()) + 180
        }, key),
        "credentials": {
            "accessKeyId": credentials["AccessKeyId"],
            "secretAccessKey": credentials["SecretAccessKey"],
            "sessionToken": credentials["SessionToken"]
        }
    }


def finish_liveness(event, key):
    claims = proof_decode(event.get("proof"), "liveness", key)
    front = image_bytes(event.get("front"))
    if not hmac.compare_digest(claims["front"], digest(front)):
        raise RequestError(400, "La imagen cambió durante la sesión. Vuelve a leer el DNI.")
    rekognition = client("rekognition")
    session = rekognition.get_face_liveness_session_results(SessionId=claims["session"])
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


def handler(event, _context):
    try:
        action = event.get("action")
        if action not in ("authorize", "read", "start", "finish"):
            raise RequestError(400, "Solicitud inválida.")
        access = json.loads(secret("ACCESS_SECRET_ARN"))
        if not code_allowed(event.get("code"), access.get("accessCode")):
            raise RequestError(403, "El código de acceso no es válido.")
        if action == "authorize":
            return {"status": 200, "body": {"ok": True}}

        key = secret("PROOF_SECRET_ARN")
        if action == "read":
            result = read_document(event, access, key)
        elif action == "start":
            result = start_liveness(event, key)
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
