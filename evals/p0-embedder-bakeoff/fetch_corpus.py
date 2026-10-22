#!/usr/bin/env python3
"""
Fetch the LongMemEval-S corpus for the P0 bake-off and VERIFY its full sha256.

  python3 fetch_corpus.py                       # -> ./data/longmemeval_s_cleaned.json
  python3 fetch_corpus.py --dest DIR            # elsewhere
  python3 fetch_corpus.py --url URL --sha256 H  # override (tests use file:// fixtures)

Downloads to a temp file, hashes it, and only then moves it into place. A mismatch exits 1,
names BOTH hashes, and leaves nothing at the destination. A corpus is never fabricated.
"""
import argparse, hashlib, os, shutil, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_DATASET = "xiaowu0162/longmemeval-cleaned"
CORPUS_FILE = "longmemeval_s_cleaned.json"
CORPUS_URL = f"https://huggingface.co/datasets/{CORPUS_DATASET}/resolve/main/{CORPUS_FILE}"
CORPUS_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
CHUNK = 1 << 20


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(CHUNK), b''):
            h.update(block)
    return h.hexdigest()


def fetch(url, dest_dir, expected):
    """Return 0 on success (file verified and in place), 1 on checksum mismatch, 2 on download error."""
    os.makedirs(dest_dir, exist_ok=True)
    final = os.path.join(dest_dir, CORPUS_FILE)
    fd, tmp = tempfile.mkstemp(dir=dest_dir, suffix='.part')
    os.close(fd)
    try:
        try:
            with urllib.request.urlopen(url, timeout=600) as r, open(tmp, 'wb') as out:
                shutil.copyfileobj(r, out, CHUNK)
        except Exception as e:
            print(f"FATAL: download of {url} failed: {e}", file=sys.stderr)
            return 2
        actual = sha256_of(tmp)
        if actual != expected.lower():
            print(f"REFUSED: sha256 mismatch for {url}\n  expected: {expected}\n  actual:   {actual}",
                  file=sys.stderr)
            return 1
        os.replace(tmp, final)
        print(f"OK: {final} sha256={actual}")
        return 0
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default=CORPUS_URL)
    ap.add_argument('--sha256', default=CORPUS_SHA256, help='expected full sha256 (default: the pinned corpus)')
    ap.add_argument('--dest', default=os.path.join(HERE, 'data'))
    a = ap.parse_args()
    sys.exit(fetch(a.url, a.dest, a.sha256))


if __name__ == '__main__':
    main()
