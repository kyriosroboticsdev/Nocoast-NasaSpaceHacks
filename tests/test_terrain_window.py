"""The tiled explorer and the Navigator retain their distinct wire sizes."""
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
import tifffile

from backend import terrain_window as windows


def test_edge_validation_uses_the_requested_tile_size():
    windows.validate(39871, 39871, 1, 129)
    with pytest.raises(windows.InvalidWindow):
        windows.validate(39871, 39871, 1, 257)
    with pytest.raises(windows.InvalidWindow):
        windows.validate(0, 0, 1, 130)


@pytest.mark.parametrize("size", [129, 257])
def test_window_size_and_source_are_forwarded_and_cached_separately(tmp_path, monkeypatch, size):
    monkeypatch.setattr(windows, "WINDOW_CACHE", tmp_path)
    monkeypatch.setattr(windows.azure_cache, "download_if_cached", lambda *_: False)
    monkeypatch.setattr(windows.azure_cache, "upload", lambda *_: None)
    seen = []

    def read(column, row, stride, requested_size, source):
        seen.append((column, row, stride, requested_size, source))
        return b"\0" * (requested_size * requested_size * 4)

    monkeypatch.setattr(windows, "_read", read)
    result, _ = windows.window_bytes(0, 0, 1, size, "stream")
    assert len(result) == size * size * 4
    assert seen == [(0, 0, 1, size, "stream")]
    assert windows.window_bytes(0, 0, 1, size, "stream")[1] == "local-cache"


def test_invalid_source_is_rejected_before_any_network_access():
    with pytest.raises(windows.InvalidWindow):
        windows.window_bytes(0, 0, 1, 129, "other")


@pytest.mark.parametrize("size,stride", [(129, 1), (129, 2), (257, 1), (257, 2)])
def test_real_tiff_decoder_returns_requested_shape_and_samples(tmp_path, monkeypatch, size, stride):
    values = np.arange(768 * 768, dtype=np.float32).reshape(768, 768)
    path = tmp_path / 'terrain.tif'
    tifffile.imwrite(path, values, tile=(128, 128))
    monkeypatch.setattr(windows, 'MOSAIC_PX', 768)
    with open(path, 'rb') as fh, tifffile.TiffFile(fh) as tiff:
        monkeypatch.setattr(windows, '_page', lambda source: (tiff.pages[0], fh, None))
        result = windows._read(0, 0, stride, size, 'local')
    assert len(result) == size * size * 4
    actual = np.frombuffer(result, dtype='<f4').reshape(size, size)
    expected = values[:(size - 1) * stride + 1:stride, :(size - 1) * stride + 1:stride]
    np.testing.assert_array_equal(actual, expected)


def test_concurrent_requests_for_one_tile_do_not_race_on_the_cache_file(tmp_path, monkeypatch):
    monkeypatch.setattr(windows, 'WINDOW_CACHE', tmp_path)
    monkeypatch.setattr(windows.azure_cache, 'download_if_cached', lambda *_: False)
    monkeypatch.setattr(windows.azure_cache, 'upload', lambda *_: None)
    expected = b'\0' * (129 * 129 * 4)
    monkeypatch.setattr(windows, '_read', lambda *_: expected)
    barrier = threading.Barrier(2)
    write = Path.write_bytes

    def simultaneous_write(path, data):
        result = write(path, data)
        barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(Path, 'write_bytes', simultaneous_write)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: windows.window_bytes(0, 0, 1, 129, 'stream'), range(2)))
    assert all(data == expected for data, _ in results)
    assert (tmp_path / '0-0-1-129.bin').read_bytes() == expected
    assert not list(tmp_path.glob('*.part'))
