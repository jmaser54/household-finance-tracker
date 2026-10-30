# Synthetic PDFs with real-world file structures

Made by `scripts/generate-structure-fixtures.sh` from the synthetic
`savings-2026-03.pdf`. The *contents* are invented; only the PDF file
structure varies (owner-password encryption with AES-256, AES-128 and RC4,
object streams, linearization, and one that needs a user password). They test
that structures common in real bank statements are read correctly, without
using any real statement.
