#!/usr/bin/env python3
"""
ARM C -- MANDREL MOAT pilot (design + pilot ONLY -- not the full 500q run).

WHAT THIS TESTS
  Does answering via Mandrel's GRAPH (blind write-time auto-threading -> typed
  related_to edges -> recall_thread traversal) beat Arm B (retrieval +
  session-expansion, the frozen 74.3%)?  Arms A/B are frozen; this adds C.

THE INTEGRITY SPINE -- ingestion is question-blind BY CONSTRUCTION
  ingest_threaded(proj, sessions, dates, ns_tag) receives ONLY the haystack
  sessions + their dates. The question / answer / gold session ids are NEVER in
  scope of the ingestion path (verify by reading the function: its inputs make
  the forbidden cheat impossible, not just avoided). Structure comes from two
  blind sources only:
    (a) MECHANICAL, from the data's own shape: sessions replayed in
        chronological order; chunks 1..n of a session carry ONE explicit
        related_to edge to the session's head chunk (session boundary = thread).
        Identical rule for every session; no judgment, no hand-tagging.
    (b) Mandrel's OWN write-time inference (reliable-auto-threading, shipped
        2026-07-04): each session HEAD is stored with NO links, so the server's
        no-orphan inference mints (or honestly declines) ONE weak related_to
        edge to the nearest prior non-orphan context -- cross-session semantic
        edges formed at write time, blind to any future query.

FAIR COMPARISON (single variable = the memory mechanism)
  Same dataset slice, same encoder (Mandrel's own store path), same chunking
  (CHUNK_SIZE from the harness), same base retrieval (context_search limit=k,
  ranked sessions parsed identically -> recall@k is arm-B-identical by
  construction), same answerer (gpt-4.1-mini temp 0), same judge (gpt-4o via
  the OFFICIAL evaluate_qa prompts), same prompt variant (improved), same
  context budget (SE_CAP=36 chunks / SE_TOKEN_BUDGET=28000 tokens).
  The ONLY change: WHICH sessions get assembled into context --
    Arm B: full sessions of the top-8 vector hits.
    Arm C: phase 1 = the SAME top-hit sessions (rank order), then
           phase 2 = sessions DISCOVERED BY WALKING THE GRAPH
           (recall_thread depth-2 from each hit chunk; any reached node's
           session not already selected), appended with the remaining budget.
  So C >= B in content until the budget binds; every delta is attributable to
  the graph-appended sessions (or their displacement under budget pressure).

SANDBOX: talks ONLY to the disposable Mandrel on :8195 (throwaway
  ci_lmemoat_pilot1 Postgres). Never prod :8080, never :8190, never a tenant.

Usage:
  source venv/bin/activate
  MANDREL_BASE=http://localhost:8195 python3 moat_pilot.py \
      --qids-file smoke8.qids --run-id armC-moat-pilot
"""
import json, os, sys, time, argparse, re

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_eval_m2 as H  # the frozen harness: chunking, mandrel client, answerer, judge

# ---- hard sandbox guard ----
BASE = os.getenv('MANDREL_BASE', 'http://localhost:8195')
if ':8080' in BASE or ':8190' in BASE:
    raise SystemExit('REFUSING to run against prod :8080 / shared :8190')
H.MANDREL_BASE = BASE

GE_TOPHITS = int(os.getenv('GE_TOPHITS', str(H.SE_TOPHITS)))     # 8, same as arm B
GE_CAP = int(os.getenv('GE_CAP', str(H.SE_CAP)))                 # 36 chunks, same
GE_CHAR_BUDGET = int(os.getenv('GE_CHAR_BUDGET', str(H.SE_CHAR_BUDGET)))  # 112000, same
GE_DEPTH = int(os.getenv('GE_DEPTH', '2'))                       # recall_thread walk depth

ID_RE = re.compile(r'ID:\s*([0-9a-f]{8}-[0-9a-f-]{27,})')

def sc(resp):
    return (resp.get('result') or {}).get('structuredContent') or {}

# ---------------------------------------------------------------------------
# BLIND INGESTION -- the integrity spine. Inputs: sessions + dates ONLY.
# ---------------------------------------------------------------------------
def ingest_threaded(proj, sessions, dates, ns_tag):
    """Replay sessions chronologically through Mandrel's REAL write path.
    Returns bookkeeping: {'id2sess': {ctx_id: orig_idx},
                          'sess_chunks': {orig_idx: [(ctx_id, text), ...]},
                          'inference': [per-head inference result dicts]}
    NOTE the signature: the question / answer / gold ids are not available here."""
    cr = H.mandrel('project_create', {'name': proj, 'description': 'LME moat pilot'})
    if H.mandrel_text(cr) and 'already exists' in H.mandrel_text(cr):
        H.mandrel('project_delete', {'project': proj, 'confirm': True})
        H.mandrel('project_create', {'name': proj, 'description': 'LME moat pilot'})
    H.mandrel('project_switch', {'project': proj})

    # chronological replay order (real-user order); tags keep the ORIGINAL index
    order = sorted(range(len(sessions)), key=lambda i: (dates[i] or '9999', i))
    id2sess, sess_chunks, inf_log = {}, {}, []
    for i in order:
        date = dates[i] if i < len(dates) else None
        lines = ([f"[Session date: {date}]"] if date else [])
        for turn in sessions[i]:
            lines.append(f"{turn.get('role','?')}: {turn.get('content','')}")
        content = "\n".join(lines)
        # Mandrel's validation rejects control characters; strip C0 controls
        # (keep \n and \t). NOTE: arm B's ingest never checked store success, so
        # it SILENTLY DROPPED such chunks; we sanitize instead (and say so).
        content = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', content)
        chunks = H.chunk_text(content, H.CHUNK_SIZE)
        head_id = None
        for j, chunk in enumerate(chunks):
            args = {'content': chunk, 'type': 'discussion',
                    'tags': ['lme', ns_tag, f'session{i}']}
            if j > 0 and head_id:
                # MECHANICAL intra-session thread: chunk -> session head.
                args['links'] = [{'edgeType': 'related_to', 'to': head_id,
                                  'toType': 'context'}]
            r = H.mandrel('context_store', args)
            txt = H.mandrel_text(r)
            m = ID_RE.search(txt or '')
            if not m:
                raise RuntimeError(f'no ctx id in store response: {txt[:200]}')
            cid = m.group(1)
            id2sess[cid] = i
            sess_chunks.setdefault(i, []).append((cid, chunk))
            if j == 0:
                head_id = cid
                # capture the server's own inference verdict (minted / declined)
                inf = (sc(r).get('context') or {}).get('inference')
                inf_log.append({'session': i, 'head': cid, 'inference': inf})
    return {'id2sess': id2sess, 'sess_chunks': sess_chunks, 'inference': inf_log}

# ---------------------------------------------------------------------------
# ARM C RETRIEVAL -- graph expansion
# ---------------------------------------------------------------------------
def parse_hits(txt):
    """Ordered (ctx_id, sess_idx) pairs from context_search text output."""
    hits, cur_sess = [], None
    for line in (txt or '').splitlines():
        tm = H.TAG_RE.search(line)
        if tm:
            sm = H.SESS_RE.search(tm.group(1))
            cur_sess = int(sm.group(1)) if sm else None
            continue
        im = ID_RE.search(line)
        if im and cur_sess is not None:
            hits.append((im.group(1), cur_sess))
            cur_sess = None
    return hits

def session_edges(book):
    """Reconstruct the cross-session inference edges from the ingest trail:
    (from_sess, to_sess, similarity) for every MINTED head inference edge.
    Ingest-time provenance (blind); used only for phase-2 ADMISSION scoring."""
    edges = []
    for e in book['inference']:
        inf = e.get('inference') or {}
        if inf.get('minted') and inf.get('candidateId'):
            ts = book['id2sess'].get(inf['candidateId'])
            if ts is not None:
                edges.append((e['session'], ts, float(inf.get('similarity') or 0)))
    return edges

# Phase-2 ADMISSION RULE (the anti-dilution knob, swept at $0):
#   score(s) = max similarity of any inference edge connecting session s to a
#   phase-1 session. Admit a walk-discovered session iff score >= P2_SIMFLOOR
#   (0 = admit everything the walk reached, the original pilot behavior);
#   keep at most P2_MAX admitted sessions (0 = unlimited), best score first.
P2_SIMFLOOR = float(os.getenv('P2_SIMFLOOR', '0'))
P2_MAX = int(os.getenv('P2_MAX', '0'))

def admit_phase2(cands, phase1, edges, simfloor=None, p2max=None):
    """Score + filter walk-discovered candidate sessions. Returns
    (ordered admitted list, {session: score})."""
    simfloor = P2_SIMFLOOR if simfloor is None else simfloor
    p2max = P2_MAX if p2max is None else p2max
    p1 = set(phase1)
    score = {}
    for a, b, s in edges:
        for x, y in ((a, b), (b, a)):
            if x in p1 and y not in p1:
                score[y] = max(score.get(y, 0.0), s)
    kept = [(score.get(s, 0.0), i, s) for i, s in enumerate(cands)]
    if simfloor > 0:
        kept = [t for t in kept if t[0] >= simfloor]
        kept.sort(key=lambda t: (-t[0], t[1]))  # best-vouched first
    if p2max > 0:
        kept = kept[:p2max]
    return [s for _, _, s in kept], {s: round(v, 3) for v, _, s in kept}

def retrieve_graph(query, k, book):
    """Returns (retrieved_text, base_sess_idxs, diag).
    base_sess_idxs = ordered sessions of the base vector search (recall basis,
    IDENTICAL to arm B). Assembly = phase1 hit sessions + phase2 graph sessions."""
    base = H.mandrel('context_search', {'query': query, 'limit': k})
    hits = parse_hits(H.mandrel_text(base))
    base_sess = list(dict.fromkeys(s for _, s in hits))

    phase1 = list(dict.fromkeys(s for _, s in hits[:GE_TOPHITS]))
    # phase 2: walk the graph from each hit chunk; any reached node's session
    # not already selected is a graph-discovered candidate (in walk order).
    p2_cands, threads_used, walks = [], 0, {}
    for cid, _s in hits[:GE_TOPHITS]:
        rt = H.mandrel('recall_thread', {'anchor': cid, 'altitude': 'headline',
                                         'depth': GE_DEPTH})
        nodes = sc(rt).get('nodes') or []
        if nodes:
            threads_used += 1
        reached = []
        for n in nodes:
            si = book['id2sess'].get(n.get('id'))
            if si is not None:
                reached.append(si)
                if si not in phase1 and si not in p2_cands:
                    p2_cands.append(si)
        walks[str(cid)] = reached
    edges = session_edges(book)
    phase2, p2_scores = admit_phase2(p2_cands, phase1, edges)
    book['_dump'] = {'hits': hits, 'base_sess': base_sess, 'phase1': phase1,
                     'p2_candidates': p2_cands, 'walks': walks,
                     'edges': edges, 'p2_admitted': phase2,
                     'p2_scores': {str(k_): v for k_, v in p2_scores.items()}}

    parts, total_chunks, chars = [], 0, 0
    used_sessions, gold_via_graph = [], []
    for si in phase1 + phase2:
        chunks = book['sess_chunks'].get(si, [])
        block = "\n".join(t for _, t in chunks)
        nb = len(chunks)
        if parts and (total_chunks + nb > GE_CAP or chars + len(block) > GE_CHAR_BUDGET):
            if si in phase1:
                continue  # never let phase2 have displaced a phase1 session
            break
        parts.append(block)
        total_chunks += nb
        chars += len(block)
        used_sessions.append(si)
        if total_chunks >= GE_CAP or chars >= GE_CHAR_BUDGET:
            break
    diag = {'phase1_sessions': phase1, 'phase2_sessions': phase2,
            'p2_candidates': p2_cands,
            'p2_scores': {str(k_): v for k_, v in p2_scores.items()},
            'used_sessions': used_sessions, 'threads_walked': threads_used,
            'context_chars': chars, 'context_chunks': total_chunks,
            'p2_simfloor': P2_SIMFLOOR, 'p2_max': P2_MAX}
    return "\n\n".join(parts), base_sess, diag

# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', default='LongMemEval/data/longmemeval_s_cleaned.json')
    ap.add_argument('--qids-file', default=None,
                    help='optional slice; omit for the FULL dataset')
    ap.add_argument('--run-id', default='armC-moat-pilot')
    ap.add_argument('--out', default=None)
    ap.add_argument('--retrieval-only', action='store_true',
                    help='$0 mode: ingest + graph-retrieve + coverage diagnostics; '
                         'NO answerer, NO judge.')
    ap.add_argument('--dump-book', default=None,
                    help='dir to persist per-question graph bookkeeping '
                         '(hits/walks/edges/sizes) for the $0 offline rule sweep')
    args = ap.parse_args()
    out_path = args.out or f'hypotheses-{args.run_id}.jsonl'

    ds = json.load(open(args.dataset))
    if args.qids_file:
        qids = [l.strip() for l in open(args.qids_file) if l.strip()]
        problems = [p for p in ds if p['question_id'] in set(qids)]
    else:
        problems = ds
    # RESUME: skip questions already recorded in the out file (crash-safe).
    done = set()
    if os.path.exists(out_path):
        for l in open(out_path):
            try:
                done.add(json.loads(l)['question_id'])
            except Exception:
                pass
        if done:
            print(f'resume: {len(done)} already recorded, skipping', flush=True)
        problems = [p for p in problems if p['question_id'] not in done]
    print(f'pilot slice: {len(problems)} questions  base={BASE}', flush=True)

    recs = []
    for n, prob in enumerate(problems):
        qid = prob['question_id']
        is_abs = qid.endswith('_abs')
        t0 = time.time()
        proj = f'lmec-{qid}'.lower()[:60]
        book = ingest_threaded(proj, prob['haystack_sessions'],
                               prob.get('haystack_dates', [None]*len(prob['haystack_sessions'])),
                               qid)
        n_inf = sum(1 for e in book['inference']
                    if (e.get('inference') or {}).get('minted'))
        # honest trail: the FULL distribution of head-inference outcomes, minted or not
        sims = sorted((round((e.get('inference') or {}).get('similarity') or 0, 3)
                       for e in book['inference']), reverse=True)
        inf_reasons = {}
        for e in book['inference']:
            reason = (e.get('inference') or {}).get('reason') or 'missing'
            inf_reasons[reason] = inf_reasons.get(reason, 0) + 1
        retrieved, base_sess, diag = retrieve_graph(prob['question'], 8, book)

        ranked_ids = H.ranked_session_ids(prob, base_sess)
        gold = prob.get('answer_session_ids', [])
        k_map = H.recall_at_ks(ranked_ids, gold, H.RECALL_KS)
        cov_map = H.coverage_at_ks(ranked_ids, gold, H.RECALL_KS)
        # the moat lens: gold sessions reached ONLY via the graph walk
        hs_ids = prob['haystack_session_ids']
        gold_idx = {i for i, s in enumerate(hs_ids) if s in set(gold)}
        gold_from_graph = sorted(gold_idx & set(diag['phase2_sessions']))
        gold_in_context = sorted(gold_idx & set(diag['used_sessions']))

        if args.dump_book:
            os.makedirs(args.dump_book, exist_ok=True)
            dump = dict(book['_dump'])
            dump.update({
                'question_id': qid, 'question_type': prob['question_type'],
                'abstention': is_abs, 'gold_idx': sorted(gold_idx),
                'sess_sizes': {str(si): [len(t) for _, t in ch]
                               for si, ch in book['sess_chunks'].items()},
            })
            with open(os.path.join(args.dump_book, f'{qid}.json'), 'w') as f:
                json.dump(dump, f)

        if args.retrieval_only:
            hyp, qa_correct, judge_raw = '[retrieval-only]', None, None
        else:
            hyp = H.answer('gpt-4.1-mini', prob['question'],
                           prob.get('question_date', ''), retrieved,
                           backend='openai', question_type=prob['question_type'],
                           prompt_variant='improved')
            qa_correct, judge_raw = H.judge_qa('gpt-4o', prob['question_type'],
                                               prob['question'], str(prob['answer']),
                                               hyp, is_abs)
        rec = {'run_id': args.run_id, 'question_id': qid,
               'question_type': prob['question_type'], 'abstention': is_abs,
               'ranked_sessions': ranked_ids,
               'gold_sessions': gold,
               'recall_at_k': {str(k): v for k, v in k_map.items()},
               'coverage_at_k': {str(k): v for k, v in cov_map.items()},
               'inferred_edges_minted': n_inf,
               'inference_reasons': inf_reasons,
               'inference_similarities_top10': sims[:10],
               'n_sessions': len(prob['haystack_sessions']),
               'graph': diag,
               'gold_sessions_via_graph_only': gold_from_graph,
               'gold_sessions_in_context': gold_in_context,
               'hypothesis': hyp, 'qa_correct': qa_correct,
               'judge_raw': judge_raw,
               'wall_s': round(time.time() - t0, 1)}
        recs.append(rec)
        with open(out_path, 'a') as f:
            f.write(json.dumps(rec) + '\n')
        print(f"[{n+1}/{len(problems)}] {qid} ({prob['question_type']}) "
              f"qa={'Y' if qa_correct else 'N'} inf_edges={n_inf} "
              f"p2={len(diag['phase2_sessions'])} goldGraph={gold_from_graph} "
              f"{rec['wall_s']}s", flush=True)

    n_ans = [r for r in recs if not r['abstention']]
    print('\n=== pilot summary (tiny n -- pipeline proof, NOT a claim) ===')
    print(f"QA: {sum(1 for r in recs if r['qa_correct'])}/{len(recs)} overall; "
          f"{sum(1 for r in n_ans if r['qa_correct'])}/{len(n_ans)} answerable")
    print(f"inferred cross-session edges minted: "
          f"{[r['inferred_edges_minted'] for r in recs]}")
    print(f"graph-only gold discoveries: "
          f"{[(r['question_id'], r['gold_sessions_via_graph_only']) for r in recs if r['gold_sessions_via_graph_only']]}")

if __name__ == '__main__':
    main()
