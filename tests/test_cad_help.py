"""Verify the shipped manual's local links, anchor targets, resources and scope."""
import hashlib
import json
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).parents[1] / 'cad-web/public'


class Elements(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


class CadHelpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manual = json.loads((ROOT / 'help/content.json').read_text(encoding='utf-8'))
        cls.pages = {p['path']: p for p in cls.manual['pages']}
        cls.sources = json.loads((ROOT / 'help/SOURCES.json').read_text(encoding='utf-8'))

    def test_internal_navigation_and_anchors(self):
        for path, page in self.pages.items():
            ids = [h['id'] for h in page['headings']]
            self.assertEqual(len(ids), len(set(ids)), path)
            for tag, attrs in Elements(page['html']).elements:
                if tag != 'a':
                    continue
                target = urlsplit(attrs['href'])
                self.assertFalse(target.scheme, path)
                self.assertIn(target.path, self.pages, (path, attrs['href']))
                if target.fragment:
                    self.assertIn(unquote(target.fragment), [h['id'] for h in self.pages[target.path]['headings']], (path, attrs['href']))

    def test_resources_are_bundled_and_inert(self):
        images = set()
        for page in self.pages.values():
            for tag, attrs in Elements(page['html']).elements:
                self.assertNotIn(tag, ('script', 'iframe', 'object', 'embed', 'form', 'style'))
                self.assertFalse(any(k.lower().startswith('on') for k in attrs))
                if tag == 'img':
                    self.assertTrue(attrs['src'].startswith('/help/media/'))
                    file = ROOT / attrs['src'].lstrip('/')
                    self.assertTrue(file.is_file(), str(file))
                    record = self.sources['media'][file.name]
                    self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), record['sha256'])
                    self.assertTrue(attrs.get('alt'))
                    images.add(file.name)
        self.assertEqual(images, set(self.sources['media']))

    def test_local_scope_and_entry_points(self):
        self.assertIn('/docs/local/history/', self.pages)
        self.assertIn('/docs/design/features/', self.pages)
        self.assertIn('/docs/assemblies/joints/', self.pages)
        self.assertIn('/docs/drawing/dimensions/', self.pages)
        self.assertNotIn('/docs/design/blender-scenes/', self.pages)
        self.assertNotIn('/docs/assemblies/circuit-boards/', self.pages)
        for target in self.manual['aliases'].values():
            self.assertIn(urlsplit(target).path, self.pages)
        self.assertIn('full-window preview', self.pages['/docs/drawing/export/']['search'])
        self.assertNotIn('Share link', self.pages['/docs/design/export/']['search'])
        self.assertIn('not implemented locally', self.pages['/docs/local/history/']['search'])


if __name__ == '__main__':
    unittest.main()
