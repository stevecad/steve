"""Encrypted preferences for Steve's web settings; no native settings screens."""
from pathlib import Path
from PySide6.QtCore import QObject
from steve_desktop.vault import Vault

class AgentSettings(QObject):
    def __init__(self, directory, parent=None):
        super().__init__(parent)
        self.directory = Path(directory)
        self.vault = Vault(self.directory / 'agent-settings.dpapi')
        self.config = self.vault.load()
        # Retire the previous approval policy without affecting other preferences.
        changed = any(key in self.config for key in ('approval_mode', 'remembered_approvals'))
        self.config.pop('approval_mode', None)
        self.config.pop('remembered_approvals', None)
        if changed:
            self.vault.save(self.config)

    def values(self):
        return dict(self.config)
