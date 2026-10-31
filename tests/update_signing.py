"""Disposable P-384 keys and signed manifests for update tests (never release keys)."""
import base64
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from steve_desktop.update_manifest import format_expires, signed_payload


def public_key_text(public_key):
    """Base64 DER SubjectPublicKeyInfo, the form update channels list."""
    return base64.b64encode(public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode()


def keypair():
    key = ec.generate_private_key(ec.SECP384R1())
    return key, public_key_text(key.public_key())


def expires_in(days=1):
    return format_expires(datetime.now(timezone.utc) + timedelta(days=days))


def sign(key, **fields):
    fields.setdefault('expires', expires_in())
    signature = key.sign(signed_payload(fields), ec.ECDSA(hashes.SHA384()))
    return {**fields, 'signature': base64.b64encode(signature).decode()}
