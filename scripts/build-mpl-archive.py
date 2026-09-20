#!/usr/bin/env python3
"""Build the MPL-2.0 covered-sources archive for a release.

The archive is byte-reproducible across machines and platforms so that CI can
rebuild it and *verify* it against the SHA-256 recorded in the release notes —
that digest is what ties a shipped binary to its corresponding source
(MPL-2.0 §3.2). Reproducibility comes from three things:

  * entries are sorted by name, so directory-iteration order never leaks in;
  * every entry is stored UNCOMPRESSED (ZIP_STORED), so no zlib version or
    compression level can affect the bytes;
  * every entry carries a fixed timestamp, a fixed create_system and fixed
    permission bits, none of which may vary with the build host.

Usage:
    python3 scripts/build-mpl-archive.py <version> [--out-dir DIR]

Prints the archive path and its uppercase SHA-256, one per line.
"""

import argparse
import hashlib
import pathlib
import sys
import zipfile

# 1980-01-01 is the earliest timestamp the ZIP format can represent.
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
ARCHIVE_ROOT = "silkstack-mpl-covered-sources"
SOURCE_DIR = "mpl-covered-sources"


def build_archive(version: str, out_dir: pathlib.Path) -> pathlib.Path:
    source = pathlib.Path(SOURCE_DIR)
    if not source.is_dir():
        sys.exit(f"error: {SOURCE_DIR}/ not found — run from the repository root")

    # Sort by the archive entry NAME, not by Path object: Path comparison is
    # case-folded on Windows but raw on POSIX, which would order these entries
    # differently on the CI runner than locally.
    files = sorted(
        (path for path in source.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(source).as_posix(),
    )
    if not files:
        sys.exit(f"error: {SOURCE_DIR}/ contains no files")

    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"{ARCHIVE_ROOT}-v{version}.zip"

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as zf:
        for path in files:
            name = f"{ARCHIVE_ROOT}/{path.relative_to(source).as_posix()}"
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE_TIME)
            # create_system defaults to 0 on Windows and 3 elsewhere, which
            # alone would make the archive differ per build host.
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16  # regular file, mode 0644
            info.internal_attr = 0
            info.flag_bits = 0
            zf.writestr(info, path.read_bytes())

    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="release version without the leading 'v' (e.g. 2.4.0)")
    parser.add_argument("--out-dir", default=".", help="where to write the archive (default: .)")
    args = parser.parse_args()

    version = args.version.lstrip("v")
    archive = build_archive(version, pathlib.Path(args.out_dir))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest().upper()

    print(archive.as_posix())
    print(digest)


if __name__ == "__main__":
    main()
