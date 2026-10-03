// Reference implementation only. The application uses file-tools.py through
// the fixed system interpreter; it does not launch or fall back to this binary.
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// Deliberately a tiny file API, not a shell or an operating-system sandbox.
// All requests arrive on stdin. No argv commands, paths chosen by the model,
// network operations, overwrites, recursive traversal, or deletion operations.
private let maxBytes = 128 * 1024
private let maxInputBytes = 1024 * 1024
private let allowedExtensions = [".txt", ".md", ".csv", ".json"]
private let allowedNameCharacters = CharacterSet.letters.union(.nonBaseCharacters)
    .union(.decimalDigits).union(CharacterSet(charactersIn: " _-."))

private struct ToolFailure: Error {
    let code: String
    let message: String
}

private func fail(_ code: String, _ message: String) -> ToolFailure {
    ToolFailure(code: code, message: message)
}

private func systemFailure(_ fallback: String = "FILE_IO_FAILED") -> ToolFailure {
    switch errno {
    case EEXIST: return fail("FILE_EXISTS", "同名文件已存在，不能覆盖。")
    case ENOENT: return fail("FILE_NOT_FOUND", "文件或任务目录不存在。")
    case ELOOP: return fail("UNSAFE_FILE", "符号链接不允许访问。")
    case EACCES, EPERM: return fail("FILE_ACCESS_DENIED", "没有访问任务文件的权限。")
    default: return fail(fallback, "文件操作未完成。")
    }
}

private func keys(_ object: [String: Any], allowed: Set<String>) throws {
    guard Set(object.keys).isSubset(of: allowed) else {
        throw fail("INVALID_ARGUMENTS", "请求包含不支持的字段。")
    }
}

private func validateName(_ value: Any?) throws -> String {
    guard let name = value as? String,
          !name.isEmpty, name.utf8.count <= 180,
          !name.hasPrefix("."), !name.contains(".."),
          name == name.trimmingCharacters(in: .whitespacesAndNewlines),
          name.unicodeScalars.allSatisfy({ allowedNameCharacters.contains($0) }),
          allowedExtensions.contains(where: { name.hasSuffix($0) }) else {
        throw fail("INVALID_FILENAME", "仅支持顶层的 .txt、.md、.csv、.json 文件名，不能含路径、隐藏名或特殊字符。")
    }
    return name
}

private func identity(_ metadata: stat) -> [String: String] {
    ["dev": String(metadata.st_dev), "ino": String(metadata.st_ino)]
}

private func rootMetadata(_ fd: Int32) throws -> stat {
    var metadata = stat()
    guard fstat(fd, &metadata) == 0 else { throw systemFailure() }
    guard metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
        throw fail("UNSAFE_WORKSPACE", "任务目录必须是普通目录。")
    }
    return metadata
}

private func validateRegular(_ metadata: stat) throws {
    guard metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), metadata.st_nlink == 1 else {
        throw fail("UNSAFE_FILE", "仅支持普通单链接文件；符号链接、硬链接、目录和设备均被拒绝。")
    }
    guard metadata.st_size >= 0, metadata.st_size <= maxBytes else {
        throw fail("FILE_TOO_LARGE", "文件不能超过 128 KiB。")
    }
}

private func sameFile(_ a: stat, _ b: stat) -> Bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}

private func sameContentMetadata(_ a: stat, _ b: stat) -> Bool {
    #if canImport(Darwin)
    return a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec
        && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
        && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    #else
    return a.st_size == b.st_size && a.st_mtim.tv_sec == b.st_mtim.tv_sec
        && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec
        && a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec
    #endif
}

private func inspectEntry(_ rootFD: Int32, _ name: String) throws -> stat {
    var metadata = stat()
    guard fstatat(rootFD, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else { throw systemFailure() }
    try validateRegular(metadata)
    return metadata
}

private func readText(_ rootFD: Int32, _ name: String) throws -> [String: Any] {
    let before = try inspectEntry(rootFD, name)
    let fd = openat(rootFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw systemFailure() }
    defer { _ = close(fd) }
    var opened = stat()
    guard fstat(fd, &opened) == 0 else { throw systemFailure() }
    try validateRegular(opened)
    guard sameFile(before, opened) else { throw fail("FILE_CHANGED", "读取前文件发生变化，请重新审批。") }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = read(fd, &buffer, buffer.count)
        if count == -1 && errno == EINTR { continue }
        guard count >= 0 else { throw systemFailure() }
        if count == 0 { break }
        data.append(contentsOf: buffer.prefix(count))
        guard data.count <= maxBytes else { throw fail("FILE_TOO_LARGE", "文件不能超过 128 KiB。") }
    }
    var after = stat()
    guard fstat(fd, &after) == 0 else { throw systemFailure() }
    try validateRegular(after)
    guard sameFile(opened, after), sameContentMetadata(opened, after), after.st_size == data.count else {
        throw fail("FILE_CHANGED", "读取期间文件发生变化，请重新审批。")
    }
    guard let text = String(data: data, encoding: .utf8) else {
        throw fail("INVALID_UTF8", "只支持有效的 UTF-8 文本文件。")
    }
    return ["name": name, "content": text, "sizeBytes": data.count]
}

private func listFiles(_ rootFD: Int32) throws -> [String: Any] {
    let directoryFD = dup(rootFD)
    guard directoryFD >= 0 else { throw systemFailure() }
    guard let directory = fdopendir(directoryFD) else { _ = close(directoryFD); throw systemFailure() }
    defer { _ = closedir(directory) }
    var files = [[String: Any]]()
    var skipped = 0
    var scanned = 0
    while true {
        errno = 0
        guard let entry = readdir(directory) else {
            if errno != 0 { throw systemFailure() }
            break
        }
        scanned += 1
        guard scanned <= 4096 else { throw fail("TOO_MANY_FILES", "任务目录条目过多，请减少至 4094 个以内。") }
        let name: String? = withUnsafePointer(to: entry.pointee.d_name) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) {
                String(validatingUTF8: $0)
            }
        }
        guard let name else { skipped += 1; continue }
        if name == "." || name == ".." { continue }
        do {
            _ = try validateName(name)
            let metadata = try inspectEntry(rootFD, name)
            files.append(["name": name, "sizeBytes": metadata.st_size])
        } catch { skipped += 1 }
    }
    files.sort { ($0["name"] as! String) < ($1["name"] as! String) }
    return ["files": files, "skippedCount": skipped]
}

private func createText(_ rootFD: Int32, _ name: String, _ content: String) throws -> [String: Any] {
    let data = Data(content.utf8)
    guard data.count <= maxBytes else { throw fail("FILE_TOO_LARGE", "新建内容不能超过 128 KiB。") }
    // Construct privately in the same directory, then atomically publish with
    // RENAME_EXCL. The user-visible name never exposes partially written data.
    let stagingName = ".whisper-draft-\(UUID().uuidString).tmp"
    let fd = openat(rootFD, stagingName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard fd >= 0 else { throw systemFailure() }
    defer { _ = close(fd); _ = unlinkat(rootFD, stagingName, 0) }
    try data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let count = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if count == -1 && errno == EINTR { continue }
            guard count > 0 else { throw systemFailure() }
            offset += count
        }
    }
    guard fsync(fd) == 0 else { throw systemFailure() }
    var staged = stat()
    guard fstat(fd, &staged) == 0 else { throw systemFailure() }
    try validateRegular(staged)
    var entry = stat()
    guard fstatat(rootFD, stagingName, &entry, AT_SYMLINK_NOFOLLOW) == 0, sameFile(staged, entry) else {
        throw fail("FILE_CHANGED", "草稿暂存文件发生变化，未发布。")
    }
    #if canImport(Darwin)
    guard renameatx_np(rootFD, stagingName, rootFD, name, UInt32(RENAME_EXCL)) == 0 else { throw systemFailure() }
    #else
    // No weaker fallback: this implementation is intentionally macOS-only.
    throw fail("UNSUPPORTED_PLATFORM", "原子草稿发布当前仅支持 macOS。")
    #endif
    let published = try inspectEntry(rootFD, name)
    guard sameFile(staged, published), published.st_size == data.count else {
        throw fail("FILE_CHANGED_AFTER_CREATE", "发布后文件被其他进程替换，请核对任务目录；不会覆盖或删除现有对象。")
    }
    return ["name": name, "sizeBytes": data.count, "created": true]
}

private func processRequest(_ request: [String: Any]) throws -> [String: Any] {
    try keys(request, allowed: ["operation", "workspace", "expectedRoot", "args"])
    guard let operation = request["operation"] as? String,
          ["inspect", "list_files", "read_file", "create_file"].contains(operation),
          let workspace = request["workspace"] as? String, workspace.hasPrefix("/"),
          workspace != "/", !workspace.hasSuffix("/"), !workspace.contains("//"),
          !workspace.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
          !workspace.contains("\0"), workspace.utf8.count <= 4096,
          let args = request["args"] as? [String: Any] else {
        throw fail("INVALID_REQUEST", "文件工具请求格式无效。")
    }
    let rootFD = open(workspace, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard rootFD >= 0 else { throw systemFailure("UNSAFE_WORKSPACE") }
    defer { _ = close(rootFD) }
    let root = try rootMetadata(rootFD)
    if operation == "inspect" {
        try keys(args, allowed: [])
        guard request["expectedRoot"] == nil else { throw fail("INVALID_REQUEST", "初始化不接受目录身份覆盖。") }
        return ["rootIdentity": identity(root)]
    }
    guard let expected = request["expectedRoot"] as? [String: String], expected == identity(root) else {
        throw fail("WORKSPACE_CHANGED", "任务目录身份发生变化，操作已拒绝；需要重新初始化与审批。")
    }
    switch operation {
    case "list_files":
        try keys(args, allowed: [])
        return try listFiles(rootFD)
    case "read_file":
        try keys(args, allowed: ["name"])
        return try readText(rootFD, validateName(args["name"]))
    case "create_file":
        try keys(args, allowed: ["name", "content"])
        let name = try validateName(args["name"])
        guard let content = args["content"] as? String else { throw fail("INVALID_ARGUMENTS", "新建内容必须是文本。") }
        return try createText(rootFD, name, content)
    default: throw fail("INVALID_OPERATION", "不支持该文件操作。")
    }
}

private func main() throws {
    guard CommandLine.arguments.count == 1 else { throw fail("INVALID_REQUEST", "工具只接受标准输入 JSON，不接受命令行参数。") }
    var input = Data()
    var chunk = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = read(STDIN_FILENO, &chunk, chunk.count)
        if count == -1 && errno == EINTR { continue }
        guard count >= 0 else { throw fail("INVALID_REQUEST", "无法读取工具请求。") }
        if count == 0 { break }
        input.append(contentsOf: chunk.prefix(count))
        guard input.count <= maxInputBytes else { throw fail("REQUEST_TOO_LARGE", "工具请求超出大小限制。") }
    }
    guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
        throw fail("INVALID_REQUEST", "工具请求必须是 JSON 对象。")
    }
    let result = try processRequest(request)
    let output = try JSONSerialization.data(withJSONObject: ["ok": true, "result": result], options: [.sortedKeys, .withoutEscapingSlashes])
    FileHandle.standardOutput.write(output)
}

do {
    try main()
} catch {
    let error = error as? ToolFailure ?? fail("INVALID_REQUEST", "文件工具请求无效或操作未完成。")
    let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": ["code": error.code, "message": error.message]], options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
    exit(1)
}
