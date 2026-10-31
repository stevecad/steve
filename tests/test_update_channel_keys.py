import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from steve_desktop.local_updates import default_channel, LocalUpdates
from steve_desktop.update_manifest import channel_trust, public_key_list, signed_payload, verify_manifest, verify_stored
from steve_desktop.vault import Vault
from tests.update_signing import expires_in, keypair, public_key_text, sign


FIELDS = {'version': '1.0.0', 'platform': 'linux-x64', 'url': 'https://dl.stevecad.studio/linux/a.tar.gz', 'sha256': 'a' * 64}


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.key, self.public = keypair()

    def test_p384_sha384_der_signature_verifies(self):
        manifest = sign(self.key, **FIELDS)
        self.assertEqual(verify_manifest(manifest, [self.public], 'linux-x64')['version'], '1.0.0')
        # Exactly the documented contract: DER ECDSA over SHA-384 of the canonical payload.
        der = self.key.sign(signed_payload(manifest), ec.ECDSA(hashes.SHA384()))
        self.assertEqual(verify_manifest({**manifest, 'signature': base64.b64encode(der).decode()}, self.public, 'linux-x64')['url'], FIELDS['url'])

    def test_signature_by_another_p384_key_is_refused(self):
        stranger, _ = keypair()
        with self.assertRaisesRegex(ValueError, 'trusted'):
            verify_manifest(sign(stranger, **FIELDS), [self.public], 'linux-x64')

    def test_tampered_field_is_refused(self):
        manifest = sign(self.key, **FIELDS)
        for field, value in (('version', '1.0.1'), ('sha256', 'b' * 64), ('url', 'https://dl.stevecad.studio/linux/b.tar.gz'), ('expires', expires_in(2))):
            with self.subTest(field), self.assertRaisesRegex(ValueError, 'trusted'):
                verify_manifest({**manifest, field: value}, [self.public], 'linux-x64')

    def test_raw_r_s_signature_is_refused(self):
        manifest = sign(self.key, **FIELDS)
        r, s = decode_dss_signature(base64.b64decode(manifest['signature']))
        raw = r.to_bytes(48, 'big') + s.to_bytes(48, 'big')
        with self.assertRaises(ValueError):
            verify_manifest({**manifest, 'signature': base64.b64encode(raw).decode()}, [self.public], 'linux-x64')

    def test_only_p384_public_keys_are_accepted(self):
        ed_key = ed25519.Ed25519PrivateKey.generate()
        p256 = ec.generate_private_key(ec.SECP256R1())
        p521 = ec.generate_private_key(ec.SECP521R1())
        raw_ed25519 = base64.b64encode(ed_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
        for name, bad in (('Ed25519 SPKI', public_key_text(ed_key.public_key())), ('Ed25519 raw', raw_ed25519),
                          ('P-256', public_key_text(p256.public_key())), ('P-521', public_key_text(p521.public_key())),
                          ('not base64', 'not-a-key'), ('empty', '')):
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, 'P-384'):
                    public_key_list([bad])
                # Even next to a valid key, a bad entry makes the channel unusable.
                with self.assertRaises(ValueError):
                    verify_manifest(sign(self.key, **FIELDS), [self.public, bad], 'linux-x64')
                channel = {'host': 'dl.stevecad.studio', 'platforms': {'linux-x64': {'source': 'https://dl.stevecad.studio/linux/latest.json', 'public_keys': [bad]}}}
                with self.assertRaises(ValueError):
                    verify_stored(sign(self.key, **FIELDS), channel, {}, 'linux-x64')
        # A P-256 key signing with its own curve is refused too, not just its key format.
        manifest = {**FIELDS, 'expires': expires_in()}
        manifest['signature'] = base64.b64encode(p256.sign(signed_payload(manifest), ec.ECDSA(hashes.SHA384()))).decode()
        with self.assertRaises(ValueError):
            verify_manifest(manifest, [public_key_text(p256.public_key())], 'linux-x64')

    def test_shipped_keys_are_p384(self):
        for target in ('windows-x64', 'linux-x64'):
            keys = default_channel(target)['public_keys']
            self.assertEqual(len(keys), 1)
            self.assertEqual(public_key_list(keys), keys)


class DownloadHostTests(unittest.TestCase):
    def setUp(self):
        self.key, self.public = keypair()

    def manifest(self, url):
        return sign(self.key, **{**FIELDS, 'url': url})

    def test_shipped_host_means_port_443_only(self):
        verify_manifest(self.manifest('https://dl.stevecad.studio/linux/a.tar.gz'), self.public, 'linux-x64')
        verify_manifest(self.manifest('https://dl.stevecad.studio:443/linux/a.tar.gz'), self.public, 'linux-x64')
        for url in ('https://dl.stevecad.studio:8443/linux/a.tar.gz', 'http://dl.stevecad.studio/linux/a.tar.gz',
                    'https://evil.test/linux/a.tar.gz', 'https://user@dl.stevecad.studio/linux/a.tar.gz'):
            with self.assertRaisesRegex(ValueError, 'HTTPS from dl.stevecad.studio'):
                verify_manifest(self.manifest(url), self.public, 'linux-x64')

    def test_managed_feed_on_its_own_port(self):
        trust = channel_trust(default_channel(), {'override': {'source': 'https://127.0.0.1:34093/feed', 'public_keys': [self.public]}}, 'linux-x64')
        self.assertEqual(trust['host'], '127.0.0.1:34093')
        verify_manifest(self.manifest('https://127.0.0.1:34093/a.tar.gz'), self.public, 'linux-x64', host=trust['host'])
        for url in ('https://127.0.0.1/a.tar.gz', 'https://127.0.0.1:34094/a.tar.gz', 'https://127.0.0.2:34093/a.tar.gz'):
            with self.assertRaisesRegex(ValueError, 'HTTPS from 127.0.0.1:34093'):
                verify_manifest(self.manifest(url), self.public, 'linux-x64', host=trust['host'])

    def test_stored_state_reports_the_override_refusal(self):
        other, _ = keypair()
        config = {'override': {'source': 'https://example.test/linux/latest.json', 'public_keys': [self.public]}}
        forged = sign(other, **{**FIELDS, 'url': 'https://example.test/a.tar.gz'})
        with self.assertRaisesRegex(ValueError, 'trusted'):
            verify_stored(forged, default_channel(), config, 'linux-x64')


class ChannelKeyTests(unittest.TestCase):
    def test_each_platform_has_its_own_feed_and_trust_root(self):
        raw = json.loads((Path(__file__).resolve().parents[1] / 'assets/update-channel.json').read_text())
        self.assertEqual(set(raw['platforms']), {'windows-x64', 'linux-x64'})
        self.assertEqual(default_channel('windows-x64')['public_keys'], raw['platforms']['windows-x64']['public_keys'])
        self.assertEqual(default_channel('linux-x64')['public_keys'], raw['platforms']['linux-x64']['public_keys'])
        self.assertFalse(set(default_channel('linux-x64')['public_keys']) & set(default_channel('windows-x64')['public_keys']))
        self.assertNotIn('github', json.dumps(raw))

    def test_rotation_trusts_every_listed_key(self):
        old, old_public = keypair()
        new, new_public = keypair()
        channel = {'host': 'dl.stevecad.studio', 'platforms': {'linux-x64': {
            'source': 'https://dl.stevecad.studio/linux/latest.json', 'public_keys': [old_public, new_public]}}}
        for key in (old, new):
            manifest = sign(key, version='1.0.0', platform='linux-x64', url='https://dl.stevecad.studio/linux/a.tar.gz', sha256='a' * 64)
            self.assertEqual(verify_stored(manifest, channel, {}, 'linux-x64')['version'], '1.0.0')


class ManagedOverrideTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch('steve_desktop.local_updates.update_platform', return_value='windows-x64'))
        self.enterContext(patch('steve_desktop.local_updates.supports_portable_updates', return_value=True))
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.app = FastAPI()
        self.updater = LocalUpdates(SimpleNamespace(folder=self.folder / 'cad', app=self.app))
        self.addCleanup(self.updater.close)
        self.http = TestClient(self.app, raise_server_exceptions=False)

    def put(self, body):
        return self.http.put('/v1/local/updates', json=body)

    def test_the_app_never_changes_the_feed_or_its_keys(self):
        _, public = keypair()
        for body in ({'override': {'source': 'https://mirror.test/latest.json', 'public_keys': [public]}},
                     {'override': None}, {'source': 'https://mirror.test/latest.json'}, {'public_keys': [public]},
                     {'automatic': True, 'override': {'source': 'https://mirror.test/latest.json', 'public_keys': [public]}}):
            with self.subTest(body=body):
                self.assertGreaterEqual(self.put(body).status_code, 400)
                self.assertFalse(self.updater.status()['override'])
                self.assertEqual(self.updater.status()['source'], default_channel('windows-x64')['source'])
        self.assertFalse(self.put({'automatic': False}).json()['automatic'])
        self.assertTrue(self.put({'automatic': True}).json()['automatic'])

    def test_override_feed_still_requires_its_signature_and_host(self):
        key, public = keypair()
        stranger, _ = keypair()
        # An administrator-provisioned managed feed (the app itself can't set one).
        self.updater.config = {**self.updater.config, 'override': {'source': 'https://mirror.test/windows/latest.json', 'public_keys': [public]}}
        cases = {
            'unsigned by the configured key': sign(stranger, version='9999.0.0', platform='windows-x64', url='https://mirror.test/windows/a.zip', sha256='a' * 64),
            'package on another host': sign(key, version='9999.0.0', platform='windows-x64', url='https://dl.stevecad.studio/windows/a.zip', sha256='a' * 64),
            'expired': sign(key, version='9999.0.0', platform='windows-x64', url='https://mirror.test/windows/a.zip', sha256='a' * 64, expires=expires_in(-1)),
        }
        client = httpx.Client
        for name, manifest in cases.items():
            with self.subTest(name):
                calls = []
                def handle(request):
                    calls.append(str(request.url))
                    return httpx.Response(200, json=manifest)
                with patch('steve_desktop.local_updates.httpx.Client', side_effect=lambda **kw: client(transport=httpx.MockTransport(handle), **kw)):
                    self.updater.check()
                self.assertEqual(calls, ['https://mirror.test/windows/latest.json'])
                self.assertTrue(self.updater.status()['update_error'])
                self.assertFalse(self.updater.status()['ready'])

    def test_stored_state_verifies_under_override_or_shipped_roots_only(self):
        key, public = keypair()
        stranger, _ = keypair()
        channel = {'host': 'dl.stevecad.studio', 'platforms': {'windows-x64': {'source': 'https://dl.stevecad.studio/windows/latest.json', 'public_keys': [public]}}}
        _, override_key = keypair()
        config = {'override': {'source': 'https://mirror.test/latest.json', 'public_keys': [override_key]}}
        self.assertTrue(channel_trust(channel, config, 'windows-x64')['override'])
        shipped = sign(key, version='2.0.0', platform='windows-x64', url='https://dl.stevecad.studio/windows/a.zip', sha256='a' * 64)
        self.assertEqual(verify_stored(shipped, channel, config, 'windows-x64')['version'], '2.0.0')
        with self.assertRaises(ValueError):
            verify_stored(sign(stranger, **{k: shipped[k] for k in ('version', 'platform', 'url', 'sha256', 'expires')}), channel, config, 'windows-x64')
