"""Generate small LZMA1 raw streams + expected plaintext for the decoder tests.

Python's lzma is the reference implementation here: the fixtures are produced
once, committed, and the TypeScript decoder must reproduce the plaintext.
"""
import json
import lzma
import os
import binascii

OUT = os.path.join(os.path.dirname(__file__), 'fixtures')

CASES = []


def add(name, text, *, lc=3, lp=0, pb=2, dict_size=1 << 20):
    filters = [{
        'id': lzma.FILTER_LZMA1,
        'dict_size': dict_size,
        'lc': lc,
        'lp': lp,
        'pb': pb,
    }]
    raw = text.encode('utf-8')
    compressed = lzma.compress(raw, format=lzma.FORMAT_RAW, filters=filters)
    first = (pb * 5 + lp) * 9 + lc
    props = bytes([first]) + dict_size.to_bytes(4, 'little')
    CASES.append({
        'name': name,
        'lc': lc,
        'lp': lp,
        'pb': pb,
        'dictSize': dict_size,
        'plainHex': binascii.hexlify(raw).decode(),
        'streamHex': binascii.hexlify(compressed).decode(),
        'propsHex': binascii.hexlify(props).decode(),
        'plainBytes': len(raw),
    })
    print(name, 'plain', len(raw), 'compressed', len(compressed))


add('literals', 'The quick brown fox jumps over the lazy dog. ' * 3
    + ''.join(chr(65 + (i * 7) % 26) for i in range(200)))
add('matches', ('ABCD' * 500) + ('xyz' * 300) + ('linker::symbol ' * 200))
add('repeats', 'aaaa' * 1000)
add('mixed-lc0', 'KiCad kicad-cli --version 10.0.7\n' * 40 + 'Ω≈ç√∫˜µ≤≥÷' * 20, lc=0, lp=0, pb=0)
add('mixed-lc4-lp2', ('solidcraft-cli 0.49.1\n' * 30) + ('dsh/sidebar-right ' * 50), lc=3, lp=1, pb=1)
add('binary-ish', ''.join(chr(32 + ((i * 37) % 90)) for i in range(4000)), lc=3, lp=0, pb=2)
add('tiny', 'ab')
add('empty-ish', 'x')

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'lzma-cases.json'), 'w', encoding='utf-8') as handle:
    json.dump(CASES, handle, indent=1)
print('cases', len(CASES))
