# dhimantAI desktop preview

A separate Code OSS/VSCodium distribution using stock Electron for YouTube playback and consent-based microphone/camera access. It installs beside Microsoft VS Code, with its own application ID and user-data directory. The agent, backend and Flutter app are unchanged.

New empty windows welcome the learner with Course Catalog. The Learning sidebar starts with Courses, Instructor, Study, Doubt Solver and Practice, with Course Files below. Existing editor tabs take precedence on restore. Practice expands the existing exercise browser; the terminal remains in its existing runtime workflow.

Outline and Timeline are hidden by default. They remain available from the Views menu for learners who want them.

The Activity Bar is hidden by default; the Learning sidebar is the primary navigation. Search, source control, debugging, extensions and settings remain accessible through menus, keyboard shortcuts and the Command Palette. Users can restore the Activity Bar through the layout settings.

Copilot is optional and disabled by default. The custom desktop permits it only for courses explicitly teaching AI-assisted coding; the current reviewed course is **Use AI Coding Help with Verification**. `src/courseCopilot.ts` in the learning extension holds the exact course allowlist. Instructor, Study, Practice and registered course files follow the active editor's course. Unknown courses and the catalog disable it. The switch uses in-memory configuration in the current window; it never rewrites user or workspace settings or enables another open window. A Practice exercise that disallows assistance remains disabled.

Provider/authentication/API configuration is retained for an optional compatible Copilot Chat installation. The pinned VSCodium preview does not bundle that extension; installing and signing into Copilot is separate, and live Copilot responses have not been validated here. No automatic extension download, sign-in, or model request is introduced. Stock VS Code receives the disabled default but no forced course override.

Light Modern is the whole editor's default theme. Learning panels inherit the editor theme; there is no separate extension appearance setting or palette. Users can still select a different editor theme.

`lock.json` pins VSCodium, Code OSS, Electron and Node. `customize.py` applies narrow source changes and fails when upstream context changes. `build.py` produces a macOS DMG, Windows user setup EXE, or Linux tarball and Debian package on native x64/ARM64 runners. The manual GitHub workflow defines all six targets; it neither publishes releases nor updates a running service.

## Build

Use Node 24.18.0, Python 3.11+, Pillow, Git, Bash, jq and the native Code OSS build tools (Xcode command line tools on macOS; Visual Studio C++ build tools on Windows; the Linux packages listed in the workflow). Allow at least 16 GB RAM and 30 GB disk space.

Package the extension from `vscode/dhimantai-learning` using `npm ci`, `npm run compile`, and `npm run package`. Then, from the repository root:

```sh
python3 vscode/desktop/build.py --cache /absolute/path/to/new-build-cache \
  --arch arm64 --vsix /absolute/path/to/dhimantai-learning.vsix \
  --flutter-env staging=/absolute/path/to/env.staging.json \
  --out /absolute/path/to/artifacts
```

Use `--arch x64` on an x64 host. `--stage prepare`, `build`, and `package` allow inspection between stages. Preparation refuses to overwrite an existing checkout. Build and network operations have finite deadlines. Receipts include source pins and artifact SHA-256 values.

The desktop bundle receives only the same token-service URL, app name and client HMAC credential used by Flutter. Its generated `desktop-client.json` stays out of source control and ordinary VSIX packages. Supply production and staging separately with repeated `--flutter-env` flags when both are needed. Never substitute a LiveKit API secret or Supabase service-role key. The workflow expects the existing Flutter configuration in `FLUTTER_STAGING_ENV_JSON` or `FLUTTER_PRODUCTION_ENV_JSON` repository secrets.

## GitHub staging builds

The private build repository is [ssuda/dhimantai-desktop-builds](https://github.com/ssuda/dhimantai-desktop-builds).
Bitbucket remains the source of truth. After committing build changes, export
only their required inputs into a new directory:

```sh
python3 vscode/desktop/export_build_source.py --out /absolute/path/to/new-export
```

Copy that export into the private build repository checkout, commit, and push.
It includes shared reader assets and packaged lesson data, but no backend or
Flutter app code, credentials, or monorepo history. `build-source.json` records
the originating commit and file hashes; builds verify those bytes before use.
Receipts distinguish that source commit from the GitHub build commit.

Run the manual **Custom desktop preview** workflow with `environment=staging`
and `targets=windows-linux`, `all`, or one platform/processor pair. The staging
Actions secret contains only the Flutter client's token URL and client HMAC
key. The workflow refuses a public repository and never deploys a service.
Linux runners use temporary swap; native compilation may take substantially
longer than extension compilation. Installers and receipts are retained for
14 days, build logs for 7 days. Download the artifacts before retention expires.

Publish only verified receipt/artifact pairs through
`website/upskill/scripts/desktop_releases.py`, then deploy the dhimantAI website
target as described in `website/upskill/README.md`. Never replace an already
published immutable download with different bytes under the same filename;
increment the desktop release when changing its payload.

## Existing client contract

The extension first uses its existing authenticated session endpoint for learner eligibility and profile fields. In the custom desktop, Instructor then connects through Flutter's existing `/getToken` contract, joins idle, and selects the lesson using `switch_mode`. Microphone control uses `toggle_audio`; camera capture publishes a LiveKit video track. No new RPC or agent behavior is introduced. Stock VS Code keeps its existing connection path.

Capture starts only on an explicit device action. The native host registers the extension's webview origin from the trusted workbench, checks the owning live frame, and asks for device-specific consent. YouTube/remote frames receive no media grant. The client stops tracks on hide, leave, disconnect or stale permission completion. macOS usage descriptions and capture entitlements are included.

Flutter rooms do not expose the extension-only automatic code-observation RPC. This preview disables that control and retains explicit “Ask Instructor” code sharing. Camera publication uses Flutter's existing behavior; this change does not add new visual reasoning to the agent.

## Validation and release status

Run `node --test vscode/desktop/tests/*.test.mjs` and, after extension compilation, `node --test vscode/dhimantai-learning/out/test/desktopRoom.test.js`.

The local macOS ARM64 preview builds and signs successfully. Extension compilation, device-policy/client tests, the preload CSP check, and Catalog startup/navigation checks pass. The whole-editor light theme and Catalog welcome were inspected in the running app. The full Code OSS TypeScript check still reports errors in unchanged policy tests, notebook-status tests and the issue reporter; it is not a clean upstream type-check result.

`check-vscode-video-runtime.cjs` launches the actual editor with its sandbox enabled and tests real YouTube playback, audio-byte decoding, pause/ask/resume and server pause. Authentication and Instructor transport are fixtures; it is not live-agent acceptance. `check-desktop-devices.cjs` tests capture with synthetic devices; it must never be launched against physical devices for unattended testing. Chromium's fake-device path can bypass real consent, so its passing result does not certify native/OS permission prompts. Permission policy and client cleanup have separate unit tests; physical-device consent needs interactive acceptance.

The YouTube check may need an initial Play click in the real player. Cross-origin IFrame API calls do not reliably carry browser user activation; the test leaves autoplay restrictions enabled.

The current packaging path deliberately creates previews: macOS is ad-hoc signed, Windows is unsigned, and neither has customer release signing/notarization. Native playback, capture, install/uninstall and signed-in Instructor acceptance must be recorded on each target before customer release. No Windows or Linux runtime acceptance is implied by the macOS checks.

Native test launchers use disposable profiles, in-memory secret storage and a macOS mock keychain. They contain no real sign-in credentials. The installed application retains OS-backed secure storage; ad-hoc signing can cause macOS Keychain prompts after rebuilds. Consistent Developer ID signing is required for customer updates.

## Updates

Automatic updates are disabled for this preview. Microsoft and VSCodium update feeds cannot replace the custom media runtime. Update a preview by installing the next dhimantAI package over it; application IDs and user-data paths remain stable.

For a customer channel, maintain the source pins, apply upstream security releases, rebuild and validate all target installers, sign/notarize them, then publish an owned HTTPS update feed with checksums. The existing updater plumbing is retained, but no feed or automatic release publication is configured here. Code OSS and VSCodium license/notices remain in the distribution; Open VSX remains the extension catalog.

Upstream references: [VSCodium build instructions](https://github.com/VSCodium/vscodium/blob/master/docs/howto-build.md), [Electron permission handlers](https://www.electronjs.org/docs/latest/api/session), [GitHub native runner labels](https://github.com/actions/runner-images).
