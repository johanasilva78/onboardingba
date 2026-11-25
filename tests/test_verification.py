import base64
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import Mock, patch


# Lambda supplies boto3 in AWS. Unit tests exercise the workflow without network or credentials.
boto = types.ModuleType("boto3")
botocore = types.ModuleType("botocore")
config = types.ModuleType("botocore.config")
exceptions = types.ModuleType("botocore.exceptions")
config.Config = Mock()


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


exceptions.ClientError = ClientError
spec = importlib.util.spec_from_file_location("verification_handler", Path(__file__).parents[1] / "lambda/handler.py")
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "boto3": boto, "botocore": botocore, "botocore.config": config, "botocore.exceptions": exceptions
}):
    spec.loader.exec_module(module)

CODE = "example-test-code-abcdefghijklmnopqrstuvwxyz"
KEY = "independent-server-proof-key"
FRONT = base64.b64encode(b"\xff\xd8\xff" + b"front" * 20 + b"\xff\xd9").decode()
BACK = base64.b64encode(b"\xff\xd8\xff" + b"back" * 20 + b"\xff\xd9").decode()
SESSION = "example-session"


def text_block(text, left=None, top=None, confidence=97):
    block = {"BlockType": "LINE", "Confidence": confidence, "Text": text}
    if left is not None:
        block["Geometry"] = {"BoundingBox": {"Left": left, "Top": top, "Height": 0.015}}
    return block


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.access = {"accessCode": CODE}
        self.services = {name: Mock() for name in ("textract", "rekognition", "sts")}
        self.services["textract"].detect_document_text.side_effect = lambda Document: {
            "Blocks": [text_block("0000-0000-00000"), text_block("EJEMPLO")] if
            Document["Bytes"] == base64.b64decode(FRONT) else [text_block("REVERSO")]
        }
        self.rekognition = self.services["rekognition"]
        self.rekognition.create_face_liveness_session.return_value = {"SessionId": SESSION}
        self.rekognition.get_face_liveness_session_results.return_value = {
            "Status": "SUCCEEDED", "Confidence": 97, "ReferenceImage": {"Bytes": b"example-face"}
        }
        self.rekognition.compare_faces.return_value = {"FaceMatches": [{"Similarity": 99}]}
        self.services["sts"].assume_role.return_value = {"Credentials": {
            "AccessKeyId": "test", "SecretAccessKey": "test", "SessionToken": "test"
        }}
        self.enterContext(patch.object(module, "client", side_effect=self.services.__getitem__))
        self.enterContext(patch.object(module, "secret", side_effect=lambda name: (
            json.dumps(self.access) if name == "ACCESS_SECRET_ARN" else KEY
        )))
        self.enterContext(patch.dict(os.environ, {"LIVENESS_STREAM_ROLE_ARN": "example"}))

    def call(self, action, **payload):
        return module.handler({"action": action, "code": CODE, **payload}, None)

    def session(self):
        document = self.call("read", front=FRONT, back=BACK)["body"]
        return self.call("start", proof=document["proof"])["body"]

    def test_verification_workflow_uses_reference_frame_and_front(self):
        document = self.call("read", front=FRONT, back=BACK)
        self.assertEqual(document["status"], 200)
        self.assertEqual(document["body"]["documentNumber"], "0000-0000-00000")
        self.assertEqual(document["body"]["authenticity"], "unavailable")
        self.assertIn("REVERSO", document["body"]["lines"])
        session = self.call("start", proof=document["body"]["proof"])
        self.assertEqual(session["body"]["sessionId"], SESSION)
        self.assertEqual(session["body"]["challengeType"], "FaceMovementChallenge")
        self.assertEqual(self.rekognition.create_face_liveness_session.call_args.kwargs["Settings"], {
            "AuditImagesLimit": 0, "ChallengePreferences": [{"Type": "FaceMovementChallenge"}],
        })
        result = self.call("finish", front=FRONT, proof=session["body"]["proof"])
        self.assertEqual(result["body"], {"liveness": "passed", "faceMatch": "passed"})
        self.rekognition.compare_faces.assert_called_once_with(
            SourceImage={"Bytes": b"example-face"}, TargetImage={"Bytes": base64.b64decode(FRONT)},
            SimilarityThreshold=95, QualityFilter="AUTO"
        )

    def test_declines_forged_and_expired_proofs(self):
        proof = module.proof_encode({"purpose": "document", "front": "fake", "expires": time.time() + 60}, CODE)
        expired = module.proof_encode({"purpose": "document", "front": "fake", "expires": 0}, KEY)
        for token in (proof, expired, "invalid"):
            self.assertEqual(self.call("start", proof=token)["status"], 409)
        self.rekognition.create_face_liveness_session.assert_not_called()

    def test_rejects_changed_document_and_bad_access(self):
        proof = self.session()["proof"]
        self.assertEqual(self.call("finish", front=BACK, proof=proof)["status"], 400)
        self.assertEqual(module.handler({"action": "authorize", "code": "incorrect"}, None)["status"], 403)
        self.rekognition.get_face_liveness_session_results.assert_not_called()

    def test_low_liveness_skips_face_comparison(self):
        self.rekognition.get_face_liveness_session_results.return_value["Confidence"] = 51
        result = self.call("finish", front=FRONT, proof=self.session()["proof"])
        self.assertEqual(result["body"], {"liveness": "retry", "faceMatch": "pending"})
        self.rekognition.compare_faces.assert_not_called()

    def test_missing_document_portrait_requires_review(self):
        self.rekognition.compare_faces.side_effect = ClientError("InvalidParameterException")
        result = self.call("finish", front=FRONT, proof=self.session()["proof"])
        self.assertEqual(result["body"], {"liveness": "passed", "faceMatch": "review"})

    def test_document_rejected_by_provider_cannot_proceed(self):
        with patch.object(module, "check_authenticity", return_value="rejected"):
            result = self.call("read", front=FRONT, back=BACK)
            self.assertEqual(result["body"]["authenticity"], "rejected")
            self.assertEqual(result["body"]["proof"], "")

    def test_document_number_disambiguation_and_distinct_sides(self):
        self.assertEqual(module.find_dni(["N.º 1234 2020 12345", "1234202012345"]), "1234-2020-12345")
        self.assertIsNone(module.find_dni(["1234-2020-12345", "4321-2020-54321"]))
        self.assertEqual(self.call("read", front=FRONT, back=FRONT)["status"], 400)

    def test_reads_bilingual_front_fields_in_separate_columns(self):
        front_blocks = [
            text_block("NOMBRE / FORENAME", 0.40, 0.20),
            text_block("APELLIDO/SURNAME", 0.68, 0.20),
            text_block("EJEMPLO DE PRUEBA", 0.68, 0.23),
            text_block("ANA MARÍA", 0.40, 0.23),
            text_block("FECHA DE NACIMIENTO / DATE OF BIRTH: 29-02-2000"),
            text_block("FECHA DE EXPIRACIÓN/DATE OF EXPIRY", 0.42, 0.64),
            text_block("05-10-2030", 0.42, 0.67),
            text_block("NACIONALIDAD / NATIONALITY: HND"),
            text_block("LUGAR DE NACIMIENTO / PLACE OF BIRTH: SANTA ROSA DE COPÁN"),
            text_block("0000 0000 00000"),
        ]
        self.services["textract"].detect_document_text.side_effect = lambda Document: {
            "Blocks": front_blocks if Document["Bytes"] == base64.b64decode(FRONT) else [
                text_block("REVERSO"), text_block("NOMBRE: DATO DEL REVERSO"),
                text_block("MUNICIPIO DE DOMICILIO: SANTA ROSA DE COPÁN"),
                text_block("DEPARTAMENTO DE DOMICILIO: COPÁN"),
            ]
        }
        result = self.call("read", front=FRONT, back=BACK)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["documentNumber"], "0000-0000-00000")
        self.assertEqual(result["body"]["numeroIdentidad"], "0000000000000")
        self.assertEqual(result["body"]["fields"], {
            "givenNames": "ANA MARÍA", "surnames": "EJEMPLO DE PRUEBA",
            "birthDate": "2000-02-29", "expiryDate": "2030-10-05",
            "nationality": "HND", "birthplace": "SANTA ROSA DE COPÁN",
            "residenceMunicipality": "SANTA ROSA DE COPÁN", "residenceDepartment": "COPÁN",
        })

    def test_reads_two_aligned_address_lines_under_one_label(self):
        def line(text, left, top):
            return text, {"Left": left, "Top": top, "Height": 0.02}

        scan = [
            line("DOMICILIO / ADDRESS", .34, .25),
            line("COMAYAGUA", .34, .35),
            line("SIGUIENTE COLUMNA", .71, .28),
            line("SIGUATEPEQUE", .34, .30),
            line("I<HND123456<<<", .05, .70),
        ]
        self.assertEqual(module.extract_address(scan), {
            "residenceMunicipality": "SIGUATEPEQUE", "residenceDepartment": "COMAYAGUA",
        })
        self.assertEqual(module.extract_address(scan[:-2]), {
            "residenceMunicipality": None, "residenceDepartment": None,
        })

    def test_missing_low_confidence_or_conflicting_fields_remain_unread(self):
        self.services["textract"].detect_document_text.side_effect = lambda Document: {
            "Blocks": [
                text_block("NOMBRE: ANA"), text_block("NOMBRE: MARÍA"),
                text_block("APELLIDO: EJEMPLO", confidence=60),
                text_block("FECHA DE NACIMIENTO: 31-02-2001"),
                text_block("FECHA DE VENCIMIENTO"), text_block("FIRMA / SIGNATURE"),
                text_block("0000-0000-00000"),
            ] if Document["Bytes"] == base64.b64decode(FRONT) else [text_block("REVERSO")],
        }
        result = self.call("read", front=FRONT, back=BACK)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["fields"], {
            "givenNames": None, "surnames": None, "birthDate": None, "expiryDate": None,
            "nationality": None, "birthplace": None,
            "residenceMunicipality": None, "residenceDepartment": None,
        })

    def test_reads_address_when_textract_omits_the_label(self):
        scan = [
            ("0000000000000000", None),
            ("DISTRITO CENTRAL", None),
            ("FRANCISCO MORAZAN", None),
            ("COMISIONADOS PROPIETARIOS", None),
        ]
        self.assertEqual(module.extract_address(scan), {
            "residenceMunicipality": "DISTRITO CENTRAL", "residenceDepartment": "FRANCISCO MORAZAN",
        })
        self.assertIsNone(module.extract_address(scan + [
            ("SIGUATEPEQUE", None), ("COMAYAGUA", None),
        ])["residenceMunicipality"])
