# dhimantAI desktop builds

Private build inputs exported from commit `a6f8a2a0e6b7917c9d3e6b291d068611984c533d`.

The source of truth is the Bitbucket repository. Only desktop inputs are mirrored here; shared reader assets and packaged course data are included, but backend and Flutter app code and repository history are excluded. Every push to main starts the staging desktop build automatically: Windows x64 and its installer acceptance, macOS ARM64, macOS x64, then Linux x64, one job at a time. Linux ARM64 and Windows ARM64 are excluded. Configure FLUTTER_STAGING_ENV_JSON as an Actions secret containing only LIVEKIT_TOKEN_URL and LIVEKIT_TOKEN_SECRET. The staging pipeline explicitly uses ad-hoc macOS signing without notarization. For Developer ID builds, configure the Apple Actions secrets listed in [the desktop guide](dhimant-skilling/desktop/README.md#macos-developer-id-signing-and-notarization). Then change both macOS callers to macos_signing: developer-id.

Installers and their SHA-256 build receipts are retained as private workflow artifacts. Publishing them to dhimant.ai is a separate release step.
