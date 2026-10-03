"""Fixed local file API for macOS; invoked with /usr/bin/python3 -I -S.

This is not an operating-system sandbox. The trusted server binds a workspace
identity and approves every action. No command, interpreter, library, arbitrary
path, overwrite, deletion, or network operation can be selected by an input.
"""

import ctypes
import errno
import json
import os
import stat
import sys
import unicodedata
import uuid

MAX_BYTES = 128 * 1024
MAX_REQUEST_BYTES = 1024 * 1024
EXTENSIONS = (".txt", ".md", ".csv", ".json")
OPERATIONS = ("inspect", "list_files", "read_file", "create_file")
# Darwin SDK sys/stdio.h: exclusive same-directory atomic publication.
RENAME_EXCL = 0x00000004


class ToolFailure(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(message)


def fail(code, message):
    return ToolFailure(code, message)


def system_failure(number):
    if number == errno.EEXIST:
        return fail("FILE_EXISTS", "同名文件已存在，不能覆盖。")
    if number == errno.ENOENT:
        return fail("FILE_NOT_FOUND", "文件或任务目录不存在。")
    if number == errno.ELOOP:
        return fail("UNSAFE_FILE", "符号链接不允许访问。")
    if number in (errno.EACCES, errno.EPERM):
        return fail("FILE_ACCESS_DENIED", "没有访问任务文件的权限。")
    return fail("FILE_IO_FAILED", "文件操作未完成。")


def check_keys(value, allowed):
    if not isinstance(value, dict) or not set(value).issubset(allowed):
        raise fail("INVALID_ARGUMENTS", "请求包含不支持的字段。")


def filename(value):
    if not isinstance(value, str):
        raise fail("INVALID_FILENAME", "文件名必须是文本。")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeError:
        raise fail("INVALID_FILENAME", "文件名必须是有效的 Unicode 文本。")
    valid_characters = all(
        character in " _-."
        or unicodedata.category(character)[0] in ("L", "M")
        or unicodedata.category(character) == "Nd"
        for character in value
    )
    if (not value or len(encoded) > 180 or value.startswith(".")
            or ".." in value or value.strip() != value
            or not valid_characters or not value.endswith(EXTENSIONS)):
        raise fail("INVALID_FILENAME", "仅支持顶层的 .txt、.md、.csv、.json 文件名，不能含路径、隐藏名或特殊字符。")
    return value


def identity(metadata):
    return {"dev": str(metadata.st_dev), "ino": str(metadata.st_ino)}


def regular(metadata):
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise fail("UNSAFE_FILE", "仅支持普通单链接文件；符号链接、硬链接、目录和设备均被拒绝。")
    if metadata.st_size < 0 or metadata.st_size > MAX_BYTES:
        raise fail("FILE_TOO_LARGE", "文件不能超过 128 KiB。")


def same_file(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino


def inspect_entry(root_fd, name):
    metadata = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    regular(metadata)
    return metadata


def read_text(root_fd, name):
    before = inspect_entry(root_fd, name)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root_fd)
    try:
        opened = os.fstat(fd)
        regular(opened)
        if not same_file(before, opened):
            raise fail("FILE_CHANGED", "读取前文件发生变化，请重新审批。")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(8192, MAX_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_BYTES:
                raise fail("FILE_TOO_LARGE", "文件不能超过 128 KiB。")
        after = os.fstat(fd)
        regular(after)
        if (not same_file(opened, after) or opened.st_size != after.st_size
                or opened.st_mtime_ns != after.st_mtime_ns
                or opened.st_ctime_ns != after.st_ctime_ns or total != after.st_size):
            raise fail("FILE_CHANGED", "读取期间文件发生变化，请重新审批。")
        try:
            content = b"".join(chunks).decode("utf-8", "strict")
        except UnicodeError:
            raise fail("INVALID_UTF8", "只支持有效的 UTF-8 文本文件。")
        return {"name": name, "content": content, "sizeBytes": total}
    finally:
        os.close(fd)


def list_files(root_fd):
    files = []
    skipped = 0
    with os.scandir(root_fd) as entries:
        for count, entry in enumerate(entries, 1):
            if count > 4094:
                raise fail("TOO_MANY_FILES", "任务目录条目过多，请减少至 4094 个以内。")
            name = entry.name
            try:
                # Reject undecodable filenames represented with surrogateescape.
                filename(name)
                metadata = inspect_entry(root_fd, name)
                files.append({"name": name, "sizeBytes": metadata.st_size})
            except (ToolFailure, OSError):
                skipped += 1
    return {"files": sorted(files, key=lambda item: item["name"]), "skippedCount": skipped}


def exclusive_publish(root_fd, source, destination):
    # Fixed system library and fixed symbol; nothing from the request selects
    # the library, function, signature, flags, or directory descriptors.
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename_exclusive = library.renameatx_np
    rename_exclusive.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename_exclusive.restype = ctypes.c_int
    ctypes.set_errno(0)
    result = rename_exclusive(root_fd, source.encode("utf-8"), root_fd,
                              destination.encode("utf-8"), RENAME_EXCL)
    if result != 0:
        raise system_failure(ctypes.get_errno())


def create_text(root_fd, name, content):
    if not isinstance(content, str):
        raise fail("INVALID_ARGUMENTS", "新建内容必须是文本。")
    try:
        data = content.encode("utf-8", "strict")
    except UnicodeError:
        raise fail("INVALID_UTF8", "新建内容必须是有效的 Unicode 文本。")
    if len(data) > MAX_BYTES:
        raise fail("FILE_TOO_LARGE", "新建内容不能超过 128 KiB。")
    stage = ".whisper-draft-" + uuid.uuid4().hex + ".tmp"
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=root_fd)
    try:
        written = 0
        while written < len(data):
            count = os.write(fd, data[written:])
            if count <= 0:
                raise fail("FILE_IO_FAILED", "草稿未写入完成。")
            written += count
        os.fsync(fd)
        staged = os.fstat(fd)
        regular(staged)
        entry = os.stat(stage, dir_fd=root_fd, follow_symlinks=False)
        if not same_file(staged, entry):
            raise fail("FILE_CHANGED", "草稿暂存文件发生变化，未发布。")
        exclusive_publish(root_fd, stage, name)
        published = inspect_entry(root_fd, name)
        if not same_file(staged, published) or published.st_size != len(data):
            raise fail("FILE_CHANGED_AFTER_CREATE", "发布后文件被其他进程替换，请核对任务目录；不会覆盖或删除现有对象。")
        return {"name": name, "sizeBytes": len(data), "created": True}
    finally:
        os.close(fd)
        try:
            os.unlink(stage, dir_fd=root_fd)
        except FileNotFoundError:
            pass


def process_request(request):
    check_keys(request, {"operation", "workspace", "expectedRoot", "args"})
    operation = request.get("operation")
    workspace = request.get("workspace")
    args = request.get("args")
    if (operation not in OPERATIONS or not isinstance(workspace, str)
            or not workspace.startswith("/") or workspace == "/"
            or workspace.endswith("/") or "//" in workspace
            or any(part in (".", "..") for part in workspace.split("/"))
            or "\0" in workspace or not isinstance(args, dict)):
        raise fail("INVALID_REQUEST", "文件工具请求格式无效。")
    try:
        encoded_workspace = workspace.encode("utf-8", "strict")
    except UnicodeError:
        raise fail("INVALID_REQUEST", "任务目录路径无效。")
    if len(encoded_workspace) > 4096:
        raise fail("INVALID_REQUEST", "任务目录路径过长。")
    try:
        root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise fail("UNSAFE_WORKSPACE", "任务目录必须是普通目录，不能是符号链接。")
        raise
    try:
        root = os.fstat(root_fd)
        if not stat.S_ISDIR(root.st_mode):
            raise fail("UNSAFE_WORKSPACE", "任务目录必须是普通目录。")
        if operation == "inspect":
            check_keys(args, set())
            if "expectedRoot" in request:
                raise fail("INVALID_REQUEST", "初始化不接受目录身份覆盖。")
            return {"rootIdentity": identity(root)}
        if request.get("expectedRoot") != identity(root):
            raise fail("WORKSPACE_CHANGED", "任务目录身份发生变化，操作已拒绝；需要重新初始化与审批。")
        if operation == "list_files":
            check_keys(args, set())
            return list_files(root_fd)
        if operation == "read_file":
            check_keys(args, {"name"})
            return read_text(root_fd, filename(args.get("name")))
        check_keys(args, {"name", "content"})
        return create_text(root_fd, filename(args.get("name")), args.get("content"))
    finally:
        os.close(root_fd)


def main():
    if len(sys.argv) != 1 or sys.platform != "darwin" or not sys.flags.isolated or not sys.flags.no_site:
        raise fail("INVALID_REQUEST", "工具必须通过固定的 macOS Python 隔离入口启动，只接受标准输入 JSON。")
    data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(data) > MAX_REQUEST_BYTES:
        raise fail("REQUEST_TOO_LARGE", "工具请求超出大小限制。")
    request = json.loads(data.decode("utf-8", "strict"))
    return process_request(request)


if __name__ == "__main__":
    try:
        envelope = {"ok": True, "result": main()}
        status = 0
    except ToolFailure as error:
        envelope = {"ok": False, "error": {"code": error.code, "message": error.message}}
        status = 1
    except OSError as error:
        safe_error = system_failure(error.errno)
        envelope = {"ok": False, "error": {"code": safe_error.code, "message": safe_error.message}}
        status = 1
    except Exception:
        envelope = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "文件工具请求无效或操作未完成。"}}
        status = 1
    sys.stdout.buffer.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "strict"))
    sys.exit(status)
