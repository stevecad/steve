"""Linux environment boundaries that affect frozen apps and host processes."""
import os
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from steve_desktop.host_environment import host_environment
from steve_desktop.local_mcp import LocalMCP


@unittest.skipUnless(sys.platform=='linux','Linux packaging')
class HostEnvironmentTests(unittest.TestCase):
    def test_appimage_mcp_uses_durable_image_path(self):
        with patch('steve_desktop.local_mcp.sys.platform', 'linux'), \
             patch('steve_desktop.local_mcp.sys.frozen', True, create=True), \
             patch.dict(os.environ, {'APPIMAGE': '/home/user/Steve CAD.AppImage',
                                     'APPIMAGE_EXTRACT_AND_RUN': '1'}):
            config = LocalMCP.status(SimpleNamespace(enabled=False, tools={}))['configuration']['mcpServers']['steve']
            self.assertEqual(config['command'], '/home/user/Steve CAD.AppImage')
            self.assertEqual(config['args'], ['--mcp'])
            self.assertEqual(config['env'], {'APPIMAGE_EXTRACT_AND_RUN': '1'})

    def test_frozen_linux_restores_host_library_path(self):
        with patch('steve_desktop.host_environment.sys.platform', 'linux'), \
             patch('steve_desktop.host_environment.sys.frozen', True, create=True), \
             patch.dict(os.environ, {'LD_LIBRARY_PATH': '/bundle', 'LD_LIBRARY_PATH_ORIG': '/host'}):
            env = host_environment()
            self.assertEqual(env['LD_LIBRARY_PATH'], '/host')
            self.assertNotIn('LD_LIBRARY_PATH_ORIG', env)
            self.assertEqual(os.environ['LD_LIBRARY_PATH'], '/bundle')

    def test_frozen_linux_removes_bundle_path_when_host_had_none(self):
        with patch('steve_desktop.host_environment.sys.platform', 'linux'), \
             patch('steve_desktop.host_environment.sys.frozen', True, create=True), \
             patch.dict(os.environ, {'LD_LIBRARY_PATH': '/bundle', 'LD_LIBRARY_PATH_ORIG': ''}):
            self.assertNotIn('LD_LIBRARY_PATH', host_environment())

    def test_host_qt_helpers_do_not_load_bundled_plugins(self):
        with patch('steve_desktop.host_environment.sys.platform', 'linux'), \
             patch('steve_desktop.host_environment.sys.frozen', True, create=True), \
             patch('steve_desktop.host_environment.sys._MEIPASS', '/bundle', create=True), \
             patch.dict(os.environ, {'QT_PLUGIN_PATH': '/bundle/Qt/plugins:/host/plugins',
                                     'QML2_IMPORT_PATH': '/bundle/Qt/qml'}):
            env = host_environment()
            self.assertEqual(env['QT_PLUGIN_PATH'], '/host/plugins')
            self.assertNotIn('QML2_IMPORT_PATH', env)
