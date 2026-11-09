# dhimantAI desktop builds

Private build inputs exported from commit `f3347309d24f2f33310a4191ab2fd28514cee755`.

The source of truth is the Bitbucket repository. Only desktop inputs are mirrored here; shared reader assets and packaged course data are included, but backend and Flutter app code and repository history are excluded. Run the Custom desktop preview workflow with the staging environment. Configure FLUTTER_STAGING_ENV_JSON as an Actions secret containing only LIVEKIT_TOKEN_URL and LIVEKIT_TOKEN_SECRET.

Installers and their SHA-256 build receipts are retained as private workflow artifacts. Publishing them to dhimant.ai is a separate release step.
