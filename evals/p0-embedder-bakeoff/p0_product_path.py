#!/usr/bin/env python3
"""
P0 product-path recall driver — measures recall THROUGH the Mandrel server, so it can be
re-run after any embedder or search change.

Per question: create ONE project, store each haystack session through `context_store`
in DATE order (oldest first), query through `smart_search`, derive the ranked session list
from the returned results, and score with the SAME metrics as p0_coverage.py (any-gold coverage
and strict@k, overall and per question type).

Each stored context starts with a marker line  `[LME-SESSION <session_id>]`  so a returned row
maps back to its session without any server-side support.

Talks to the HTTP bridge:  POST {base}/mcp/tools/{tool}  (bearer token, if any, is read from
the env var named by --token-env and never printed).

  python3 p0_product_path.py --base-url http://localhost:8080 --qids-file qids_n36.txt --out out/product
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import p0_coverage as cov  # noqa: E402  (the shared scorer)

MARKER_FMT = "[LME-SESSION {sid}]"
MARKER_RE = re.compile(r"\[LME-SESSION ([^\]\s]+)\]")
DEFAULT_BASE_URL = "http://localhost:8080"
DEFAULT_TOKEN_ENV = "MANDREL_BRIDGE_TOKEN"
DEFAULT_CONTEXT_TYPE = "note"          # generic capture type (see CLAUDE.md valid types)
DEFAULT_PROJECT_PREFIX = "lme-p0"


class Bridge:
    def __init__(self, base_url, token=None, timeout=600):
        self.base, self.token, self.timeout = base_url.rstrip('/'), token, timeout

    def call(self, tool, args):
        headers = {'content-type': 'application/json'}
        if self.token:
            headers['authorization'] = f'Bearer {self.token}'
        req = urllib.request.Request(f"{self.base}/mcp/tools/{tool}", data=json.dumps(args).encode(),
                                     headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{tool} -> HTTP {e.code}: {e.read().decode()[:300]}")
        if not body.get('success', False):
            raise RuntimeError(f"{tool} failed: {json.dumps(body)[:300]}")
        result = body.get('result') or {}
        if result.get('isError'):
            raise RuntimeError(f"{tool} returned an error: {json.dumps(result)[:300]}")
        return result


def date_ordered(prob):
    """[(session_id, session, date)] sorted oldest-first by haystack date (stable on input order).
    LongMemEval dates are 'YYYY/MM/DD (Dow) HH:MM', which sort correctly as strings."""
    sessions, sids = prob['haystack_sessions'], prob['haystack_session_ids']
    dates = prob.get('haystack_dates') or [None] * len(sessions)
    rows = [(sids[i], sessions[i], dates[i] if i < len(dates) else None) for i in range(len(sessions))]
    return sorted(rows, key=lambda r: r[2] or '')


def session_ids_from_results(results):
    """Ranked, de-duplicated session ids from smart_search structuredContent.results."""
    ranked, seen = [], set()
    for row in results:
        m = MARKER_RE.search(f"{row.get('summary') or ''}\n{row.get('title') or ''}")
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            ranked.append(m.group(1))
    return ranked


def run_question(bridge, prob, run_id, ks, context_type=DEFAULT_CONTEXT_TYPE,
                 project_prefix=DEFAULT_PROJECT_PREFIX):
    project = f"{project_prefix}-{run_id}-{prob['question_id']}"
    bridge.call('project_create', {'name': project,
                                   'description': f"LongMemEval product-path recall, {prob['question_id']}"})
    for sid, sess, date in date_ordered(prob):
        content = MARKER_FMT.format(sid=sid) + "\n" + cov.session_content(sess, date)
        bridge.call('context_store', {'content': content, 'type': context_type,
                                      'tags': ['lme-p0', f"session:{sid}"], 'projectId': project})
    res = bridge.call('smart_search', {'query': prob['question'], 'projectId': project,
                                       'includeTypes': ['context'], 'limit': max(ks)})
    rows = (res.get('structuredContent') or {}).get('results') or []
    ranked = session_ids_from_results(rows)
    gold = prob.get('answer_session_ids', [])
    return {'question_id': prob['question_id'], 'question_type': prob.get('question_type'),
            'project': project, 'ranked_sessions': ranked[:max(ks)], 'gold_sessions': gold,
            'coverage_at_k': {str(k): v for k, v in cov.coverage_at_ks(ranked, gold, ks).items()},
            'strict_at_k': {str(k): v for k, v in cov.strict_at_ks(ranked, gold, ks).items()}}


def run(bridge, problems, ks, out_dir, run_id, **kw):
    os.makedirs(out_dir, exist_ok=True)
    ckpt = os.path.join(out_dir, 'product-path.jsonl')
    done = cov._load_checkpoint(ckpt)
    t0 = time.time()
    with open(ckpt, 'a') as cf:
        for n, prob in enumerate([p for p in problems if p['question_id'] not in done], 1):
            rec = run_question(bridge, prob, run_id, ks, **kw)
            cf.write(json.dumps(rec) + "\n")
            cf.flush()
            done[rec['question_id']] = rec
            print(f"  [product] {n} q done ({time.time()-t0:.0f}s)", flush=True)
    recs = [done[p['question_id']] for p in problems if p['question_id'] in done]
    score = cov.score_records(recs, ks)
    with open(os.path.join(out_dir, 'product-path.json'), 'w') as f:
        json.dump({'run_id': run_id, 'ks': ks, 'score': score, 'per_question': recs}, f, indent=2)
    return score


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', default=os.path.join(HERE, 'p0.config.json'))
    ap.add_argument('--base-url', default=DEFAULT_BASE_URL)
    ap.add_argument('--token-env', default=DEFAULT_TOKEN_ENV, help='env var holding the bridge bearer token (optional)')
    ap.add_argument('--run-id', default=time.strftime('%Y%m%d%H%M%S'), help='makes project names unique per run')
    ap.add_argument('--qids-file')
    ap.add_argument('--sample-per-type', type=int, default=0)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--out', default=os.path.join(HERE, 'out', 'product'))
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    ks = cfg['recall_ks']
    problems = cov.answerable(cov.load_dataset(cfg['dataset_path']))
    if a.qids_file:
        want = {l.strip() for l in open(a.qids_file) if l.strip()}
        problems = [p for p in problems if p['question_id'] in want]
    elif a.sample_per_type:
        problems = cov.stratified_sample(problems, a.sample_per_type)
    if a.limit:
        problems = problems[:a.limit]
    bridge = Bridge(a.base_url, os.environ.get(a.token_env))
    print(f"product-path recall — {len(problems)} questions via {a.base_url}, k={ks}", flush=True)
    score = run(bridge, problems, ks, a.out, a.run_id)
    cov.print_score_table("PRODUCT PATH (context_store -> smart_search)", score, ks)


if __name__ == '__main__':
    main()
