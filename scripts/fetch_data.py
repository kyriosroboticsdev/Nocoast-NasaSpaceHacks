"""Download LOLA DEMs, PGDA 5 m site tiles and SPICE kernels into data/ (skips files already present)."""
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import azure_cache
from backend.config import DATA, KERNELS, LDEMS, PGDA_TILES


def fetch(name: str, url: str, expected_bytes: int | None = None) -> None:
    dest = DATA / name
    if dest.exists() and (expected_bytes is None or dest.stat().st_size == expected_bytes):
        print(f"ok      {name}")
        return
    if azure_cache.download_if_cached(name, dest):
        print(f"cache   {name} <- azure blob")
        return
    print(f"fetch   {name} <- {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    azure_cache.upload(name, dest)


def main() -> None:
    DATA.mkdir(exist_ok=True)
    for name, url in KERNELS.items():
        fetch(name, url)
    for name, (url, n, *_rest) in LDEMS.items():
        fetch(name, url, n * n * 2)
    for url in PGDA_TILES.values():
        fetch(url.rsplit("/", 1)[1], url)


if __name__ == "__main__":
    main()
