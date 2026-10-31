"""Shared signature contract for the application, the standalone updater and the publisher.

A manifest is {version, platform, url, sha256, expires, signature}. The signed bytes are
the UTF-8 JSON of the five other fields with sorted keys and separators (',', ':').
The signature is base64 of an ASN.1 DER ECDSA signature over SHA-384 of those bytes,
made with a P-384 (secp384r1) key. Public keys are base64 of a DER SubjectPublicKeyInfo
and must be EC P-384 keys; anything else is refused. Packages are served from https://dl.stevecad.studio (or a managed override
host); the signing keys never leave the release owner's offline vault.
"""
import base64
from datetime import datetime, timezone
import json
from urllib.parse import urlsplit

from packaging.version import Version
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_der_public_key

DOWNLOAD_HOST = 'dl.stevecad.studio'
SIGNED_FIELDS = ('version', 'platform', 'url', 'sha256', 'expires')
PLATFORMS = ('windows-x64', 'linux-x64')


def signed_payload(fields):
    return json.dumps({key: fields[key] for key in SIGNED_FIELDS}, sort_keys=True, separators=(',', ':')).encode()


def format_expires(moment):
    return moment.astimezone(timezone.utc).replace(microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_expires(value):
    if not isinstance(value, str):
        raise ValueError('Update manifest has no valid expiry time')
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError('Update manifest has no valid expiry time') from None
    if moment.tzinfo is None or moment.utcoffset().total_seconds() != 0:
        raise ValueError('Update manifest expiry must be in UTC')
    return moment


def load_public_key(key):
    """An EC P-384 public key from base64 DER SubjectPublicKeyInfo; ValueError otherwise."""
    try:
        public = load_der_public_key(base64.b64decode(key, validate=True)) if isinstance(key, str) else None
    except (ValueError, TypeError):
        public = None
    if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(public.curve, ec.SECP384R1):
        raise ValueError('Use base64 DER (SubjectPublicKeyInfo) EC P-384 public keys')
    return public


def public_key_list(keys):
    """One base64 key or a list of them (several are trusted during a key rotation)."""
    keys = [keys] if isinstance(keys, str) else list(keys or ())
    result = []
    for key in keys:
        load_public_key(key)
        result.append(key)
    if not result:
        raise ValueError('No update signing key is configured')
    return result


def verify_manifest(manifest, public_keys, expected_platform='windows-x64', *, host=DOWNLOAD_HOST,
                    now=None, check_expiry=True):
    """Return the signed fields when one of the trusted keys signed them.

    check_expiry is turned off only to re-check an update that was already downloaded
    under a fresh manifest (staged or installed state), never for a feed response.
    """
    if not isinstance(manifest, dict) or set(SIGNED_FIELDS) - set(manifest) or not isinstance(manifest.get('signature'), str):
        raise ValueError('Update manifest is incomplete')
    fields = {key: manifest[key] for key in SIGNED_FIELDS}
    if not all(isinstance(value, str) for value in fields.values()):
        raise ValueError('Update manifest is malformed')
    if fields['platform'] != expected_platform:
        raise ValueError(f'Update is not for {expected_platform}')
    if len(fields['sha256']) != 64 or any(c not in '0123456789abcdef' for c in fields['sha256']):
        raise ValueError('Invalid package digest')
    url = urlsplit(fields['url'])
    try:
        port = url.port or 443
    except ValueError:
        port = None
    if url.scheme != 'https' or url.username or url.password or ((url.hostname or '').lower(), port) != origin(host):
        raise ValueError(f'Updates must download over HTTPS from {host}')
    Version(fields['version'])
    expires = parse_expires(fields['expires'])
    payload = signed_payload(fields)
    signature = base64.b64decode(manifest['signature'], validate=True)
    for key in public_key_list(public_keys):
        try:
            load_public_key(key).verify(signature, payload, ec.ECDSA(hashes.SHA384()))
            break
        except InvalidSignature:
            continue
    else:
        raise ValueError('Update signature is not from a trusted Steve release key')
    if check_expiry and (now or datetime.now(timezone.utc)) >= expires:
        raise ValueError('The update feed has expired; Steve will check again later')
    return fields


def origin(host):
    """(hostname, port) of a trusted download host: 'dl.stevecad.studio' (port 443) or a managed feed's 'host:port'."""
    parts = urlsplit('https://' + host)
    return (parts.hostname or '').lower(), parts.port or 443


def feed_host(source):
    """A feed URL's host as verify_manifest takes it: its hostname, plus the port when it isn't 443."""
    parts = urlsplit(source)
    hostname = parts.hostname or ''
    return hostname if parts.port in (None, 443) else f'{hostname}:{parts.port}'


def channel_trust(channel, config, target_platform):
    """The feed, keys and download host in force: a managed override, else the shipped channel."""
    override = (config or {}).get('override')
    if isinstance(override, dict) and override.get('source'):
        source = override['source']
        return {'source': source, 'public_keys': public_key_list(override.get('public_keys')),
                'host': feed_host(source), 'override': True}
    shipped = (channel.get('platforms') or {}).get(target_platform) or {}
    return {'source': shipped.get('source', ''), 'public_keys': list(shipped.get('public_keys') or ()),
            'host': channel.get('host', DOWNLOAD_HOST), 'override': False}


def verify_stored(manifest, channel, config, target_platform):
    """Re-check downloaded/installed state against every configured trust root (no expiry)."""
    roots = [channel_trust(channel, config, target_platform)]
    if roots[0]['override']:
        roots.append(channel_trust(channel, {}, target_platform))
    errors = []
    for root in roots:
        try:
            return verify_manifest(manifest, root['public_keys'], target_platform, host=root['host'], check_expiry=False)
        except ValueError as exc:
            errors.append(exc)
    raise errors[0]   # the trust root in force says why (an override's refusal, not the shipped feed's host)
