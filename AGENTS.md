# Whisper

Keep all work in this independent project. Do not inspect other projects or existing Codex credentials.

- Desktop: Node.js 22+, ESM, no runtime npm dependencies. Run `npm test` and `npm run check` after desktop changes.
- Android: Java 17, Gradle 8.13, AGP 8.13.2, API 26+. Keep the phone app independent of the desktop HTTP service. Run unit tests, lint, and emulator tests before publishing an APK.
- This repository is public at the user's explicit request. Only publish reviewed source and release APKs; never commit private runtime data, screenshots of private sessions, signing keys, or local machine configuration.
- Sign in with ChatGPT is the selected OpenAI integration. Never fall back to an API key, ChatGPT private endpoints, or an existing Codex login.
- Do not start real authorization, save tokens, or call live inference while testing. Use injected fake transports and explicit demo labels.
- Bind only to loopback. Preserve Host/Origin/CSRF protection. No raw remote execution endpoints.
- Default tokens are in memory. Persistent storage and restoration require separate explicit UI consent.
- Computer actions require per-task approval; unknown approval requests fail closed. Android and remote pairing remain unimplemented until an explicit authorized scope exists.
- Android ChatGPT OAuth implements the official local-app protocol with Chrome and an ephemeral IPv4 loopback callback. Offline and emulator tests do not prove live OpenAI authorization or subscription eligibility. Never substitute an OpenAI API key. Other vendors can be configured explicitly by the user.
- Never log tokens, OAuth codes, authorization URLs, or secret-bearing command environments.
