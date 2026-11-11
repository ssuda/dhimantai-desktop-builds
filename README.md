# dhimantAI desktop builds

Private build inputs exported from commit `2126cc0ef995a243b33370bc2e75d0eebbd8a777`.

The source of truth is the Bitbucket repository. Only desktop inputs are mirrored here; shared reader assets and packaged course data are included, but backend and Flutter app code and repository history are excluded. Run the Custom desktop preview workflow with the staging environment. Configure FLUTTER_STAGING_ENV_JSON as an Actions secret containing only LIVEKIT_TOKEN_URL and LIVEKIT_TOKEN_SECRET. macOS builds default to Developer ID signing and notarization; configure the Apple Actions secrets listed in [the desktop guide](dhimant-skilling/desktop/README.md#macos-developer-id-signing-and-notarization). An unnotarized internal preview requires explicitly selecting macos_signing=ad-hoc.

Installers and their SHA-256 build receipts are retained as private workflow artifacts. Publishing them to dhimant.ai is a separate release step.
