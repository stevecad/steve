"""Bounded, encrypted diagnostics. Never collect frame locals or request bodies."""
import re
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from steve_desktop.vault import Vault

_lock = threading.RLock()


def _redact(text, secrets=()):
    text = str(text)
    for secret in sorted((str(s) for s in secrets if s and len(str(s)) >= 4), key=len, reverse=True):
        text = text.replace(secret, '[redacted]')
    text = re.sub(r'https?://[^\s<>\"\']+', '[URL omitted]', text)
    text = re.sub(r'data:image/[^\s\"\']+', '[image omitted]', text)
    text = re.sub(r'(?i)(bearer\s+)[^\s,;\"\']+', r'\1[redacted]', text)
    text = re.sub(r'(?i)([\"\']?(?:\w*token|\w*secret|password|authorization|api[_-]?key)[\"\']?\s*[:=]\s*)[\"\']?[^\s,;\"\']+', r'\1[redacted]', text)
    text = re.sub(r'[A-Za-z0-9_+/=.-]{80,}', '[long value omitted]', text)
    return text


def redact(text, secrets=()):
    return _redact(text, secrets)[:4000]


EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
# C:\Users\<name>, C:/Users/<name> (also JSON-escaped), /home/<name>, /Users/<name>.
HOME_FOLDERS = (
    (re.compile(r'(?i)\b([A-Z]:(?:\\{1,2}|/)(?:Users|Documents and Settings)(?:\\{1,2}|/))[^\\/\r\n"\'<>:|*?]+'), r'\1[user]'),
    (re.compile(r'(/home/)[^/\s"\'<>]+'), r'\1[user]'),
    (re.compile(r'(/Users/)[^/\s"\'<>]+'), r'\1[user]'),
)


def redact_report(text, secrets=(), home=None, user=None):
    """Redaction for a log the person sends with a report: the diagnostics rules (without
    their per-message length cap) plus email addresses, home folders and the account name."""
    import getpass
    text = str(text)
    if home is None:
        home = str(Path.home())
    if user is None:
        try:
            user = getpass.getuser()
        except Exception:
            user = ''
    text = _redact(text, secrets)
    text = EMAIL.sub('[email]', text)
    for pattern, replacement in HOME_FOLDERS:
        text = pattern.sub(replacement, text)
    homes = []
    if home and len(home) > 3:  # A home folder outside the usual locations.
        homes.append(home)
        try:
            # Tracebacks often contain the resolved path when the home directory
            # itself is a symlink (another disk, or a bind mount).
            resolved = str(Path(home).resolve())
        except OSError:
            resolved = ''
        if resolved and len(resolved) > 3 and resolved not in homes:
            homes.append(resolved)
    forms = []
    for item in homes:
        forms.extend((item, item.replace('\\', '/'), item.replace('\\', '\\\\')))
    for form in sorted(set(forms), key=len, reverse=True):
        if len(form) > 3:
            text = re.sub(re.escape(form) + r'(?![A-Za-z0-9._-])', '[home]', text, flags=re.I)
    if user and len(user) >= 3:
        text = re.sub(r'(?<![A-Za-z0-9])' + re.escape(user) + r'(?![A-Za-z0-9])', '[user]', text, flags=re.I)
    return text


def tail_bytes(text, limit):
    """The most recent part of a log, at most `limit` UTF-8 bytes, starting on a whole line."""
    data = text.encode('utf-8')
    if len(data) <= limit:
        return text, False
    cut = data[-limit:].decode('utf-8', errors='ignore')
    newline = cut.find('\n')
    return (cut[newline + 1:] if 0 <= newline < len(cut) - 1 else cut), True


def secret_values(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if any(word in key.lower() for word in ('token', 'secret', 'password', 'api_key')) or key == 'env':
                if isinstance(item, dict):
                    yield from (str(v) for v in item.values())
                elif item:
                    yield str(item)
            elif isinstance(item, (dict, list)):
                yield from secret_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from secret_values(item)


class Diagnostics:
    def __init__(self, directory):
        self.vault = Vault(Path(directory) / 'logs' / 'steve_desktop.diagnostics.dpapi')

    def read(self):
        with _lock:
            return self.vault.load().get('entries', [])

    def record(self, exc, operation, secrets=()):
        identifier = uuid.uuid4().hex[:12]
        errors = []
        seen = set()
        def visit(error):
            if id(error) in seen or len(errors) >= 12:
                return
            seen.add(id(error))
            from pydantic import ValidationError
            message = str(error.errors(include_input=False, include_context=False, include_url=False)) if isinstance(error, ValidationError) else str(error)
            errors.append({'type': type(error).__name__, 'message': redact(message, secrets),
                           'frames': [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                                      for f in traceback.extract_tb(error.__traceback__)[-25:]]})
            if isinstance(error, BaseExceptionGroup):
                for child in error.exceptions: visit(child)
            cause = error.__cause__ or (error.__context__ if not error.__suppress_context__ else None)
            if cause: visit(cause)
        visit(exc)
        entry = {'id': identifier, 'time': datetime.now(timezone.utc).isoformat(),
                 'operation': redact(operation, secrets), 'errors': errors}
        with _lock:
            entries = self.read()
            self.vault.save({'entries': [entry, *entries][:100]})
        return identifier


def local_log(directory):
    """The app's local log in time order: recorded failures and the last update result."""
    lines = []
    try:
        entries = Diagnostics(directory).read()
    except Exception:
        entries = []
        lines.append('(The encrypted diagnostics log could not be read.)')
    for entry in reversed(entries):
        lines.append(f"{entry.get('time', '')} {entry.get('operation', '')} [{entry.get('id', '')}]")
        for error in entry.get('errors', []):
            lines.append(f"  {error.get('type', 'Error')}: {error.get('message', '')}")
            for frame in error.get('frames', [])[-8:]:
                lines.append(f"    at {frame.get('file')}:{frame.get('line')} in {frame.get('function')}")
    report = Path(directory) / 'updates' / 'last-update.json'
    try:
        import json
        result = json.loads(report.read_text(encoding='utf-8-sig'))
        lines.append('Last update: ' + ', '.join(f'{key}={result[key]}' for key in ('status', 'version', 'error', 'warning') if result.get(key)))
    except (OSError, ValueError, AttributeError):
        pass
    return '\n'.join(lines)


def report_error(exc, directory, operation, config=None, source=None):
    from steve_desktop.chat_ui import safe_error
    message = safe_error(exc)
    try:
        secrets = list(secret_values(config or {}))
        if source is not None and hasattr(source, 'vault'):
            secrets.extend(secret_values(source.vault.load()))
        identifier = Diagnostics(directory).record(exc, operation, secrets)
        return f'{message} Details: Settings → Steve → Diagnostics · {identifier}'
    except Exception:
        return f'{message} Diagnostic log could not be saved.'
