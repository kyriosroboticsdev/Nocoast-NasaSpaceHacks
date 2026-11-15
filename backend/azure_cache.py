"""Optional Azure Blob cache for the ~240MB of NASA LOLA DEMs / PGDA tiles / SPICE kernels that
scripts/fetch_data.py otherwise re-downloads from PDS/NAIF/JPL on every fresh machine or container
cold start.

Inactive unless AZURE_STORAGE_ACCOUNT_URL (or AZURE_STORAGE_CONNECTION_STRING, for local testing) is
set — every function here is a safe no-op otherwise, so this never affects the plain-local / offline-demo
path. Auth against AZURE_STORAGE_ACCOUNT_URL uses DefaultAzureCredential, which picks up the Container
App's system-assigned managed identity in Azure and `az login` locally — no secret is stored anywhere.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

CONTAINER = "science-data"


def enabled() -> bool:
    return bool(os.environ.get("AZURE_STORAGE_ACCOUNT_URL") or os.environ.get("AZURE_STORAGE_CONNECTION_STRING"))


@lru_cache(maxsize=1)
def _container_client():
    from azure.storage.blob import ContainerClient

    conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if conn_str:
        return ContainerClient.from_connection_string(conn_str, container_name=CONTAINER)

    from azure.identity import DefaultAzureCredential

    account_url = os.environ["AZURE_STORAGE_ACCOUNT_URL"]
    return ContainerClient(account_url, container_name=CONTAINER, credential=DefaultAzureCredential())


def download_if_cached(name: str, dest: Path) -> bool:
    """Best-effort: True and dest written if `name` exists in the blob cache, else False."""
    if not enabled():
        return False
    try:
        client = _container_client()
        blob = client.get_blob_client(name)
        if not blob.exists():
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as f:
            client.download_blob(name).readinto(f)
        tmp.replace(dest)
        return True
    except Exception:
        logger.warning("Azure blob cache read failed for %s; falling back to direct download", name, exc_info=True)
        return False


def upload(name: str, src: Path) -> None:
    """Best-effort: populate the blob cache after a fresh NASA/JPL download. Never raises."""
    if not enabled():
        return
    try:
        client = _container_client()
        with open(src, "rb") as f:
            client.upload_blob(name, f, overwrite=True)
    except Exception:
        logger.warning("Azure blob cache write failed for %s; continuing without caching it", name, exc_info=True)
