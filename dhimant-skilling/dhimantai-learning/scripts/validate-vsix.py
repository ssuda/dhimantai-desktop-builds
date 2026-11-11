"""Validate exact release bytes from stdin before publishing; standard library only."""
import io
import json
import struct
import sys
import zipfile
from xml.etree import ElementTree


def validate(data, expected):
    if not 22 <= len(data) <= 32 * 1024 * 1024:
        raise ValueError('VSIX size is outside the supported range')
    end = data.rfind(b'PK\x05\x06', max(0, len(data) - 65557))
    if end < 0 or end + 22 > len(data):
        raise ValueError('VSIX is missing the ZIP end record')
    comment_length = struct.unpack_from('<H', data, end + 20)[0]
    if end + 22 + comment_length != len(data):
        raise ValueError('VSIX has an invalid ZIP comment length or trailing bytes')
    disk, directory_disk, disk_count, count, size, offset = struct.unpack_from('<4H2I', data, end + 4)
    if disk or directory_disk or disk_count != count or offset + size != end:
        raise ValueError('VSIX central directory is incomplete or inconsistent')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != count or len(set(names)) != count:
            raise ValueError('VSIX has duplicate or missing entries')
        if any(name.endswith('.vsix') for name in names):
            raise ValueError('VSIX must not contain another VSIX')
        if sum(item.file_size for item in archive.infolist()) > 64 * 1024 * 1024:
            raise ValueError('VSIX expanded size exceeds the supported range')
        if archive.testzip() is not None:
            raise ValueError('VSIX file checksum verification failed')
        package = json.loads(archive.read('extension/package.json'))
        for field in ('name', 'publisher', 'version'):
            if package.get(field) != expected[field]:
                raise ValueError(f'VSIX package {field} does not match the release')
        entry = 'extension/' + package['main'].removeprefix('./')
        if not archive.read(entry):
            raise ValueError('VSIX compiled extension entry point is empty')
        archive.read('[Content_Types].xml')
        manifest = ElementTree.fromstring(archive.read('extension.vsixmanifest'))
        identity = manifest.find('.//{*}Identity')
        if identity is None or any(identity.get(key) != expected[field] for key, field in
                                   [('Id', 'name'), ('Publisher', 'publisher'), ('Version', 'version')]):
            raise ValueError('VSIX manifest identity does not match the release')


if __name__ == '__main__':
    try:
        validate(sys.stdin.buffer.read(), json.loads(sys.argv[1]))
    except Exception as error:
        sys.exit(f'Invalid VSIX: {error}')
