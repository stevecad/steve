"""Download the Windows Node.js runtime for the bundled sketch solver, verified by SHA-256.

The Windows desktop ships node.exe in vendor/solver so constrained sketches solve
without a Node installation. The binary is not committed: builds fetch this exact
official release from nodejs.org and refuse it unless its SHA-256 matches the pin
below (from https://nodejs.org/dist/v24.13.0/SHASUMS256.txt, entry win-x64/node.exe).
Its license is vendor/solver/NODE-LICENSE.

Usage: python tools/fetch_node.py [--check]
"""
import argparse
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = '24.13.0'
NODE_URL = f'https://nodejs.org/dist/v{NODE_VERSION}/win-x64/node.exe'
NODE_SHA256 = 'd14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11'
TARGET = ROOT / 'vendor/solver/node.exe'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def verified(path=TARGET):
    return path.is_file() and sha256(path) == NODE_SHA256


def ensure(target=TARGET):
    """Leave a verified node.exe at target, downloading it only when absent or different."""
    if verified(target):
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, partial = tempfile.mkstemp(prefix='node-', suffix='.partial', dir=target.parent)
    try:
        with os.fdopen(handle, 'wb') as out, urllib.request.urlopen(NODE_URL, timeout=120) as response:
            while block := response.read(1 << 20):
                out.write(block)
        actual = sha256(partial)
        if actual != NODE_SHA256:
            raise RuntimeError(f'{NODE_URL} has SHA-256 {actual}, expected {NODE_SHA256}; refusing it.')
        os.replace(partial, target)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='only verify the existing file; never download')
    args = parser.parse_args()
    if args.check:
        if not verified():
            sys.exit(f'{TARGET} is missing or is not Node.js {NODE_VERSION} (win-x64); run tools/fetch_node.py.')
    else:
        ensure()
    print(f'{TARGET}: Node.js {NODE_VERSION} win-x64, SHA-256 verified.')


if __name__ == '__main__':
    main()
