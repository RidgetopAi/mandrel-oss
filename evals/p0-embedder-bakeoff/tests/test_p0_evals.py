"""Tests for the P0 embedder bake-off tooling (stdlib unittest; run: python3 -m unittest discover -s evals/p0-embedder-bakeoff/tests)."""
import hashlib, http.server, json, os, pathlib, re, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import p0_coverage as cov  # noqa: E402
import p0_product_path as pp  # noqa: E402

KS = [1, 2, 3]
FULL_SHA = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"


class StrictCoverageScoring(unittest.TestCase):
    # q1 type A gold {a,b}: top1=[a] top2=[a,x] top3=[a,x,b]  -> any 1,1,1  strict 0,0,1
    # q2 type A gold {c}  : ranked [x,c,y]                    -> any 0,1,1  strict 0,1,1
    # q3 type B gold {d,e}: ranked [x,y,d]                    -> any 0,0,1  strict 0,0,0
    RECS = [
        {'question_type': 'A', 'ranked_sessions': ['a', 'x', 'b'], 'gold_sessions': ['a', 'b']},
        {'question_type': 'A', 'ranked_sessions': ['x', 'c', 'y'], 'gold_sessions': ['c']},
        {'question_type': 'B', 'ranked_sessions': ['x', 'y', 'd'], 'gold_sessions': ['d', 'e']},
    ]

    def test_overall_and_per_type(self):
        s = cov.score_records(self.RECS, KS)
        self.assertEqual(s['coverage_at_k'], {'1': 0.3333, '2': 0.6667, '3': 1.0})
        self.assertEqual(s['strict_at_k'], {'1': 0.0, '2': 0.3333, '3': 0.6667})
        a, b = s['by_type']['A'], s['by_type']['B']
        self.assertEqual((a['n'], b['n']), (2, 1))
        self.assertEqual(a['coverage_at_k'], {'1': 0.5, '2': 1.0, '3': 1.0})
        self.assertEqual(a['strict_at_k'], {'1': 0.0, '2': 0.5, '3': 1.0})
        self.assertEqual(b['coverage_at_k'], {'1': 0.0, '2': 0.0, '3': 1.0})
        self.assertEqual(b['strict_at_k'], {'1': 0.0, '2': 0.0, '3': 0.0})


def _fixture(tmp, payload=b'{"fixture": true}'):
    p = pathlib.Path(tmp) / 'src.json'
    p.write_bytes(payload)
    return p, hashlib.sha256(payload).hexdigest()


def _fetch(url, sha, dest):
    return subprocess.run([sys.executable, '-I', str(HERE / 'fetch_corpus.py'), '--url', url,
                           '--sha256', sha, '--dest', str(dest)], capture_output=True, text=True)


class CorpusFetch(unittest.TestCase):
    def test_mismatch_refused_naming_both_hashes(self):
        with tempfile.TemporaryDirectory() as t:
            src, actual = _fixture(t)
            dest = pathlib.Path(t) / 'out'
            r = _fetch(src.as_uri(), FULL_SHA, dest)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(FULL_SHA, r.stderr)
            self.assertIn(actual, r.stderr)
            self.assertFalse((dest / 'longmemeval_s_cleaned.json').exists())

    def test_match_succeeds(self):
        with tempfile.TemporaryDirectory() as t:
            src, actual = _fixture(t)
            dest = pathlib.Path(t) / 'out'
            r = _fetch(src.as_uri(), actual, dest)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((dest / 'longmemeval_s_cleaned.json').read_bytes(), src.read_bytes())

    def test_full_hash_in_runbook_and_fetch_step(self):
        self.assertIn(FULL_SHA, (HERE / 'RUNBOOK.md').read_text())
        self.assertIn(FULL_SHA, (HERE / 'fetch_corpus.py').read_text())


class FakeServer:
    """Records every bridge call; answers smart_search by ranking the project's stored contexts in
    reverse storage order (a deterministic stand-in for relevance)."""
    def __init__(self):
        self.calls = []
        self.projects = {}
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                args = json.loads(self.rfile.read(int(self.headers['content-length'])))
                tool = self.path.rsplit('/', 1)[1]
                outer.calls.append((tool, args))
                result = {'content': [{'type': 'text', 'text': 'ok'}]}
                if tool == 'context_store':
                    outer.projects.setdefault(args['projectId'], []).append(args['content'])
                elif tool == 'smart_search':
                    rows = [{'id': str(i), 'title': 'n', 'summary': c[:60], 'type': 'context'}
                            for i, c in enumerate(reversed(outer.projects.get(args['projectId'], [])))]
                    result['structuredContent'] = {'results': rows[:args['limit']]}
                body = json.dumps({'success': True, 'result': result}).encode()
                self.send_response(200); self.send_header('content-length', str(len(body))); self.end_headers()
                self.wfile.write(body)
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


def _prob(qid, sids, dates, gold):
    return {'question_id': qid, 'question_type': 'T', 'question': f'q {qid}?', 'answer_session_ids': gold,
            'haystack_session_ids': sids, 'haystack_dates': dates,
            'haystack_sessions': [[{'role': 'user', 'content': f'content {s}'}] for s in sids]}


class ProductPathDriver(unittest.TestCase):
    def test_one_project_per_question_date_order_and_strict(self):
        # input order is NOT date order; storage must be s_old, s_mid, s_new. Fake ranks newest-stored
        # first, so ranked = [s_new, s_mid, s_old].
        p1 = _prob('q1', ['s_new', 's_old', 's_mid'],
                   ['2023/05/30 (Tue) 10:00', '2023/05/01 (Mon) 10:00', '2023/05/15 (Mon) 10:00'],
                   ['s_new', 's_mid'])      # both within top 2 -> strict@2 = 1
        p2 = _prob('q2', ['t_b', 't_a'], ['2023/06/02 (Fri) 09:00', '2023/06/01 (Thu) 09:00'],
                   ['t_a', 't_b'])          # ranked [t_b, t_a]; gold both -> strict@1 = 0, @2 = 1
        srv = FakeServer()
        try:
            with tempfile.TemporaryDirectory() as out:
                score = pp.run(pp.Bridge(srv.url), [p1, p2], [1, 2, 3], out, 'RUN')
        finally:
            srv.close()
        creates = [a['name'] for t, a in srv.calls if t == 'project_create']
        self.assertEqual(len(creates), 2)
        self.assertEqual(len(set(creates)), 2)
        stores = {}
        for t, a in srv.calls:
            if t == 'context_store':
                stores.setdefault(a['projectId'], []).append(pp.MARKER_RE.match(a['content']).group(1))
        self.assertEqual(sorted(stores), sorted(creates))
        self.assertEqual(stores[creates[0]], ['s_old', 's_mid', 's_new'])
        self.assertEqual(stores[creates[1]], ['t_a', 't_b'])
        self.assertEqual(score['n'], 2)
        self.assertEqual(score['strict_at_k'], {'1': 0.0, '2': 1.0, '3': 1.0})
        self.assertEqual(score['coverage_at_k'], {'1': 1.0, '2': 1.0, '3': 1.0})


class RunbookHygiene(unittest.TestCase):
    def test_runbook_clean(self):
        text = (HERE / 'RUNBOOK.md').read_text()
        self.assertNotIn('nohup', text)
        self.assertNotRegex(text, r'/home/(?!builder)\w+/')
        self.assertNotRegex(text, r'(^|\s)\.\./\.\./(?!mcp-server)')

    def test_embed_server_model_path_under_vendor_models(self):
        env = {k: v for k, v in os.environ.items() if k != 'EMBED_MODEL_DIR'}
        r = subprocess.run(['node', str(HERE / 'embed_server.mjs'), '--print-model-dir'],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = pathlib.Path(r.stdout.strip()).resolve()
        want = (HERE.parent.parent / 'mcp-server' / 'vendor' / 'models').resolve()
        self.assertEqual(got, want)
        self.assertTrue((got / 'Xenova' / 'all-MiniLM-L6-v2').is_dir())


if __name__ == '__main__':
    unittest.main()
