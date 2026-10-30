#!/usr/bin/env bash
# Re-creates the SYNTHETIC "real-world structure" fixtures in
# tests/fixtures/synthetic/structure/ from a synthetic statement, using qpdf
# (a standard PDF tool; development only, never shipped). Bank PDFs are
# commonly encrypted with an owner password (no password needed to open),
# use object streams, or are linearized. AES encryption uses random keys, so
# these files are not byte-for-byte reproducible; they are committed as made.
set -euo pipefail
SRC=tests/fixtures/synthetic/savings-2026-03.pdf
OUT=tests/fixtures/synthetic/structure
OWNER=synthetic-owner-password
command -v qpdf >/dev/null || { echo "qpdf is required (development only)" >&2; exit 1; }
qpdf --encrypt --user-password= --owner-password="$OWNER" --bits=256 --print=none --modify=none -- "$SRC" "$OUT/aes256-owner-password.pdf"
qpdf --encrypt --user-password= --owner-password="$OWNER" --bits=128 --use-aes=y -- "$SRC" "$OUT/aes128-owner-password.pdf"
qpdf --allow-weak-crypto --encrypt --user-password= --owner-password="$OWNER" --bits=128 --use-aes=n -- "$SRC" "$OUT/rc4-128-owner-password.pdf"
qpdf --object-streams=generate "$SRC" "$OUT/object-streams.pdf"
qpdf --linearize "$SRC" "$OUT/linearized.pdf"
qpdf --linearize --object-streams=generate --encrypt --user-password= --owner-password="$OWNER" --bits=256 -- "$SRC" "$OUT/linearized-object-streams-aes256.pdf"
qpdf --encrypt --user-password=synthetic-user-password --owner-password="$OWNER" --bits=256 -- "$SRC" "$OUT/requires-user-password.pdf"
echo "Wrote $(ls "$OUT"/*.pdf | wc -l) structure fixtures to $OUT"
