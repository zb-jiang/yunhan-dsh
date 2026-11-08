"""Windows ACL compatibility for DSH sandbox.

Python's tempfile.mkdtemp uses os.mkdir(path, 0o700), which on Windows
creates a directory with a non-inheriting DACL. Under DSH's Windows ACL
sandbox, the workspace SID grant propagates through inheritance; a child
directory with a non-inheriting DACL loses that grant, and the confined
process cannot write into its own temp directory.

mkdtemp_inherit creates a temp directory that inherits the parent's DACL
on Windows, and delegates to tempfile.mkdtemp on other platforms.
"""
from __future__ import annotations

import os
import sys
import tempfile

__all__ = ["mkdtemp_inherit"]


def mkdtemp_inherit(prefix=None, dir=None, suffix=None) -> str:
    """Create a temp directory that inherits the parent's DACL.

    On Windows, tempfile.mkdtemp uses os.mkdir(path, 0o700) which creates a
    non-inheriting DACL. This function uses os.mkdir without an explicit
    mode so the directory inherits the parent's ACL, preserving DSH sandbox
    grants.

    On non-Windows platforms, delegates to tempfile.mkdtemp.
    """
    if sys.platform != "win32":
        return tempfile.mkdtemp(prefix=prefix, dir=dir, suffix=suffix)

    target_dir = str(dir) if dir else tempfile.gettempdir()
    name_prefix = prefix or ""
    name_suffix = suffix or ""

    for _ in range(tempfile.TMP_MAX):
        name = name_prefix + os.urandom(8).hex() + name_suffix
        path = os.path.join(target_dir, name)
        try:
            os.mkdir(path)
        except FileExistsError:
            continue
        except PermissionError:
            if os.path.isdir(target_dir) and os.access(target_dir, os.W_OK):
                continue
            raise
        return os.path.abspath(path)
    raise FileExistsError("No usable temporary directory name found")
