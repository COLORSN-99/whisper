import Foundation
import Security
import Darwin

// Private, bounded JSON-over-stdio helper. Never log the request or token record.
// No Keychain operation takes place until a complete validated request is read.
let maximumBytes = 256 * 1024
let allowedService = "com.whisper.oauth"
alarm(12)

func respond(_ object: [String: Any], success: Bool) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object), data.count <= maximumBytes {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    if !success {
        FileHandle.standardError.write(Data("Application token storage request failed.\n".utf8))
    }
    exit(success ? EXIT_SUCCESS : EXIT_FAILURE)
}

func fail(_ code: String) -> Never {
    respond(["ok": false, "code": code], success: false)
}

func readRequest() -> [String: Any] {
    var input = Data()
    do {
        while let chunk = try FileHandle.standardInput.read(upToCount: min(8192, maximumBytes + 1 - input.count)), !chunk.isEmpty {
            input.append(chunk)
            if input.count > maximumBytes { fail("request_too_large") }
        }
        guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
            fail("invalid_request")
        }
        return request
    } catch {
        fail("invalid_request")
    }
}

let request = readRequest()
guard let operation = request["operation"] as? String,
      ["load", "save", "clear"].contains(operation),
      let service = request["service"] as? String,
      service == allowedService,
      let account = request["account"] as? String,
      account.range(of: "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z", options: .regularExpression) != nil,
      account.utf8.count <= 64 else {
    fail("invalid_scope")
}

// Synchronization is explicitly disabled. This helper never queries broad
// classes of credentials, Codex credentials, or another application's service.
let itemQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false,
]

switch operation {
case "load":
    var query = itemQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        respond(["ok": true, "record": NSNull()], success: true)
    }
    guard status == errSecSuccess,
          let data = result as? Data,
          data.count <= maximumBytes,
          let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        fail("keychain_read_failed")
    }
    respond(["ok": true, "record": record], success: true)

case "save":
    guard let record = request["record"] as? [String: Any],
          JSONSerialization.isValidJSONObject(record),
          let data = try? JSONSerialization.data(withJSONObject: record),
          data.count <= maximumBytes else {
        fail("invalid_record")
    }
    let attributes: [String: Any] = [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecAttrLabel as String: "Whisper authorization",
    ]
    var newItem = itemQuery
    for (key, value) in attributes { newItem[key] = value }
    let status = SecItemAdd(newItem as CFDictionary, nil)
    if status == errSecDuplicateItem {
        guard SecItemUpdate(itemQuery as CFDictionary, attributes as CFDictionary) == errSecSuccess else {
            fail("keychain_write_failed")
        }
    } else if status != errSecSuccess {
        fail("keychain_write_failed")
    }
    respond(["ok": true], success: true)

case "clear":
    let status = SecItemDelete(itemQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail("keychain_delete_failed")
    }
    respond(["ok": true], success: true)

default:
    fail("invalid_operation")
}
