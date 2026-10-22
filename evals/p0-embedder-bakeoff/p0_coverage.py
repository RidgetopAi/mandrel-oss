#!/usr/bin/env python3
"""
P0 embedder bake-off — flat-dense COVERAGE-only runner (Arm A design).

Coverage@k = of the answerable questions, fraction where >=1 GOLD session is in
the top-k retrieved sessions. strict@k = fraction where ALL gold sessions are in the top k
(the number the release decision uses); both are reported overall and per question_type. Per question: embed each haystack chunk (doc side)
+ the query (query side) with the model's CORRECT prefix, plain top-k cosine over
chunks, derive the ranked session list by first-occurrence, coverage@k.

NO answerer, NO judge, NO OpenAI, NO Mandrel. Config-driven (p0.config.json).
The ONLY variable across models is the encoder + its documented query/doc prefix.

Usage:
  python3 p0_coverage.py --config p0.config.json                 # all models
  python3 p0_coverage.py --config p0.config.json --models minilm nomic
  python3 p0_coverage.py --self-test                             # plumbing check on MiniLM only (needs embed_server, no Ollama)
  python3 p0_coverage.py --self-test --models nomic              # also check an Ollama model
"""
import argparse, json, os, sys, time, re, math, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
C0_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def http_post(url, payload, timeout=600):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ---- exact per-session formatting + chunking (recovered from run_eval_m2 via moat_pilot.py) ----
def session_content(session, date):
    lines = [f"[Session date: {date}]"] if date else []
    for turn in session:
        lines.append(f"{turn.get('role', '?')}: {turn.get('content', '')}")
    return C0_RE.sub('', "\n".join(lines))


def chunk_text(content, size):
    if not content:
        return [""]
    return [content[i:i + size] for i in range(0, len(content), size)]


def build_chunks(prob, chunk_size):
    """Return (chunk_texts[], chunk_session_ids[]) for one problem's haystack."""
    sessions = prob['haystack_sessions']
    sids = prob['haystack_session_ids']
    dates = prob.get('haystack_dates', [None] * len(sessions))
    texts, owners = [], []
    for i, sess in enumerate(sessions):
        date = dates[i] if i < len(dates) else None
        for ch in chunk_text(session_content(sess, date), chunk_size):
            texts.append(ch)
            owners.append(sids[i])
    return texts, owners


# ---- encoders ----
class MiniLMEncoder:
    def __init__(self, endpoint, batch=64):
        self.endpoint, self.batch = endpoint, batch

    def health(self):
        with urllib.request.urlopen(self.endpoint + '/health', timeout=30) as r:
            return json.loads(r.read().decode())

    def embed(self, texts):
        out = []
        for i in range(0, len(texts), self.batch):
            r = http_post(self.endpoint + '/embed', {'texts': texts[i:i + self.batch]})
            out.extend(r['embeddings'])
        return out


class OllamaEncoder:
    def __init__(self, endpoint, model, batch=64):
        self.url, self.model, self.batch = endpoint.rstrip('/') + '/api/embed', model, batch

    def embed(self, texts):
        out = []
        for i in range(0, len(texts), self.batch):
            r = http_post(self.url, {'model': self.model, 'input': texts[i:i + self.batch]})
            out.extend(r['embeddings'])
        return out


def make_encoder(m, cfg):
    if m['backend'] == 'minilm_server':
        return MiniLMEncoder(cfg['minilm_endpoint'], cfg.get('batch_size', 64))
    return OllamaEncoder(cfg['ollama_endpoint'], m['model'], cfg.get('batch_size', 64))


# ---- retrieval + coverage ----
def cosine_topk_sessions(qvec, dvecs, owners):
    """Ranked session-id list by first-occurrence of chunks in cosine-desc order.
    Vectors are L2-normalized by the models, but we normalize defensively."""
    def norm(v):
        s = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / s for x in v]
    q = norm(qvec)
    scored = []
    for idx, dv in enumerate(dvecs):
        dvn = norm(dv)
        scored.append((sum(a * b for a, b in zip(q, dvn)), idx))
    scored.sort(key=lambda t: -t[0])
    ranked, seen = [], set()
    for _, idx in scored:
        sid = owners[idx]
        if sid not in seen:
            seen.add(sid)
            ranked.append(sid)
    return ranked


def coverage_at_ks(ranked, gold, ks):
    g = set(gold)
    return {k: (1.0 if g & set(ranked[:k]) else 0.0) for k in ks}


def strict_at_ks(ranked, gold, ks):
    """strict@k: 1.0 only when EVERY gold session is in the top k (any-gold is coverage_at_ks).
    A question with no gold sessions scores 0 (nothing to cover is not a success)."""
    g = set(gold)
    return {k: (1.0 if g and g <= set(ranked[:k]) else 0.0) for k in ks}


def score_records(recs, ks):
    """Aggregate per-question records ({question_type, ranked_sessions, gold_sessions}) into
    any-gold coverage and strict@k, overall and per question_type. Pure function: the ONE scorer
    shared by the flat-dense runner and the product-path driver."""
    def agg(rs):
        n = len(rs)
        cov, strict = {}, {}
        for k in ks:
            c = sum(coverage_at_ks(r['ranked_sessions'], r['gold_sessions'], [k])[k] for r in rs)
            s = sum(strict_at_ks(r['ranked_sessions'], r['gold_sessions'], [k])[k] for r in rs)
            cov[str(k)] = round(c / n, 4) if n else 0.0
            strict[str(k)] = round(s / n, 4) if n else 0.0
        return {'n': n, 'coverage_at_k': cov, 'strict_at_k': strict}
    out = agg(recs)
    by_type = {}
    for r in recs:
        by_type.setdefault(r.get('question_type'), []).append(r)
    out['by_type'] = {t: agg(rs) for t, rs in sorted(by_type.items(), key=lambda kv: str(kv[0]))}
    return out


def print_score_table(title, score, ks):
    print(f"\n{title}  (any-gold coverage / strict, n={score['n']})")
    print("{:<28}{:>5}".format("question_type", "n") + "".join(f"{'k='+str(k):>16}" for k in ks))
    rows = [('ALL', score)] + [(str(t), v) for t, v in score['by_type'].items()]
    for name, v in rows:
        print("{:<28}{:>5}".format(name[:27], v['n']) + "".join(
            f"{v['coverage_at_k'][str(k)]*100:>8.1f}/{v['strict_at_k'][str(k)]*100:<6.1f}" for k in ks))


def peak_rss_mb():
    try:
        import resource
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)
    except Exception:
        return None


def _load_checkpoint(path):
    """Return {qid: record} already computed (resume support)."""
    done = {}
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                done[r['question_id']] = r
            except Exception:
                pass
    return done


def run_model(m, cfg, problems, ks, chunk_size, out_dir):
    """Per-question CHECKPOINTED run. Appends one JSONL record per question to
    coverage-<key>.jsonl (crash/interrupt safe, resumable), then writes the
    aggregated coverage-<key>.json summary. Skips questions already in the JSONL."""
    enc = make_encoder(m, cfg)
    qp, dp = m.get('query_prefix', ''), m.get('doc_prefix', '')
    os.makedirs(out_dir, exist_ok=True)
    ckpt = os.path.join(out_dir, f"coverage-{m['key']}.jsonl")
    done = _load_checkpoint(ckpt)
    t0 = time.time()
    n_chunks_total = 0
    todo = [p for p in problems if p['question_id'] not in done]
    if done:
        print(f"  [{m['key']}] resume: {len(done)} done, {len(todo)} to go", flush=True)
    with open(ckpt, 'a') as cf:
        for n, prob in enumerate(todo, 1):
            texts, owners = build_chunks(prob, chunk_size)
            n_chunks_total += len(texts)
            dvecs = enc.embed([dp + t for t in texts])
            qvec = enc.embed([qp + prob['question']])[0]
            ranked = cosine_topk_sessions(qvec, dvecs, owners)
            cov = coverage_at_ks(ranked, prob.get('answer_session_ids', []), ks)
            rec = {'question_id': prob['question_id'],
                   'question_type': prob.get('question_type'),
                   'ranked_sessions': ranked[:max(ks)],
                   'gold_sessions': prob.get('answer_session_ids', []),
                   'strict_at_k': {str(k): v for k, v in strict_at_ks(
                       ranked, prob.get('answer_session_ids', []), ks).items()},
                   'coverage_at_k': {str(k): cov[k] for k in ks}}
            cf.write(json.dumps(rec) + "\n")
            cf.flush()
            done[prob['question_id']] = rec
            if n % 5 == 0:
                print(f"  [{m['key']}] {n}/{len(todo)} q ({n_chunks_total} chunks, {time.time()-t0:.0f}s)", flush=True)
    dt = time.time() - t0
    # aggregate over ALL done (resumed + new)
    recs = list(done.values())
    denom = len(recs)
    agg = {k: sum(r['coverage_at_k'][str(k)] for r in recs) for k in ks}
    coverage = {str(k): round(agg[k] / denom, 4) if denom else 0.0 for k in ks}
    result = {
        'model_key': m['key'], 'label': m['label'], 'model': m['model'],
        'dim': m['dim'], 'query_prefix': qp, 'doc_prefix': dp,
        'n_questions': denom, 'chunk_size': chunk_size,
        'coverage_at_k': coverage,
        'score': score_records(recs, ks),
        'runtime_sec_this_run': round(dt, 1), 'chunks_this_run': n_chunks_total,
        'peak_rss_mb_runner': peak_rss_mb(),
    }
    with open(os.path.join(out_dir, f"coverage-{m['key']}.json"), 'w') as f:
        json.dump({'summary': result, 'per_question': recs}, f, indent=2)
    return result


def load_dataset(path):
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    if not os.path.exists(path):
        sys.exit(f"FATAL: dataset not found at {path}. P0 refuses to run without the "
                 f"real longmemeval_s_cleaned.json corpus (never fabricate).")
    with open(path) as f:
        return json.load(f)


def answerable(problems):
    # LongMemEval abstention questions have question_id ending in '_abs'
    return [p for p in problems if not str(p.get('question_id', '')).endswith('_abs')]


def stratified_sample(problems, per_type):
    """Deterministic: for each question_type, take `per_type` questions evenly
    spaced across that type's answerable set (not the first N). Stable order by qid."""
    from collections import defaultdict
    buckets = defaultdict(list)
    for p in problems:
        buckets[p.get('question_type')].append(p)
    picked = []
    for t in sorted(buckets):
        b = sorted(buckets[t], key=lambda p: p['question_id'])
        n = min(per_type, len(b))
        if n == 0:
            continue
        step = len(b) / n
        picked += [b[int(i * step)] for i in range(n)]
    return sorted(picked, key=lambda p: (p.get('question_type'), p['question_id']))


# ---- self-test: micro synthetic fixture, proves plumbing + coverage math only ----
def self_test(cfg, ks, chunk_size):
    print("SELF-TEST (micro fixture — NOT the eval, no results claimed)")
    fixture = [{
        'question_id': 'q1', 'question_type': 'single-session-user',
        'question': 'What breed is my dog?',
        'answer_session_ids': ['s_gold'],
        'haystack_session_ids': ['s_noise', 's_gold', 's_noise2'],
        'haystack_dates': ['2026-01-01', '2026-01-02', '2026-01-03'],
        'haystack_sessions': [
            [{'role': 'user', 'content': 'I love hiking in the mountains every weekend.'}],
            [{'role': 'user', 'content': 'My dog Rex is a golden retriever, he is three years old.'}],
            [{'role': 'user', 'content': 'The stock market was volatile today.'}],
        ],
    }]
    ok = True
    for m in cfg['models']:
        try:
            r = run_model(m, cfg, fixture, ks, chunk_size, os.path.join(HERE, 'out', 'selftest'))
            hit = r['coverage_at_k'][str(max(ks))] == 1.0
            print(f"  {m['key']:16} dim={r['dim']:5} q='{m.get('query_prefix','')[:24]!r}' "
                  f"cov@{max(ks)}={r['coverage_at_k'][str(max(ks))]}  {'PASS' if hit else 'MISS-gold'}")
            ok = ok and hit
        except Exception as e:
            ok = False
            print(f"  {m['key']:16} ERROR: {e}")
    print("SELF-TEST:", "ALL PASS (plumbing + prefixes + cosine + coverage work)" if ok else "FAILURES ABOVE")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', default=os.path.join(HERE, 'p0.config.json'))
    ap.add_argument('--models', nargs='*', help='subset of model keys; default all')
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='cap #questions (debug)')
    ap.add_argument('--sample-per-type', type=int, default=0,
                    help='stratified: take N answerable questions per question_type')
    ap.add_argument('--qids-file', help='file of question_ids (one per line) to run')
    ap.add_argument('--out', default=os.path.join(HERE, 'out'))
    args = ap.parse_args()
    cfg = json.load(open(args.config))
    ks = cfg['recall_ks']
    chunk_size = cfg['chunk_size_chars']
    if args.models:
        by_key = {m['key']: m for m in cfg['models']}
        cfg['models'] = [by_key[k] for k in args.models if k in by_key]  # honor arg order

    if args.self_test:
        if not args.models:
            # Default to the one encoder that needs no Ollama (the local embed_server); the
            # Ollama models are opt-in via --models so a bare --self-test never hangs on :11434.
            cfg['models'] = [m for m in cfg['models'] if m['backend'] == 'minilm_server']
        sys.exit(self_test(cfg, ks, chunk_size))

    problems = answerable(load_dataset(cfg['dataset_path']))
    if args.qids_file:
        want = {l.strip() for l in open(args.qids_file) if l.strip()}
        problems = [p for p in problems if p['question_id'] in want]
    elif args.sample_per_type:
        problems = stratified_sample(problems, args.sample_per_type)
    if args.limit:
        problems = problems[:args.limit]
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'qids.txt'), 'w') as f:
        f.write("\n".join(p['question_id'] for p in problems) + "\n")
    print(f"P0 coverage — {len(problems)} answerable questions, k={ks}, chunk={chunk_size}, out={args.out}", flush=True)
    rows = []
    for m in cfg['models']:
        print(f"\n=== {m['label']} ({m['model']}) ===", flush=True)
        rows.append(run_model(m, cfg, problems, ks, chunk_size, args.out))

    # summary table
    print("\n\nCOVERAGE@k TABLE (answerable-only, denom={})".format(len(problems)))
    hdr = "{:<32}{:>7}".format("model", "dim") + "".join(f"{'k='+str(k):>9}" for k in ks)
    print(hdr)
    for r in rows:
        line = "{:<32}{:>7}".format(r['label'][:31], r['dim'])
        line += "".join(f"{r['coverage_at_k'][str(k)]*100:>8.1f}%" for k in ks)
        print(line)
    for r in rows:
        print_score_table(f"{r['label']} — per question type", r['score'], ks)
    print("\nCALIBRATION")
    print("{:<32}{:>6}{:>10}{:>12}{:>10}".format("model", "dim", "runtime_s", "chunks", "rss_mb"))
    for r in rows:
        print("{:<32}{:>6}{:>10}{:>12}{:>10}".format(
            r['label'][:31], r['dim'], r['runtime_sec_this_run'], r['chunks_this_run'], r['peak_rss_mb_runner']))
    with open(os.path.join(args.out, 'summary.json'), 'w') as f:
        json.dump({'ks': ks, 'chunk_size': chunk_size, 'n_answerable': len(problems),
                   'results': rows}, f, indent=2)
    print("\nwrote", os.path.join(args.out, 'summary.json'))


if __name__ == '__main__':
    main()
