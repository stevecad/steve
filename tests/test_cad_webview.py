import unittest
from unittest.mock import Mock, patch

from steve_desktop.cad_webview import install_paste_event_filter


class PasteEventFilterTests(unittest.TestCase):
    def choose(self, platform):
        host, view, application = Mock(), Mock(), Mock()
        with patch('steve_desktop.cad_webview.sys.platform', platform):
            install_paste_event_filter(host, view, application)
        return host, view, application

    def test_linux_and_darwin_filter_the_cad_view(self):
        for platform in ('linux', 'darwin'):
            with self.subTest(platform=platform):
                host, view, application = self.choose(platform)
                view.installEventFilter.assert_called_once_with(host)
                host.install_paste_filter.assert_called_once_with()
                view.loadFinished.connect.assert_called_once_with(host.install_paste_filter)
                application.installEventFilter.assert_not_called()

    def test_windows_filters_the_application(self):
        host, view, application = self.choose('win32')
        application.installEventFilter.assert_called_once_with(host)
        view.installEventFilter.assert_not_called()
        host.install_paste_filter.assert_not_called()
        view.loadFinished.connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
