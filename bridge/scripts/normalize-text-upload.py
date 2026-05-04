#!/usr/bin/env python3
import hashlib
import json
import sys
from pathlib import Path

import chardet

CP1252_COMPATIBLE_ENCODINGS = {
    "iso-8859-1",
    "latin-1",
    "latin_1",
    "iso8859-1",
    "windows-1252",
    "cp1252",
}

UTF8_ALIASES = {"utf-8", "utf_8", "utf8"}
UTF8_BOM = b"\xef\xbb\xbf"


def normalize_detected_encoding(value):
    encoding = str(value or "").strip().lower()

    if encoding in UTF8_ALIASES:
        return "utf-8"

    # French Windows exports are often reported as ISO-8859-1 even when they
    # contain CP1252 bytes such as 0x92 for the typographic apostrophe.
    if encoding in CP1252_COMPATIBLE_ENCODINGS:
        return "cp1252"

    return encoding or "cp1252"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize-text-upload.py <path>")

    path = Path(sys.argv[1])
    raw = path.read_bytes()
    source_encoding = "utf-8"
    normalized = False

    if raw.startswith(UTF8_BOM):
        text = raw[len(UTF8_BOM):].decode("utf-8")
        normalized = True
    else:
        try:
            raw.decode("utf-8")
            encoded = raw
        except UnicodeDecodeError:
            detected = chardet.detect(raw) or {}
            source_encoding = normalize_detected_encoding(detected.get("encoding"))
            text = raw.decode(source_encoding, errors="replace")
            encoded = text.encode("utf-8")
            normalized = True
        else:
            print(json.dumps({
                "normalized": False,
                "sourceEncoding": source_encoding,
                "targetEncoding": "utf-8",
                "size": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }))
            return

    encoded = text.encode("utf-8")
    path.write_bytes(encoded)
    print(json.dumps({
        "normalized": normalized,
        "sourceEncoding": source_encoding,
        "targetEncoding": "utf-8",
        "size": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }))


if __name__ == "__main__":
    main()
