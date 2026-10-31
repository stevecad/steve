import asyncio
import base64
import io
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from fastapi import HTTPException
from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.providers.openai_chatgpt import OpenAIChatGPTProvider
from steve_desktop.chat_images import ChatImages
from steve_desktop.runtime import SubscriptionModel
from steve_desktop.service import Service
from steve_desktop.vault import Vault
from steve_desktop.diagnostics import Diagnostics, redact


def png():
    stream = io.BytesIO()
    Image.new('RGB', (180, 90), '#6ac8a4').save(stream, 'PNG')
    return stream.getvalue()


class ImageTests(unittest.TestCase):
    def test_encrypted_image_and_responses_wire_format_survive_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            images = ChatImages(folder)
            meta = images.save(png(), 'Bracket.png')
            self.assertNotIn(b'PNG', images.vault(meta['id']).path.read_bytes())
            metadata, content = ChatImages(folder).resolve([meta['id']])
            self.assertEqual(metadata[0]['width'], 180)
            messages = [ModelRequest(parts=[UserPromptPart(['Inspect this bracket', *content])])]
            vault = Vault(Path(folder) / 'history.dpapi')
            vault.save({'history': ModelMessagesTypeAdapter.dump_python(messages, mode='json')})
            restored = ModelMessagesTypeAdapter.validate_python(vault.load()['history'])
            model = SubscriptionModel('test', provider=OpenAIChatGPTProvider(credential_source=Service(Vault(Path(folder)/'auth')).source))
            _, wire = asyncio.run(model._map_messages(restored, {}, ModelRequestParameters()))
            image = next(item for message in wire if message.get('role') == 'user' for item in message['content'] if item['type'] == 'input_image')
            self.assertTrue(image['image_url'].startswith('data:image/png;base64,'))
            self.assertEqual(base64.b64decode(image['image_url'].split(',',1)[1]), content[0].data)

    def test_invalid_images_paths_limits_and_orientation(self):
        with tempfile.TemporaryDirectory() as folder:
            images = ChatImages(folder)
            for value in (b'<svg/>', b'not an image', b'a' * (8*1024*1024+1)):
                with self.assertRaises(HTTPException): images.save(value, 'bad')
            for identifiers in (['../auth'], ['a']*5, 'not-a-list', [None]):
                with self.assertRaises(HTTPException): images.resolve(identifiers)
            large = io.BytesIO()
            image = Image.new('RGB', (2000, 1000))
            exif = Image.Exif(); exif[274] = 6
            image.save(large, 'JPEG', exif=exif)
            meta = images.save(large.getvalue(), 'rotated.jpg')
            self.assertEqual((meta['width'], meta['height']), (784, 1568))
            with Image.open(io.BytesIO(images.load(meta['id'])[1])) as clean:
                self.assertFalse(clean.getexif())

    def test_error_chain_is_encrypted_and_redacted(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Diagnostics(folder)
            try:
                try: raise ValueError('token=abc123 Bearer xyz987 https://test.invalid/?code=private named-secret')
                except ValueError as cause: raise RuntimeError('MCP initialization failed') from cause
            except Exception as exc:
                identifier = log.record(exc, 'Assistant request', ['named-secret'])
            entry = Diagnostics(folder).read()[0]
            self.assertEqual(entry['id'], identifier)
            self.assertEqual([e['type'] for e in entry['errors']], ['RuntimeError','ValueError'])
            self.assertTrue(entry['errors'][0]['frames'])
            for secret in ('abc123', 'xyz987', 'private', 'named-secret'):
                self.assertNotIn(secret, str(entry))
            self.assertNotIn(b'MCP initialization failed', log.vault.path.read_bytes())
            self.assertEqual(len(Diagnostics(folder).read()), 1)


if __name__ == '__main__': unittest.main()
