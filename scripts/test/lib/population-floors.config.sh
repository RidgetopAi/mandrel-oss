# shellcheck shell=bash
# shellcheck disable=SC2034  # values read by the guards that source this file
# population-floors.config.sh — the discovery FLOORS of the shell guards whose
# population is "every file of a kind in this tree". Sourced by
# scripts/test/pipefail-boolean-ban.test.sh and scripts/test/bind-file-mount-ban.test.sh.
#
# The guards are the same code in every repository that carries them; the size of
# the tree is not. So the floor is a per-repository VALUE, kept here and nowhere
# else. A floor is a broken-discovery detector (wrong directory, empty checkout, a
# glob that matched nothing), NOT an anti-shrink guarantee, so it sits well below
# the measured count. Each guard still lets its own env var override the value.
#
# Measured 2026-10-25 on this tree: 78 shell files, 2 compose files.
POPULATION_FLOOR_SHELL_FILES=60
POPULATION_FLOOR_COMPOSE_FILES=2
