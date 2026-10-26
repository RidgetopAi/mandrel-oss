# Vendored English word list (`english-words.txt`)

The discriminator behind `isEnglishWord()` (services/englishWords.ts, an earlier task
/ SEARCH P2a). It separates **"you asked about a thing we do not have"**
(Kubernetes, Terraform, PagerDuty, gibberish — not English words) from **"you phrased it
your own way"** (encyclopedia, unsound, anybody — ordinary English that simply is not in
this corpus). Absent-AND-not-a-word is a far safer veto than absent alone.

## Why it is VENDORED and not an apt dependency

The lists ship in Debian/Ubuntu as `wamerican` / `wbritish` at `/usr/share/dict/`. Relying
on those at RUNTIME would mean the veto silently changes behaviour depending on which
packages happen to be installed on a box — and the tenant containers (`node:22-slim`) have
neither. A file in the repo is the same bytes on every plane, every tenant, forever.

## Provenance — reproduce these exact bytes

Source: SCOWL (Spell Checker Oriented Word Lists), via Ubuntu `wamerican` **and**
`wbritish`, both version `2020.12.07-4build1`.

BOTH lists are required, not one. Measured on the P1 question sets: including British
spellings is what stopped `favourite` being read as "not an English word" — the single
real answer that absent-AND-not-a-word lost.

```bash
# american-english comes from the installed wamerican package
apt-get download wbritish                      # 2020.12.07-4build1
dpkg-deb -x wbritish_2020.12.07-4build1_all.deb wb
cat /usr/share/dict/american-english wb/usr/share/dict/british-english \
  | tr 'A-Z' 'a-z' | LC_ALL=C sort -u > english-words.txt
```

Result, as committed:

```
$ wc -l english-words.txt
104305
$ md5sum english-words.txt
363874f12ee5931f628274a672866ef1  english-words.txt
```

(104,334 + 103,494 input lines collapse to 104,305 because the two lists overlap almost
entirely and case folding merges pairs like `Polish`/`polish`.)

## Format

One word per line, already lowercased and `LC_ALL=C` sorted. Possessive forms
(`aardvark's`) are present as they are in the source — kept rather than stripped so the
file is byte-reproducible from the recipe above. The loader lowercases and trims each line
and ignores blank lines; it does no other normalisation.

## Licence

SCOWL is Copyright 2000-2011 Kevin Atkinson, redistributable with its notice. The full
notice as shipped by Debian is in `LICENSE-SCOWL.txt` in this directory.
