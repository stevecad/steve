"""Modeling documents: parse code into features for the GUI and STEVE (docs/MODELING.md)."""

# A document's whole source in characters: its main code and every other file together. A backstop only: the 1 MB
# request (app/main.py BodyLimit, MAX_DOCUMENT_BYTES) is what binds a document in practice.
MAX_SOURCE = 2_000_000
