# Configuration reference

<!-- GENERATED FILE — do not edit. Regenerate with `npm run docs:config` (in mcp-server/). -->

This page lists all 327 `MANDREL_*` settings the Mandrel server reads.

## How to set a setting

Every setting is an environment variable. Set it in either place:

- **A `.env` file** (`mcp-server/.env`, or `config/environments/.env.<NODE_ENV>`; start from `.env.example` in the repository root) with lines such as `MANDREL_BELIEF_ENABLED=true`.
- **The process environment** — `export MANDREL_BELIEF_ENABLED=true` in your shell, an `environment:` entry in `docker-compose.yml`, or your service manager.

Values already in the process environment win over the `.env` file. Restart the server after a change. A value that cannot be parsed (for example text where a number is expected) is ignored and the default is used.
Booleans take `true` or `false` (most also accept `1`/`0`, `yes`/`no`, `on`/`off`). List settings take comma-separated values.

## Most people only need these

| Setting | Type | Default | Why you would set it |
| --- | --- | --- | --- |
| `MANDREL_BELIEF_ENABLED` | boolean | (built-in text) | Turns supersession detection on or off. When on, newly stored records are compared with their nearest neighbours and outdated ones are linked as superseded. |
| `MANDREL_BELIEF_ADJUDICATOR_PROVIDER` | one of anthropic \| openai-compat \| ollama \| subq \| tiered | (derived from other settings) | Which model service judges supersession. Unset (the default), the mode follows the keys you set: `SUBQ_API_KEY` and `ANTHROPIC_API_KEY` together give `tiered`, `SUBQ_API_KEY` alone gives `subq`, `ANTHROPIC_API_KEY` alone gives `anthropic`, neither leaves supersession off. Setting this always wins over the keys. Use `tiered` for a cheap first pass (tier 1) confirmed by a stronger model (tier 2), or a single provider: `anthropic`, `openai-compat` (Groq, llama.cpp), `ollama` (local) or `subq`. |
| `MANDREL_BELIEF_ADJUDICATOR_MODEL` | string | (built-in text) | Model name for a single (non-tiered) provider (default `claude-sonnet-5`, or `subq-snap-preview` when the provider is `subq`). |
| `MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV` | string | (built-in text) | Name of the environment variable that holds the API key for a single provider (default `ANTHROPIC_API_KEY`, or `SUBQ_API_KEY` when the provider is `subq`). Set that variable to your key. |
| `MANDREL_BELIEF_TIER1_PROVIDER` | one of openai-compat \| anthropic \| ollama \| subq | `subq` | Tiered mode: the cheap first-pass provider (default `subq`, SubQ Snap; set `openai-compat` for Groq). |
| `MANDREL_BELIEF_TIER1_MODEL` | string | (derived from other settings) | Tiered mode: the first-pass model (default `subq-snap-preview`; `openai/gpt-oss-120b` with the `openai-compat` provider). |
| `MANDREL_BELIEF_TIER1_API_KEY_ENV` | string | (derived from other settings) | Tiered mode: name of the variable holding the first-pass key (default `SUBQ_API_KEY`; `GROQ_API_KEY` with the `openai-compat` provider). |
| `MANDREL_BELIEF_TIER2_PROVIDER` | one of anthropic \| openai-compat \| ollama \| subq | `anthropic` | Tiered mode: the stronger confirming provider. |
| `MANDREL_BELIEF_TIER2_MODEL` | string | `claude-sonnet-5` | Tiered mode: the confirming model. |
| `MANDREL_BELIEF_TIER2_API_KEY_ENV` | string | `ANTHROPIC_API_KEY` | Tiered mode: name of the variable holding the confirming key (default `ANTHROPIC_API_KEY`). |
| `MANDREL_BELIEF_COST_ALERT_USD_PER_DAY` | number | `5` | Daily spend (USD) above which the cost report raises a loud alert. |
| `MANDREL_BELIEF_DAILY_SPEND_CAP_USD` | string | `2` | Hard daily spend cap (USD, UTC day) on paid supersession calls; default `2`, `0` = no cap. Writes never fail; capped pairs are skipped. |
| `MANDREL_EMBEDDER` | one of minilm \| gemma | `minilm` | Which embedding model builds the search index. |
| `MANDREL_OLLAMA_ENDPOINT` | string | `http://127.0.0.1:11434` | Where your Ollama server listens, if you use Ollama for embeddings or supersession. |
| `MANDREL_SESSION_RESOLVER_MODE` | one of legacy \| shadow \| actor | `legacy` | How sessions are matched to callers. Move from `legacy` to `shadow` to `actor` once clients send an actor id. |
| `MANDREL_SESSION_REQUIRE_ACTOR` | boolean | `false` | Reject writes that do not say who is writing, instead of recording them as anonymous. |
| `MANDREL_OAUTH_ENABLED` | boolean | `false` | Turns on the built-in OAuth server so web clients can connect without the static bearer token. |
| `MANDREL_TASK_CLAIM_ENABLED` | boolean | `false` | Lets workers claim a task with a lease so two workers do not take the same one. |

## All settings

[Supersession (belief)](#supersession-belief) · [Recall & search](#recall--search) · [Trust & project health](#trust--project-health) · [Briefing & handoff](#briefing--handoff) · [Sessions & identity](#sessions--identity) · [Server & auth](#server--auth) · [Embeddings](#embeddings) · [Threads, links & graph](#threads-links--graph) · [Tasks](#tasks)

### Supersession (belief)

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_BACKWARD_SOFT_GUARD` | boolean | `true` | Check, before honouring an automatic (soft) supersession, whether following the declared supersession links backwards contradicts it. Turn off to skip the check. |
| `MANDREL_BACKWARD_SOFT_MAX_HOPS` | integer | `25` | The maximum number of declared supersession hops the reachability walk will take before it returns undecided. |
| `MANDREL_BACKWARD_SOFT_UNDECIDED_POLICY` | one of honor \| suppress | `honor` | What to do with an automatic supersession when the backward check cannot decide: honor keeps it, suppress ignores it. |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_BETA` | string | (empty) | Optional anthropic-beta header value sent to the Anthropic API. Empty sends none. |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING` | boolean | `false` | Turn on Anthropic extended thinking for the supersession check. Slower and costlier; mainly useful for evaluating how much deeper reasoning helps. |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_BUDGET` | integer | `3072` | Token budget for extended thinking (the API minimum is 1024). |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_TYPE` | string | (empty) | Thinking mode name sent to the Anthropic API when extended thinking is off. Empty leaves it out. |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_TOOL_CHOICE` | string | `tool` | How the anthropic provider asks for its structured verdict. The default, tool, forces a call to the verdict tool. |
| `MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_VERSION` | string | `2023-06-01` | Value of the anthropic-version header sent to the Messages API. |
| `MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL` | string | `https://api.anthropic.com` | Base URL of the Anthropic Messages API, for the anthropic provider. Change it to route through a proxy. |
| `MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV` | string | (built-in text) | Name of the environment variable that holds the Anthropic API key (the key itself is never stored or logged). |
| `MANDREL_BELIEF_ADJUDICATOR_CHAT_TEMPLATE_KWARGS` | string | (empty) | A JSON object, written as a string, forwarded to an openai-compat host as chat_template_kwargs. Empty sends nothing. |
| `MANDREL_BELIEF_ADJUDICATOR_CONCURRENCY` | integer | `1` | How many supersession checks run at once. Keep it at 1 unless the model runs on its own hardware: raising it competes with embedding for CPU. |
| `MANDREL_BELIEF_ADJUDICATOR_ENDPOINT` | string | (built-in text) | Address of the Ollama server used by the ollama provider. |
| `MANDREL_BELIEF_ADJUDICATOR_KEEP_ALIVE` | string | `10m` | How long Ollama keeps the model loaded between calls, for example 10m. A loaded model answers in seconds instead of tens of seconds. |
| `MANDREL_BELIEF_ADJUDICATOR_MAX_CONTENT_CHARS` | integer | `1600` | Each record's text is cut to this many characters before it goes into the prompt, which bounds cost. |
| `MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS` | integer | `1024` | Cap on tokens in the model's reply, for the openai-compat and anthropic providers. The verdict is short, so a small cap keeps latency and spend down. Not used by ollama. |
| `MANDREL_BELIEF_ADJUDICATOR_MODEL` | string | (built-in text) | Model name sent to the provider selected by MANDREL_BELIEF_ADJUDICATOR_PROVIDER. |
| `MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE` | boolean | `true` | Leave the temperature field out of requests to the anthropic provider. On by default because current Claude models reject it. |
| `MANDREL_BELIEF_ADJUDICATOR_PROMPT_CACHE` | boolean | `true` | Use Anthropic prompt caching for the static part of the adjudication prompt (rubric and worked examples), which cuts cost on repeated calls. Only affects the anthropic provider. |
| `MANDREL_BELIEF_ADJUDICATOR_PROVIDER` | one of anthropic \| openai-compat \| ollama \| subq \| tiered | (derived from other settings) | Which model service judges supersession. Unset, it follows the keys you set (SUBQ_API_KEY + ANTHROPIC_API_KEY: tiered; one alone: subq or anthropic; neither: off); setting it wins. Choices: anthropic, openai-compat (Groq, llama.cpp), ollama (local), subq, or tiered, a cheap first pass confirmed by a stronger model (see the tier settings). |
| `MANDREL_BELIEF_ADJUDICATOR_REASONING_EFFORT` | string | (empty) | Reasoning depth (low, medium or high) for reasoning models served over an OpenAI-style API. Empty leaves it out. |
| `MANDREL_BELIEF_ADJUDICATOR_SEED` | integer | `0` | Fixed random seed so any remaining sampling is repeatable. |
| `MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K` | boolean | `true` | Include a top_k field in requests to an openai-compat provider. Local servers such as llama.cpp accept it; strict OpenAI-compatible hosts such as Groq reject it, so turn this off for them. |
| `MANDREL_BELIEF_ADJUDICATOR_STRUCTURED_OUTPUT` | boolean | `true` | With the ollama provider, constrain the model's reply to the verdict JSON schema. When false, only plain JSON mode is requested, which is looser. |
| `MANDREL_BELIEF_ADJUDICATOR_TEMPERATURE` | number | `0` | Sampling temperature for the verdict. 0 gives a stable, repeatable verdict. Ignored when MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE is true. |
| `MANDREL_BELIEF_ADJUDICATOR_THINK` | boolean | `false` | Allow the model's thinking (chain-of-thought) output. False keeps reasoning models to the short structured verdict, which is faster and more repeatable. |
| `MANDREL_BELIEF_ADJUDICATOR_TIMEOUT_MS` | integer | `60000` | Time limit, in milliseconds, for one supersession check. |
| `MANDREL_BELIEF_ADJUDICATOR_TOP_K` | integer | `1` | Sampling top-k for the verdict. 1 means greedy decoding, so the same input gives the same verdict. Only used by providers that accept top_k. |
| `MANDREL_BELIEF_ADJUDICATOR_TOP_P` | number | `1` | Nucleus sampling mass for the verdict. Mostly inert while top-k is 1 and temperature is 0. |
| `MANDREL_BELIEF_ATTEMPT_ERROR_MAX_CHARS` | integer | `500` | Longest provider error message kept in the attempt record, in characters. |
| `MANDREL_BELIEF_ATTEMPT_LEDGER_ENABLED` | boolean | `true` | Record every supersession attempt. Turning it off loses the failure-rate statistics but never changes a verdict. |
| `MANDREL_BELIEF_ATTEMPT_ROLLUP_WINDOW_DAYS` | integer | `7` | Default look-back window, in days, for the adjudication attempt summary. |
| `MANDREL_BELIEF_CONTEST_MIN_CONFIDENCE` | number | `0.5` | Minimum confidence for a contest verdict. Reserved: contest verdicts do not create links yet, so changing it has no effect today. |
| `MANDREL_BELIEF_COST_ALERT_USD_PER_DAY` | number | `5` | Daily spend threshold in USD (UTC day). Above it the cost notifier sends a loud alert instead of a quiet digest. |
| `MANDREL_BELIEF_COST_ROLLUP_WINDOW_DAYS` | integer | `7` | Default look-back window, in days, for the belief cost report when no window is given. |
| `MANDREL_BELIEF_DAILY_SPEND_CAP_USD` | string | `2` | Hard daily spend cap in USD (UTC day) on paid supersession calls. Once today's recorded cost reaches it, no paid call is made and the pair is skipped and logged; writes never fail. Resumes the next UTC day. 0 means no cap. |
| `MANDREL_BELIEF_ENABLED` | boolean | (built-in text) | Master switch for supersession (belief) detection. When true, each stored context or decision is checked in the background against its nearest neighbours and outdated records are linked as superseded. When false nothing is adjudicated, no model is called and no cost is incurred. |
| `MANDREL_BELIEF_PAIR_EXCLUDE_AUTO_RECORD_KINDS` | list | `tick-proposal, dispatch-proof, pick-log, gate-log` | Machine-written record kinds (read from the record's metadata kind) that are never compared as either side of a candidate pair. Empty disables the filter. |
| `MANDREL_BELIEF_PAIR_EXCLUDE_CONTENT_PREFIXES` | list | (built-in list of 7) | Records whose content starts with one of these prefixes are never compared as either side of a candidate pair. This keeps repetitive machine-written records out of adjudication. Empty disables the filter. |
| `MANDREL_BELIEF_PAIR_EXCLUDE_CONTENT_PREFIXES_EXTRA` | list | (empty list) | Extra content prefixes, comma-separated, added to MANDREL_BELIEF_PAIR_EXCLUDE_CONTENT_PREFIXES: records your own publishers write on a fixed template, which supersession should never compare. Empty adds nothing. |
| `MANDREL_BELIEF_PAIR_MAX_COSINE` | number | `0.95` | Candidate pairs more similar than this are dropped before adjudication, because near-identical restatements produce false supersession verdicts. |
| `MANDREL_BELIEF_PAIR_MIN_COSINE` | number | `0.6` | A neighbour must be at least this similar (cosine) to a new record to be compared with it. Below this the pair is never sent to the model. |
| `MANDREL_BELIEF_PAIR_TOP_K` | integer | `8` | At most this many of the most similar same-project records are compared with each new record. |
| `MANDREL_BELIEF_QUEUE_MAX_DEPTH` | integer | `1000` | How many records can wait in the background adjudication queue. Work beyond this depth is dropped rather than growing memory. |
| `MANDREL_BELIEF_SUBQ_DECISIONS_PATH` | string | `/v1/systemone` | URL path the subq provider appends to its endpoint. |
| `MANDREL_BELIEF_SUBQ_RUBRIC` | string | `compact` | Instructions the subq verdict question carries: compact is a short question, full is the complete adjudication rubric. |
| `MANDREL_BELIEF_SUBQ_SAME_SUBJECT_FROM` | string | `verdict` | How the subq provider decides two records share a subject: noul uses a separate yes-probability, verdict infers it from the verdict. |
| `MANDREL_BELIEF_SUBQ_SAME_SUBJECT_MIN` | number | `0.5` | With the noul source, the yes-probability at or above which two records count as the same subject. |
| `MANDREL_BELIEF_TIER1_API_KEY_ENV` | string | (derived from other settings) | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: the NAME of the environment variable that holds the API key (the default reads SUBQ_API_KEY, or GROQ_API_KEY with the openai-compat provider). Set the key in that variable; the key itself is never stored or logged. |
| `MANDREL_BELIEF_TIER1_ENDPOINT` | string | (derived from other settings) | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: base URL of the provider's API. |
| `MANDREL_BELIEF_TIER1_MAX_TOKENS` | integer | (derived from other settings) | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: cap on tokens in the reply. Defaults to the single-provider MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS value. |
| `MANDREL_BELIEF_TIER1_MODEL` | string | (derived from other settings) | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: the model id sent to the tier-1 provider. |
| `MANDREL_BELIEF_TIER1_OMIT_TEMPERATURE` | boolean | `false` | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: leave the temperature field out of requests. Off by default (Groq and SubQ accept temperature). |
| `MANDREL_BELIEF_TIER1_PROVIDER` | one of openai-compat \| anthropic \| ollama \| subq | `subq` | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: which provider to call. The default, subq, runs SubQ Snap (model subq-snap-preview); openai-compat targets Groq's OpenAI-style API. |
| `MANDREL_BELIEF_TIER1_REASONING_EFFORT` | string | (empty) | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: reasoning depth (low, medium or high) for reasoning models served over the OpenAI-style API. Empty leaves it out. |
| `MANDREL_BELIEF_TIER1_SEND_TOP_K` | boolean | `false` | Tier-1 (cheap prescreen) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: include top_k in requests. Off by default because Groq rejects it. |
| `MANDREL_BELIEF_TIER2_ANTHROPIC_THINKING_TYPE` | string | (derived from other settings) | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: thinking mode sent to the Anthropic API. Empty leaves it out. Defaults to the single-provider setting. |
| `MANDREL_BELIEF_TIER2_ANTHROPIC_TOOL_CHOICE` | string | (derived from other settings) | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: how the Anthropic provider asks for its structured verdict. Defaults to the single-provider setting. |
| `MANDREL_BELIEF_TIER2_API_KEY_ENV` | string | `ANTHROPIC_API_KEY` | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: the NAME of the environment variable that holds the API key (the default reads ANTHROPIC_API_KEY). Set the key in that variable; the key itself is never stored or logged. |
| `MANDREL_BELIEF_TIER2_ENDPOINT` | string | (derived from other settings) | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: base URL of the provider's API. Defaults to the single-provider endpoint setting. |
| `MANDREL_BELIEF_TIER2_MAX_TOKENS` | integer | (derived from other settings) | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: cap on tokens in the reply. Defaults to the single-provider MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS value. |
| `MANDREL_BELIEF_TIER2_MODEL` | string | `claude-sonnet-5` | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: the model id sent to the tier-2 provider. |
| `MANDREL_BELIEF_TIER2_OMIT_TEMPERATURE` | boolean | `true` | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: leave the temperature field out of requests. On by default because current Claude models reject it. |
| `MANDREL_BELIEF_TIER2_PROVIDER` | one of anthropic \| openai-compat \| ollama \| subq | `anthropic` | Tier-2 (authoritative confirmation) adjudicator when MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered: which provider to call. The default is anthropic. |
| `MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS` | list | `supersedes, contests` | With the tiered provider, tier-1 verdicts in this comma-separated list are sent to tier 2 for confirmation. Other verdicts are final at tier 1, so they never incur the tier-2 cost. |

### Recall & search

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_LEXICAL_IDENTIFIER_MAX_LENGTH` | integer | `128` | Longest identifier token, in characters, that keyword search will index. Longer ones are skipped to keep the index small. |
| `MANDREL_LEXICAL_INDEX_MAX_CHARS` | integer | `65536` | How many characters of a record's text are indexed for keyword search. Values above the safe ceiling make the server refuse to start. |
| `MANDREL_LEXICAL_SEARCH_ENABLED` | boolean | `true` | Turn on keyword (lexical) matching alongside semantic search, so exact identifiers and rare terms are found reliably. |
| `MANDREL_RANK_BAL_HALFLIFE_DAYS` | number | `30` | Recency half-life in days for the balanced ranking profile, the default for search. |
| `MANDREL_RANK_BAL_IMP` | number | `0.1` | Weight of record importance in the balanced ranking profile. |
| `MANDREL_RANK_BAL_REC` | number | `0.05` | Weight of recency in the balanced ranking profile. |
| `MANDREL_RANK_BAL_SIM` | number | `0.75` | Weight of semantic similarity in the balanced ranking profile, the default for search. |
| `MANDREL_RANK_BAL_TYPE` | number | `0.1` | Weight of record type in the balanced ranking profile. |
| `MANDREL_RANK_REC_HALFLIFE_DAYS` | number | `7` | Recency half-life in days for the recency-focused profile, used for queries that ask for the latest records. |
| `MANDREL_RANK_REC_IMP` | number | `0.025` | Weight of record importance in the recency-focused ranking profile. |
| `MANDREL_RANK_REC_REC` | number | `0.9` | Weight of recency in the recency-focused ranking profile. |
| `MANDREL_RANK_REC_SIM` | number | `0.05` | Weight of semantic similarity in the recency-focused ranking profile. |
| `MANDREL_RANK_REC_TYPE` | number | `0.025` | Weight of record type in the recency-focused ranking profile. |
| `MANDREL_RECALL_CONCISE_MAXLEN` | integer | `500` | Characters of each record's content returned when a caller asks for the concise response format. |
| `MANDREL_RECALL_DEFAULT_FORMAT` | one of concise \| detailed | `detailed` | Response format used when the caller does not choose one: detailed returns full records, concise returns truncated content. |
| `MANDREL_RECORD_HEADLINE_MAX_CHARS` | integer | `180` | Maximum length of the one-line headline shown for a record, including prefix and ellipsis. |
| `MANDREL_SEARCH_ABSENT_TERM_ORDINALS_ORDINARY` | boolean | `true` | Treat ordinals such as 7th or 22nd as ordinary words, so a date ordinal the corpus never contains does not empty a search. |
| `MANDREL_SEARCH_ABSENT_TERM_TOLERATED_ABSENT` | integer | `1` | How many unfamiliar names (absent from every record and not ordinary English) a search may contain and still return results, provided enough of its other words match (MANDREL_SEARCH_ABSENT_TERM_TOLERATED_MIN_MATCHED). More than this and the search returns empty; 0 means no tolerance (any unfamiliar name empties the search). |
| `MANDREL_SEARCH_ABSENT_TERM_TOLERATED_MIN_MATCHED` | integer | `3` | How many of a question's other content terms must occur in the corpus before one absent term is tolerated. |
| `MANDREL_SEARCH_ABSENT_TERM_VETO` | boolean | `true` | Return no results when the query contains a term that appears in no record of the project and is not an ordinary English word, rather than returning loosely related records. |
| `MANDREL_SEARCH_IDENTIFIER_PRECEDENCE` | boolean | `true` | Rank records that contain an exact identifier you typed above every record that does not, so identifier hits are not diluted by prose ranking. |
| `MANDREL_SEARCH_LEXICAL_CANDIDATES_PER_TABLE` | integer | `50` | How many keyword-search candidates are fetched from each table before results are merged. |
| `MANDREL_SEARCH_LEXICAL_QUERY_MAX_CHARS` | integer | (derived from other settings) | Longest search query, in characters, that is sent to keyword search. Defaults to the general search query limit. |
| `MANDREL_SEARCH_NEAR_MISS_LONG_DISTANCE` | integer | `2` | Largest edit distance still counted as a near-miss for a term at or above the long length. |
| `MANDREL_SEARCH_NEAR_MISS_LONG_LENGTH` | integer | `9` | Term length at which the larger near-miss edit-distance allowance starts. |
| `MANDREL_SEARCH_NEAR_MISS_MIN_LENGTH` | integer | `5` | Shortest word, in characters, that can count as a misspelling of a word in the retrieved records rather than as an unfamiliar name. Shorter words are within one edit of too many others. |
| `MANDREL_SEARCH_NEAR_MISS_PROJECT_FALLBACK` | boolean | `true` | Before returning an empty result, also check the unfamiliar words against every word in the project (not only the retrieved records) for a near-miss spelling. Costs one scan of the project's search index, only on searches that would otherwise come back empty. |
| `MANDREL_SEARCH_NEAR_MISS_SHORT_DISTANCE` | integer | `1` | Largest edit distance still counted as a near-miss for a term shorter than the long length. |
| `MANDREL_SEARCH_PROSE_MATCH_MODE` | one of any \| all \| off | `all` | How prose queries match: any returns records containing any query term (higher recall), all requires every term, off disables the prose channel. |
| `MANDREL_SEARCH_RRF_K` | integer | `60` | Smoothing constant k in reciprocal rank fusion, the formula that merges keyword and semantic rankings. Larger values flatten the difference between top ranks. |
| `MANDREL_SMART_SEARCH_CLIP_AFFORDANCE` | string | (built-in text) | Text appended to a clipped smart_search snippet. {omitted} is replaced by the number of characters dropped. |
| `MANDREL_SMART_SEARCH_DEFAULT_ALTITUDE` | one of headline \| summary \| full | `summary` | Default detail level of smart_search results: headline, summary or full. |
| `MANDREL_SMART_SEARCH_SNIPPET_MAXLEN` | integer | `280` | Characters of each result's body that smart_search shows at summary detail. |
| `MANDREL_TRUST_WIRE_SCORE_PRECISION` | integer | `2` | Decimal places in trust scores returned to clients. |

### Trust & project health

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_CURRENT_STATE_MAX_ACTIVE_TASKS` | integer | `10` | Most active tasks listed in the current-state view. |
| `MANDREL_CURRENT_STATE_MAX_BLOCKERS` | integer | `10` | Most blockers and findings listed in the current-state view. |
| `MANDREL_CURRENT_STATE_MAX_DECISIONS` | integer | `10` | Most standing decisions listed in the current-state view. |
| `MANDREL_CURRENT_STATE_MAX_HISTORICAL_IDS` | integer | `5` | Record ids shown as a sample for each kind of historical work (completed, abandoned, unknown). Counts stay exact. |
| `MANDREL_CURRENT_STATE_MAX_OUTCOMES` | integer | `5` | Most recent trusted outcomes listed in the current-state view. |
| `MANDREL_CURRENT_STATE_MAX_RECENT_CONTEXTS` | integer | `5` | Most recent contexts listed in the current-state view, regardless of trust. |
| `MANDREL_CURRENT_STATE_MAX_SUPERSEDED_IDS` | integer | `20` | Superseded record ids shown as a sample. The count stays exact. |
| `MANDREL_CURRENT_STATE_NODE_ALTITUDE` | one of headline \| summary \| full | `headline` | Detail level of each item in a current-state section: headline, summary or full. Re-call with a higher level to drill down. |
| `MANDREL_CURRENT_STATE_OUTCOME_VALUE_FLOOR` | number | `0.5` | Minimum outcome value (0 to 1) for a record's result to be surfaced as an outcome. |
| `MANDREL_CURRENT_STATE_RELEASE_GATE` | boolean | `true` | Treat finished work with no recorded artifact or release as awaiting release rather than done. |
| `MANDREL_CURRENT_STATE_TRUST_FLOOR` | trust band name or number 0-1 | `ok` | Minimum trust a record must clear to be reported as a latest trusted outcome: a trust band name or a score from 0 to 1. |
| `MANDREL_INSIGHTS_ATTRIBUTION_FLOOR` | number | `0.9` | Minimum share of records that must carry a session attribution before the insights report stops flagging it. |
| `MANDREL_INSIGHTS_CONVERGENCE_FLOOR` | number | `0.9` | Minimum share of records that must carry at least one link for the insights report to call the graph well connected. |
| `MANDREL_INSIGHTS_EVIDENCE_FLOOR` | number | `0.8` | Minimum share of completed tasks that must be backed by at least one trusted outcome before the insights report stops flagging them. |
| `MANDREL_INSIGHTS_GROUNDING_FLOOR` | number | `0.9` | Minimum share of active tasks that must carry at least one grounding link before the insights report stops flagging them. |
| `MANDREL_INSIGHTS_HISTORY_TRUST_FLOOR_RATIO` | number | `0.8` | Minimum share of historical records that must clear the trust floor before the insights report stops flagging them. |
| `MANDREL_INSIGHTS_MAX_NODES` | integer | `300` | Most records examined in one insights call. The report says when it was capped. |
| `MANDREL_INSIGHTS_MAX_RENDERED_FINDINGS` | integer | `6` | Most findings shown in the text report. The structured output carries all of them. |
| `MANDREL_INSIGHTS_MAX_SAMPLE_IDS` | integer | `5` | Record ids shown as a sample for each finding. Counts stay exact. |
| `MANDREL_INSIGHTS_TRUST_FLOOR` | trust band name or number 0-1 | `ok` | Minimum trust a record must clear to count as proven: a trust band name or a score from 0 to 1. |
| `MANDREL_PROVENANCE_ALARM_ENABLED` | boolean | `true when NODE_ENV=production, otherwise false` | Raise an alarm when records stop arriving from a source that normally writes. On by default only when NODE_ENV=production. |
| `MANDREL_PROVENANCE_ALERT_DEDUPE_MINUTES` | integer | `1440` | Minimum minutes between repeated provenance alarms for the same problem. |
| `MANDREL_PROVENANCE_CHECK_INTERVAL_MINUTES` | integer | `60` | Minutes between provenance checks. |
| `MANDREL_PROVENANCE_CHECK_WATCHDOG_MINUTES` | integer | `15` | If no provenance check has completed for this many minutes, the check itself is reported as stuck. |
| `MANDREL_PROVENANCE_DECLARED_FLOOR` | integer | `10` | Minimum number of records in the window that must declare their provenance before the check judges the ratio. |
| `MANDREL_PROVENANCE_METER_QUERY_TIMEOUT_MS` | integer | `30000` | Time limit in milliseconds for the database query behind a provenance check. |
| `MANDREL_PROVENANCE_RETIRED_SOURCES` | list | (empty list) | Comma-separated sources that are no longer expected to write, so their silence raises no alarm. |
| `MANDREL_PROVENANCE_SOURCE_ACTIVE_PER_WEEK` | integer | `20` | A source that wrote at least this many records in a week counts as active, so its later silence is worth an alarm. |
| `MANDREL_PROVENANCE_SOURCE_LOOKBACK_WEEKS` | integer | `8` | How many weeks back the provenance check looks when deciding whether a source was active. |
| `MANDREL_PROVENANCE_WINDOW_DAYS` | integer | `7` | Length in days of the window the provenance check measures. |
| `MANDREL_TRUST_ABSTAIN_BELOW` | number | `0.4` | Records scoring below this tell the AI to abstain from relying on them. |
| `MANDREL_TRUST_FRESHNESS_HALFLIFE_DAYS` | number | `30` | Half-life of the freshness decay, in days: a record is half as fresh after this many days. |
| `MANDREL_TRUST_MIN_OUTCOME_SAMPLES` | integer | `1` | Outcomes that must be counted before the outcome signal is used at all. |
| `MANDREL_TRUST_SOFT_SUPERSEDE_DEMOTION` | number | `0.5` | Multiplier applied to a record's trust score when it has been softly superseded (an automatic supersession or a possible one). 1 means no demotion; clamped to 0-1. |
| `MANDREL_TRUST_STALE_BELOW` | number | `0.4` | Freshness below this marks a record stale. |
| `MANDREL_TRUST_TRUSTED_AT` | number | `0.66` | Score at or above which a record is in the trusted band. |
| `MANDREL_TRUST_WEIGHT_FRESHNESS` | number | `0.4` | Weight of the freshness signal in the trust score. Freshness is the only signal until outcomes accrue. |
| `MANDREL_TRUST_WEIGHT_OUTCOME` | number | `0.6` | Weight of the outcome signal in the trust score. Outcomes dominate once they exist. |

### Briefing & handoff

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_BLOCKED_ON_CAPABILITY_TTL_MS` | integer | `60000` | How long, in milliseconds, the result of checking for the blocked-on database column is reused. 0 checks on every call. |
| `MANDREL_BRIEFING_ALTITUDE_ENABLED` | boolean | `true` | Master switch for the briefing's two detail levels (one-line shape and full prose), its reserved full-prose slots and its per-section selection quotas. Off restores the older rendering. |
| `MANDREL_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES` | list | `blocked` | Task statuses that are dropped last when the briefing hits its size cap, after every unprotected record. Should be a subset of MANDREL_BRIEFING_OPEN_TASK_STATUSES. |
| `MANDREL_BRIEFING_BACKFILL_ENABLED` | boolean | `true` | After the size cap drops records, re-admit dropped ones that still fit in the leftover space. |
| `MANDREL_BRIEFING_BRANCH_RESERVED_CHARS` | integer | `4000` | Characters reserved for the "On this branch" section, taken out of MANDREL_BRIEFING_MAX_CHARS. |
| `MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED` | boolean | `false` | Make the briefing branch-aware: it selects and protects the records on the reader's declared branch. Off by default, so the briefing behaves as it always has until you turn it on. |
| `MANDREL_BRIEFING_CONVENTION_TAGS` | list | `convention, constraint` | Tags that mark a record as a convention or constraint for the briefing's Conventions section. A tag matches if it equals a value or starts with it followed by a colon. |
| `MANDREL_BRIEFING_DEADEND_RESERVED_CHARS` | integer | `4000` | Characters reserved for the Dead ends section, taken out of MANDREL_BRIEFING_MAX_CHARS. |
| `MANDREL_BRIEFING_DEADEND_TAGS` | list | `dead-end, deadend, rejected` | Tags that mark a record as a recorded dead end. A tag matches if it equals a value or starts with it followed by a colon. |
| `MANDREL_BRIEFING_EXCLUDED_TASK_TAGS` | list | `parked` | Tags that mark a task as deliberately not being done. Such tasks are left out of Open tasks. |
| `MANDREL_BRIEFING_FULL_PROSE_EXCLUDE_TAGS` | list | (empty list) | Tags that exclude a record from a full-prose slot however well it ranks. |
| `MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS` | integer | `1200` | Longest full-prose body in the briefing, in characters. Longer bodies are cut and say so. |
| `MANDREL_BRIEFING_FULL_PROSE_SLOTS` | integer | `3` | How many records get a full-prose body in the briefing. |
| `MANDREL_BRIEFING_FULL_PROSE_TYPES` | list | `task, decision` | Record kinds that may receive a full-prose slot in the briefing. Comma-separated. |
| `MANDREL_BRIEFING_HANDOFF_STAMP_DELETED_LABEL` | string | `deleted` | Status word stamped next to a task reference in a handoff when that task has been deleted. |
| `MANDREL_BRIEFING_HANDOFF_STAMP_ENABLED` | boolean | `true` | Annotate task references in handoffs with the task's current status. |
| `MANDREL_BRIEFING_HANDOFF_STAMP_FORMAT` | string | (built-in text) | Format of the status stamp. {status} is replaced by the task's current status; keep the leading space. |
| `MANDREL_BRIEFING_MAX_CHARS` | integer | `24000` | Size cap for the briefing, in characters. Whole records are dropped, least protected first, rather than cut short. |
| `MANDREL_BRIEFING_OPEN_TASK_STATUSES` | list | `todo, in_progress, blocked` | Task statuses the briefing counts as open work. |
| `MANDREL_BRIEFING_PROTECTED_TASK_PRIORITIES` | list | `urgent, high` | Task priorities that earn extra protection from being dropped when the briefing is over its cap. |
| `MANDREL_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE` | integer | `3` | Protection rank for tasks in an always-surface status. Higher ranks are dropped last. |
| `MANDREL_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER` | integer | `4` | Protection rank for records on the reader's own declared branch. The highest rank is dropped last when the briefing is over its size cap. |
| `MANDREL_BRIEFING_PROTECTION_RANK_CONVENTION` | integer | `3` | Protection rank for convention and constraint records in the briefing. Higher ranks are dropped last when the briefing is over its size cap. |
| `MANDREL_BRIEFING_PROTECTION_RANK_DECISION` | integer | `0` | Protection rank for live decisions. Higher ranks are dropped last. |
| `MANDREL_BRIEFING_PROTECTION_RANK_PRIORITY` | integer | `1` | Protection rank for open high-priority tasks that are not yet stale. Higher ranks are dropped last. |
| `MANDREL_BRIEFING_PROTECTION_RANK_STALE_PRIORITY` | integer | `2` | Protection rank for open high-priority tasks that are also stale. Higher ranks are dropped last. |
| `MANDREL_BRIEFING_RECORDING_DIRECTIVE` | string | (built-in text) | Text appended to the briefing that reminds the reading session to record decisions, progress and a handoff before it stops. Replace it to change the wording. |
| `MANDREL_BRIEFING_RECORDING_DIRECTIVE_ENABLED` | boolean | `true` | Append the recording reminder to the briefing. Turn off to omit it. |
| `MANDREL_BRIEFING_SECTION_MAX_RECORDS` | integer | `200` | Most records fetched for each briefing list section. The size cap then drops whole records from what was fetched. |
| `MANDREL_BRIEFING_SELECT_MAX_BRANCH_MEMBERS` | integer | `26` | How many records from the reader's own branch the briefing's branch section includes. |
| `MANDREL_BRIEFING_SELECT_MAX_CONVENTIONS` | integer | `5` | How many convention records the briefing includes. |
| `MANDREL_BRIEFING_SELECT_MAX_DEAD_ENDS` | integer | `15` | How many dead-end records the briefing includes. |
| `MANDREL_BRIEFING_SELECT_MAX_DECISIONS` | integer | `16` | How many live decisions the briefing includes, best first. |
| `MANDREL_BRIEFING_SELECT_MAX_TASKS` | integer | `28` | How many open tasks the briefing includes, best first. |
| `MANDREL_BRIEFING_STALE_TASK_DAYS` | integer | `7` | Age in days, counted from creation, after which an open task counts as stale in the briefing. |
| `MANDREL_BRIEFING_TAG_COLLISION_ENABLED` | boolean | `true` | Report tags whose spellings collide, such as case variants, in the briefing. |
| `MANDREL_BRIEFING_TAG_COLLISION_MAX_GROUPS` | integer | `5` | How many tag-collision groups are listed before the rest are only counted. |
| `MANDREL_BRIEFING_WAITING_DUE_HINT_CAVEAT` | string | (built-in text) | Explanation shown for a due? marker, which is a date found in a task's text rather than a real deadline. |
| `MANDREL_BRIEFING_WAITING_ENABLED` | boolean | `true` | Show the section listing work that is waiting on a person. |
| `MANDREL_BRIEFING_WAITING_FALLBACK_CAVEAT` | string | (built-in text) | Warning shown above the briefing's waiting-on-a-person list when it was built from blocked tasks rather than an explicit blocked-on field, noting that the list is low precision. |
| `MANDREL_BRIEFING_WAITING_MAX_RECORDS` | integer | `25` | Most rows fetched for the waiting-on-a-person section. |
| `MANDREL_BRIEFING_WAITING_RESERVED_CHARS` | integer | `2500` | Characters reserved for the waiting-on-a-person section, taken out of the briefing size cap. |
| `MANDREL_HANDOFF_DEFAULT_LANE` | string | `coordinator` | Lane assigned to a handoff that carries no lane tag. |
| `MANDREL_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS` | integer | `240` | Characters of each candidate handoff's first line shown when the server refuses to pick between competing handoffs. |
| `MANDREL_HANDOFF_HEAD_MAX_HOPS` | integer | `256` | Most supersession links followed when finding the current handoff in a chain. |
| `MANDREL_HANDOFF_HEAD_REFUSAL_REMEDY` | string | (built-in text) | Repair instructions shown when a handoff chain is ambiguous, for example after a fork. |
| `MANDREL_HANDOFF_LANE_TAG_PREFIX` | string | `ws:` | Tag prefix that marks a handoff's lane. |
| `MANDREL_HANDOFF_MODE_VOCABULARY` | string | `facilitate, define-to-lock, build, debug, research` | Comma-separated handoff modes the server recognises without comment. Any other mode is stored too, with a note. An empty value recognises none. |
| `MANDREL_HANDOFF_SUPERSEDES_TAG_PREFIX` | string | `supersedes:` | Tag prefix naming an explicit handoff predecessor. |
| `MANDREL_TAG_COLLISION_WRITE_MAX_EXISTING` | integer | `3` | How many existing spellings one tag-collision warning names before it summarises. |
| `MANDREL_TAG_COLLISION_WRITE_MAX_WARNINGS` | integer | `3` | How many colliding tags one write reports before it only counts the rest. |
| `MANDREL_TAG_COLLISION_WRITE_WARNING_ENABLED` | boolean | `true` | Warn when a task or decision is written with a tag spelled differently from an existing tag. |

### Sessions & identity

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_ATTRIBUTION_NOTICE_DEADLINE` | string | (unset) | A date or phrase announcing when unattributed writes will start being rejected. Unset leaves the deadline sentence out of the notice entirely. |
| `MANDREL_ATTRIBUTION_NOTICE_ENABLED` | boolean | `true` | Attach a one-time notice to writes that carry no actor identity, telling the client how to identify itself. Turn it off to leave responses unchanged. |
| `MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS` | integer | `5000` | Upper bound on how many callers the server remembers having shown the notice to. At the bound the oldest entry is forgotten, so that caller may see the notice again. |
| `MANDREL_ATTRIBUTION_NOTICE_SETUP_URL` | string | (empty) | Page with per-client setup instructions, linked from the attribution notice. Empty leaves the setup line out of the notice. |
| `MANDREL_ATTRIBUTION_NOTICE_TTL_MS` | integer | `21600000` | How often the same caller is shown the attribution notice again, in milliseconds. The default is once per six hours. |
| `MANDREL_ATTRIBUTION_SUGGESTED_ACTOR` | string | (unset) | The actor name the attribution notice suggests. Unset shows the placeholder <your-name>; a single-user deployment can set the one correct name to make the notice copy-and-paste. |
| `MANDREL_PROJECT_ECHO_ENABLED` | boolean | `true` | Add a line to write responses that says which project the write went to. |
| `MANDREL_PROJECT_INSTRUCTIONS_ENABLED` | boolean | `true` | Send project instructions to a client when it connects. |
| `MANDREL_SESSION_ABSOLUTE_CAP_SEC` | integer | `604800` | Any open session older than this many seconds, counted from its start, is ended by the closer however recently it was active. |
| `MANDREL_SESSION_ACTIVITY_TOUCH_MAX_ENTRIES` | integer | `10000` | Soft cap on the in-memory table that throttles session-activity updates. Older entries are swept when it is exceeded. |
| `MANDREL_SESSION_ACTIVITY_TOUCH_MIN_INTERVAL_SEC` | integer | `60` | At most one last-activity update per session every this many seconds, however many calls arrive. |
| `MANDREL_SESSION_ACTIVITY_TOUCH_ON_READ` | boolean | `true` | Count read calls as session activity, not only writes. |
| `MANDREL_SESSION_CLOSER_SWEEP_SEC` | integer | `3600` | In actor mode, how often the closer ends dormant sessions past MANDREL_SESSION_HARD_CAP_SEC, in seconds. |
| `MANDREL_SESSION_DORMANTER_SWEEP_SEC` | integer | `300` | In actor mode, how often idle sessions are marked dormant, in seconds. |
| `MANDREL_SESSION_FLUSH_SEC` | integer | `30` | How often in-memory session counters are saved to the database, in seconds. A crash loses at most this window. |
| `MANDREL_SESSION_HARD_CAP_SEC` | integer | `18000` | A dormant session idle for longer than this many seconds is ended by the closer. |
| `MANDREL_SESSION_IDLE_DORMANT_SEC` | integer | `3600` | An active session with no activity for this many seconds is marked dormant. A dormant session is not ended and resumes on the next action. |
| `MANDREL_SESSION_IDLE_TIMEOUT_SEC` | integer | `3600` | Legacy mode: a session idle for this many seconds is closed by the idle reaper. |
| `MANDREL_SESSION_LIST_DEFAULT_LIMIT` | integer | `20` | How many sessions session_list returns when no limit is given. |
| `MANDREL_SESSION_LIST_MAX_LIMIT` | integer | `100` | Largest limit session_list honours. Larger requests are clamped and the response says so. |
| `MANDREL_SESSION_RAMSTORE_CLEANUP_SEC` | integer | `600` | How often stale per-connection entries are cleared from the in-memory session store, in seconds. |
| `MANDREL_SESSION_RAMSTORE_MAX_IDLE_SEC` | integer | `86400` | Seconds after which an unused per-connection entry is evicted from the in-memory session store. |
| `MANDREL_SESSION_REAPER_FAILURE_ALERT_AFTER` | integer | `3` | Consecutive failed reaper sweeps before a single critical log line is written. |
| `MANDREL_SESSION_REAPER_SWEEP_SEC` | integer | `300` | In legacy and shadow modes, how often the idle reaper runs, in seconds. |
| `MANDREL_SESSION_REATTACH_WINDOW_SEC` | integer | (derived from other settings) | Seconds within which a connection with no live session re-attaches to its most recent open session instead of starting a new one. Defaults to MANDREL_SESSION_IDLE_TIMEOUT_SEC. |
| `MANDREL_SESSION_REQUIRE_ACTOR` | boolean | `false` | Reject writes that carry no actor identity (X-Actor-ID header) instead of recording them against an anonymous session. Off by default. |
| `MANDREL_SESSION_RESOLVER_MODE` | one of legacy \| shadow \| actor | `legacy` | How sessions are matched to callers. legacy keeps per-connection sessions; shadow also computes the actor-based answer and logs whether they agree; actor uses the actor-based answer and starts the idle and closing sweeps. |

### Server & auth

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_ADVERTISE_OUTPUT_SCHEMAS` | boolean | `true` | Include each tool's output schema in the tool list. Turn off to shrink the list by about 45%; results are unaffected. |
| `MANDREL_DASHBOARD_SESSION_SWEEP_INTERVAL_MINUTES` | number | `60` | Minutes between sweeps that delete expired dashboard sign-in sessions (the sweep itself is on unless MANDREL_DASHBOARD_SESSION_SWEEP_ENABLED is false). |
| `MANDREL_DASHBOARD_SIGNIN_RATE_MAX` | number | `10` | Failed dashboard sign-in attempts allowed per email and client address within MANDREL_DASHBOARD_SIGNIN_RATE_WINDOW_MS before further attempts get 429. Successful sign-ins never count. |
| `MANDREL_DASHBOARD_SIGNIN_RATE_WINDOW_MS` | number | (built-in text) | Length of the window, in milliseconds, over which failed dashboard sign-ins are counted against MANDREL_DASHBOARD_SIGNIN_RATE_MAX. |
| `MANDREL_FLAT_TOOLS` | one of accept \| reject | `accept` | With the gateway tool surface, whether the individual (non-gateway) tool names are still accepted. Three flat tools (recall_thread, smart_search, get_recommendations) are always accepted. |
| `MANDREL_LAZY_CORE_ENUM_MAX` | integer | `12` | Largest closed set of values (an enum) that the lazy tool list spells out in a tool's schema. Longer sets are listed by name only; ask discover.explain for the values. |
| `MANDREL_OAUTH_ALLOW_SIGNUP` | boolean | `false` | Let anyone create an account on the OAuth server's email-and-password endpoint. Off by default, so only existing accounts can sign in. |
| `MANDREL_OAUTH_BASE_PATH` | string | `/api/oauth` | Path prefix the OAuth server mounts its endpoints under. |
| `MANDREL_OAUTH_CORS_ORIGINS` | list | `https://claude.ai` | Browser origins allowed to call the OAuth and discovery routes. Claude.ai's web connector needs https://claude.ai. |
| `MANDREL_OAUTH_DCR_CLIENT_CAP` | integer | `100` | Maximum number of dynamically registered OAuth clients kept per tenant. |
| `MANDREL_OAUTH_DCR_RATE_MAX` | integer | `5` | Dynamic client registrations allowed per rate window from one caller. |
| `MANDREL_OAUTH_DCR_RATE_WINDOW_SEC` | integer | `60` | Length in seconds of the dynamic client registration rate-limit window. |
| `MANDREL_OAUTH_DCR_SWEEP_ENABLED` | boolean | `true` | Periodically delete dynamically registered OAuth clients that are older than the time-to-live. |
| `MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES` | integer | `360` | Minutes between cleanup sweeps of expired dynamically registered OAuth clients. |
| `MANDREL_OAUTH_DCR_TTL_DAYS` | integer | `30` | Days a dynamically registered OAuth client lives before the cleanup sweep removes it. |
| `MANDREL_OAUTH_ENABLED` | boolean | `false` | Turn on the built-in OAuth authorization server. When off, /mcp accepts only the static bearer token. |
| `MANDREL_OAUTH_ISSUER` | string | `http://localhost:8080` | Public origin clients use to reach the OAuth server, with no trailing slash. It becomes the issuer in tokens and discovery documents. |
| `MANDREL_OAUTH_RATELIMIT_ENABLED` | boolean | `true` | Rate-limit the OAuth server's endpoints. |
| `MANDREL_OAUTH_RESOURCE` | string | (built-in text) | Exact public URL of the /mcp endpoint, used as the token audience. Defaults to the issuer followed by /mcp. |
| `MANDREL_OAUTH_SECRET` | string | (derived from other settings) | Secret used to sign and encrypt OAuth tokens. Required in production when OAuth is enabled; generate one with `openssl rand -hex 32`. Falls back to BETTER_AUTH_SECRET if that is set. |
| `MANDREL_OAUTH_TRUSTED_ORIGINS` | list | (derived from other settings) | Origins the OAuth library trusts for cookies and redirects. Defaults to the issuer plus the CORS origins. |
| `MANDREL_SET_PASSWORD_STATUS_RATE_MAX` | number | `30` | Calls per client allowed to the set-password page's status check within MANDREL_SET_PASSWORD_STATUS_RATE_WINDOW_MS before it answers 429. |
| `MANDREL_SET_PASSWORD_STATUS_RATE_WINDOW_MS` | number | `60000` | Length of the window, in milliseconds, for MANDREL_SET_PASSWORD_STATUS_RATE_MAX. |
| `MANDREL_SET_PASSWORD_TTL_HOURS` | number | `48` | How many hours a newly minted set-password link keeps working. |
| `MANDREL_TEXT_ANTI_ABUSE_CEILING` | integer | `5000000` | Largest size, in characters, accepted for any unbounded text field such as record content. |
| `MANDREL_TOOL_SURFACE` | one of legacy \| gateway | `legacy` | Which tool surface the server advertises: legacy lists every tool individually; gateway groups them into a small set of gateway tools. |
| `MANDREL_TOOLLIST_MODE` | one of lazy \| full | `lazy` | With the gateway surface, how tools are advertised: lazy sends a minimal action list per gateway and full sends complete schemas. |
| `MANDREL_TOOLLIST_TOKEN_BUDGET` | integer | `1550` | Ceiling, in tokens, for the lazy gateway tool list. The size check fails if the list grows past it. |

### Embeddings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_EMBED_ALERT_DEDUPE_MINUTES` | integer | `15` | Minimum minutes between repeated alerts about the same embedding failure. |
| `MANDREL_EMBED_ALERT_ENABLED` | boolean | `true when NODE_ENV=production, otherwise false` | Send an alert when embedding keeps failing. On by default only when NODE_ENV=production; failures are still logged and recorded either way. |
| `MANDREL_EMBED_ALERT_NOTIFY_SCRIPT` | string | (empty) | Path of a script run to deliver the embedding-failure alert. Empty means alerts are logged only. |
| `MANDREL_EMBEDDER` | one of minilm \| gemma | `minilm` | Which embedding model builds the search index: minilm is built in and runs offline, gemma runs through an Ollama server. |
| `MANDREL_EMBEDDING_VERIFY_STARTUP` | one of warn \| strict | `strict` | What the server does when the embedding model cannot load or be reached at startup: strict (the default) refuses to start; warn logs one loud error line and starts anyway. Mock embeddings are used only with MANDREL_EMBEDDINGS_ALLOW_MOCK. |
| `MANDREL_EMBEDDINGS_ALLOW_MOCK` | boolean | `false` | Mock embeddings are allowed only on an explicit opt-in: MANDREL_EMBEDDINGS_ALLOW_MOCK=true, or running under the test runner (vitest / node env=test). |
| `MANDREL_GEMMA_COLUMN` | string | `embedding_gemma` | Gemma embedder (MANDREL_EMBEDDER=gemma): database column that stores its vectors. |
| `MANDREL_GEMMA_DOC_PREFIX` | string | `title: none \| text: ` | Gemma embedder (MANDREL_EMBEDDER=gemma): text prepended to every document before it is embedded. |
| `MANDREL_GEMMA_INDEX_LISTS` | integer | `100` | Gemma embedder (MANDREL_EMBEDDER=gemma): number of lists in the vector search index (pgvector ivfflat). Changing it only matters when the index is rebuilt. |
| `MANDREL_GEMMA_INDEX_PROBES` | integer | `20` | Gemma embedder (MANDREL_EMBEDDER=gemma): how many index lists are searched per query. Higher improves recall at the cost of speed. |
| `MANDREL_GEMMA_MODEL_ID` | string | `embeddinggemma` | Gemma embedder (MANDREL_EMBEDDER=gemma): model name requested from Ollama. |
| `MANDREL_GEMMA_QUERY_PREFIX` | string | `task: search result \| query: ` | Gemma embedder (MANDREL_EMBEDDER=gemma): text prepended to every search query before it is embedded. |
| `MANDREL_GEMMA_SIM_FLOOR` | number | `0.35` | Minimum cosine similarity for a gemma-embedded result to count as a match at all. |
| `MANDREL_GEMMA_SIM_STRONG` | number | `0.55` | Cosine similarity at or above which a gemma-embedded result counts as a strong match. |
| `MANDREL_MINILM_COLUMN` | string | `embedding` | MiniLM embedder (MANDREL_EMBEDDER=minilm): database column that stores its vectors. |
| `MANDREL_MINILM_INDEX_LISTS` | integer | `100` | MiniLM embedder (MANDREL_EMBEDDER=minilm): number of lists in the vector search index (pgvector ivfflat). Changing it only matters when the index is rebuilt. |
| `MANDREL_MINILM_INDEX_PROBES` | integer | `10` | MiniLM embedder (MANDREL_EMBEDDER=minilm): how many index lists are searched per query. Higher improves recall at the cost of speed. |
| `MANDREL_MINILM_MODEL_ID` | string | `Xenova/all-MiniLM-L6-v2` | MiniLM embedder (MANDREL_EMBEDDER=minilm): model id loaded locally by Transformers.js. |
| `MANDREL_MINILM_SIM_FLOOR` | number | `0.1` | Minimum cosine similarity for a minilm-embedded result to count as a match at all. |
| `MANDREL_MINILM_SIM_STRONG` | number | `0.5` | Cosine similarity at or above which a minilm-embedded result counts as a strong match. |
| `MANDREL_OLLAMA_ENDPOINT` | string | `http://127.0.0.1:11434` | Address of the Ollama server used by the gemma embedder. |
| `MANDREL_REEMBED_WORKER_BATCH_SIZE` | integer | `100` | Records re-embedded per run of the background re-embedding worker. |
| `MANDREL_REEMBED_WORKER_ENABLED` | boolean | `true` | Run the background worker that re-embeds records whose embedding failed or is missing. |
| `MANDREL_REEMBED_WORKER_INTERVAL_MINUTES` | integer | `15` | Minutes between runs of the background re-embedding worker. |
| `MANDREL_XENOVA_ALLOW_REMOTE` | boolean | `false` | Allow the local minilm embedder to download its model from the network at run time. Off by default; the model is expected to be in the local cache. |
| `MANDREL_XENOVA_CACHE_DIR` | string | (empty) | Directory holding the local minilm model files. Empty uses the library default. |

### Threads, links & graph

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED` | boolean | `false` | When a connection has no active-thread anchor of its own, fall back to the most recent anchor in the same project. Off by default because the crude project match can hand one session another session's anchor. |
| `MANDREL_ANCHOR_SIM_FLOOR` | number | `0.6` | Minimum embedding similarity between a new record and its active-thread anchor. Below this the anchor is rejected for creating a trust-bearing link, and the write falls through to similarity inference instead. |
| `MANDREL_ANCHOR_STRICT_SESSION_KEYING` | boolean | `false` | Refuse a shared anchor key instead of silently using it. |
| `MANDREL_ANCHOR_THIN_MARGIN` | number | `0.05` | How far above the anchor similarity floor a match must land before it stops being reported as a thin (barely-passing) match. |
| `MANDREL_ANCHOR_TTL_MS` | integer | `86400000` | How long a saved active-thread anchor stays valid, in milliseconds. After that it is treated as no anchor at all. Must be greater than zero. |
| `MANDREL_ARTIFACT_REF_ALLOWED_PROVIDERS` | list | `amp-thread-file, git-remote, https, local-path` | Retrieval providers an artifact reference may name. A reference naming any other provider is rejected when the record is written. |
| `MANDREL_ARTIFACT_REF_ALLOWED_TYPES` | list | `git-bundle, git-commit, tarball, file` | Artifact types a reference may declare. A reference with any other type is rejected when the record is written. |
| `MANDREL_ARTIFACT_REF_HASH_ALGORITHM` | string | `sha256` | Hash algorithm used for artifact content hashes. |
| `MANDREL_ARTIFACT_REF_HASH_HEX_LENGTH` | integer | `64` | Expected length, in hex characters, of an artifact hash. |
| `MANDREL_ARTIFACT_REF_MAX_FIELD_LENGTH` | integer | `512` | Longest free-form text field (repository, path, URI or producer thread) in an artifact reference. |
| `MANDREL_ARTIFACT_REF_MAX_PER_RECORD` | integer | `16` | Most artifact references one record may carry. |
| `MANDREL_ARTIFACT_REF_MAX_REV_HEX` | integer | `64` | Longest accepted git revision, in hex characters. |
| `MANDREL_ARTIFACT_REF_METADATA_KEY` | string | `artifacts` | Metadata key under which artifact references are stored on a record. |
| `MANDREL_ARTIFACT_REF_MIN_REV_HEX` | integer | `7` | Shortest accepted git revision, in hex characters. |
| `MANDREL_ARTIFACT_REF_PATH_PATTERN` | string | `[A-Za-z0-9._~:@=+/-]+` | Regular expression for the characters allowed in a retrieval path. |
| `MANDREL_ARTIFACT_REF_PRODUCER_PATTERN` | string | `[A-Za-z0-9._~:@=+/-]+` | Regular expression for the characters allowed in a producer thread id or branch name. |
| `MANDREL_ARTIFACT_REF_REPOSITORY_PATTERN` | string | `[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*` | Regular expression for the characters allowed in a repository slug (org/repo). |
| `MANDREL_ARTIFACT_REF_URI_SCHEMES` | list | `https, ssh, git` | URL schemes an artifact reference's retrieval URI may use. Schemes such as file: and javascript: are refused even though they parse as URLs. |
| `MANDREL_AUTO_THREAD_ENABLED` | boolean | `true` | Master switch for automatic active-thread linking. When off, a set active thread creates no links on context_store; the explicit tools are unaffected. |
| `MANDREL_BRANCH_HISTORY_LIMIT` | integer | `200` | Members returned by one branch_history call when the caller gives no limit. |
| `MANDREL_BRANCH_HISTORY_MAX_LIMIT` | integer | `1000` | Largest limit branch_history honours. Larger requests are clamped and the response says so. |
| `MANDREL_BRANCH_HISTORY_TAGONLY_IDS` | integer | `50` | Ids of tag-only records (with no position on the branch) returned alongside their count. |
| `MANDREL_GRAPH_BACKFILL_ENABLED` | boolean | `true` | Run the scheduled job that links orphaned records and repairs earlier guessed links. When off the job exits without doing anything. |
| `MANDREL_GRAPH_BACKFILL_MAX_ORPHANS` | integer | `2000` | Most orphaned records linked in one scheduled run. |
| `MANDREL_GRAPH_BACKFILL_MAX_REPAIRS` | integer | `2000` | Most existing guessed links examined in one scheduled run. 0 means no cap. |
| `MANDREL_GRAPH_BACKFILL_REPAIR_ENABLED` | boolean | `true` | Also re-label and re-point earlier guessed links during the scheduled job. |
| `MANDREL_GRAPH_BACKFILL_REPAIR_MARGIN` | number | `0.15` | How much more similar (cosine) a replacement neighbour must be before a below-floor guessed link is re-pointed. |
| `MANDREL_GRAPH_BACKFILL_REPAIR_MIN_SIM` | number | `0.6` | A previously guessed link whose current similarity to its target is below this becomes a candidate for re-pointing. Must be between 0 and 1. |
| `MANDREL_GRAPH_BACKFILL_THRESHOLD` | number | `0.6` | Minimum cosine similarity for the scheduled job to link an orphan to its nearest neighbour. |
| `MANDREL_INFERENCE_CANDIDATE_LIMIT` | integer | `1` | How many nearest neighbours write-time linking considers per stored record. Must be at least 1. |
| `MANDREL_INFERENCE_THRESHOLD` | number | `0.6` | Minimum cosine similarity to the nearest neighbour for a write with no explicit links and no valid anchor to get a weak related_to link, so it is not left orphaned. Must be between 0 and 1. |
| `MANDREL_LIMBS_BACKFILL_BATCH` | integer | `500` | Rows updated per statement when backfilling declared limbs. |
| `MANDREL_LIMBS_WRITE_TIME_ENABLED` | boolean | `true` | Derive declared limbs on every context, decision and task write. |
| `MANDREL_MEMBERSHIP_MOVE_MAX_REASON` | integer | `1000` | Longest reason text, in bytes, stored with a branch-membership move. Longer text is truncated. |
| `MANDREL_MEMBERSHIP_MOVE_READ_LIMIT` | integer | `200` | Most membership moves returned when reading a record's move history. |
| `MANDREL_RELIABLE_THREADING_ENABLED` | boolean | `true` | Master switch for the layer that checks anchor similarity and links unanchored writes by similarity. Off reverts writes to explicit links and a set anchor only. |
| `MANDREL_TASK_EDGE_MINT_ENABLED` | boolean | `true` | Create links from tasks to the records named by their tags and dependencies. |
| `MANDREL_THREAD_DEFAULT_DEPTH` | integer | `2` | Hops from the anchor walked when the caller gives no depth. |
| `MANDREL_THREAD_FRONTIER_DEFAULT_PRIORITY` | integer | `50` | Priority given to link types missing from the priority map. Neutral: above weak links, below structural ones. |
| `MANDREL_THREAD_MAX_DEPTH` | integer | `6` | Largest depth a thread walk honours. Deeper requests are clamped down. |
| `MANDREL_THREAD_MAX_NODES` | integer | `150` | Most records collected in one thread. When more are reachable the response says it was truncated. |
| `MANDREL_THREAD_MAX_NODES_CEILING` | integer | `500` | Largest per-call node limit honoured. Larger requests are clamped down. |
| `MANDREL_THREAD_SUMMARY_CLIP_AFFORDANCE` | string | (built-in text) | Suffix appended to a snippet clipped at summary detail. {omitted} is replaced by the number of characters dropped. |
| `MANDREL_THREAD_SUMMARY_SNIPPET_MAXLEN` | integer | `280` | Characters of each node's content returned at summary detail. |
| `MANDREL_THREAD_TERMINALITY_NOT_DERIVED_TERMINAL` | boolean | `false` | Whether a record whose limbs were never derived counts as the end of a thread walk. Off means the walk keeps going through such records. |
| `MANDREL_THREAD_TERMINALITY_UNASSIGNABLE_TERMINAL` | boolean | `true` | Whether a record that was analysed and names nothing ends a thread walk. On by default. |

### Tasks

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MANDREL_TASK_CLAIM_ALLOWED_STATUSES` | list | `todo` | Task statuses from which a task can be claimed by default. Comma-separated. |
| `MANDREL_TASK_CLAIM_CLAIMABLE_STATUSES` | list | `todo, in_progress, blocked` | Task statuses in which a claim is allowed at all. Comma-separated. |
| `MANDREL_TASK_CLAIM_CLEARING_STATUSES` | list | `completed, cancelled` | Task statuses that release any claim on the task. Comma-separated. |
| `MANDREL_TASK_CLAIM_DEFAULT_LEASE_SECONDS` | integer | `2700` | How long a task claim lasts, in seconds, when the claimer names no duration. |
| `MANDREL_TASK_CLAIM_ENABLED` | boolean | `false` | Turn on task claiming, which lets a worker take a lease on a task so two workers do not pick the same one. |
| `MANDREL_TASK_CLAIM_EVENT_RETENTION_DAYS` | integer | `90` | Days the claim history is kept. |
| `MANDREL_TASK_CLAIM_MAX_LEASE_SECONDS` | integer | `86400` | Longest lease, in seconds, a claimer may request. |
| `MANDREL_TASK_CLAIM_MIN_LEASE_SECONDS` | integer | `60` | Shortest lease, in seconds, a claimer may request. |
| `MANDREL_TASK_CLAIM_REENTRY_STATUSES` | list | `in_progress` | Task statuses in which the current claimant can claim again. Comma-separated. |
| `MANDREL_TASK_CLOSED_AT_PROBE_TTL_MS` | integer | `60000` | How long, in milliseconds, the result of checking for the tasks closed_at column is reused. 0 checks on every call. |
