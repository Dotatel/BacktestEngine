#!/usr/bin/env python3
"""Validate this portable design package; --write refreshes the SHA-256 manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import xml.etree.ElementTree as ET
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'design-context'
MANIFEST = PACKAGE / 'manifest.json'


def files():
    return sorted([ROOT / 'DESIGN.md'] + list((ROOT / 'Brand').rglob('*')) +
                  list(PACKAGE.rglob('*')))


def entries():
    result = []
    for path in files():
        if not path.is_file() or path == MANIFEST or '__pycache__' in path.parts:
            continue
        content = path.read_bytes()
        item = {'path': path.relative_to(ROOT).as_posix(), 'bytes': len(content),
                'sha256': hashlib.sha256(content).hexdigest()}
        if path.suffix == '.png':
            assert content[:8] == b'\x89PNG\r\n\x1a\n', path
            item['width'], item['height'] = struct.unpack('>II', content[16:24])
        result.append(item)
    return result


def check():
    errors = []
    for path in files():
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        try:
            if path.suffix == '.json':
                json.loads(path.read_text())
            if path.suffix == '.svg':
                tree = ET.parse(path)
                for node in tree.iter():
                    for key, value in node.attrib.items():
                        if key.endswith('href'):
                            assert value.startswith(('#', 'data:')), f'external SVG resource: {value}'
            if path.suffix in {'.md', '.html', '.css', '.json', '.js', '.svg'}:
                text = path.read_text()
                assert '/Users/' not in text and '/var/folders/' not in text, 'host-specific path'
                assert not re.search(r'[?&](?:X-Amz-Signature|token|access_token)=', text, re.I), 'temporary/sensitive URL'
                targets = []
                if path.suffix == '.md':
                    targets = re.findall(r'\]\(([^)]+)\)', text)
                elif path.suffix == '.html':
                    targets = re.findall(r'(?:src|href)="([^"]+)"', text)
                elif path.suffix == '.css':
                    targets = re.findall(r'url\([\'"]?([^\)\'\"]+)', text)
                for target in targets:
                    target = target.strip('<>').split('#')[0]
                    if not target or re.match(r'^[a-z]+:', target):
                        continue
                    assert (path.parent / unquote(target)).exists(), f'missing reference: {target}'
        except (AssertionError, ValueError, ET.ParseError) as exc:
            errors.append(f'{rel}: {exc}')
    interactions = json.loads((PACKAGE / 'specs/interactions.json').read_text())
    assert interactions['launcher']['exampleCount'] == 4
    assert interactions['onboarding']['order'] == ['P01', 'P02', 'P03', 'P04', 'P05']
    previews = json.loads((PACKAGE / 'assets/strategy-previews.json').read_text())
    for example in previews['examples']:
        for state in ['gray', 'color']:
            assert (PACKAGE / 'assets' / example[state]).is_file()
        assert example['crop']['x'] + example['crop']['width'] <= 1617
        assert example['crop']['y'] + example['crop']['height'] <= 973
    if errors:
        raise SystemExit('\n'.join(errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    check()
    current = entries()
    if args.write:
        MANIFEST.write_text(json.dumps({'schemaVersion': 1, 'snapshotDate': '2026-10-18',
                                       'root': 'repository', 'files': current}, indent=2) + '\n')
    else:
        saved = json.loads(MANIFEST.read_text())['files']
        assert saved == current, 'Manifest differs; review changes and run with --write.'
    print(f'OK: {len(current)} files; JSON, SVG, local references, artwork map and SHA-256 verified.')
