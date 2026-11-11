# dhimantAI desktop preview

A separate Code OSS/VSCodium distribution using stock Electron for YouTube playback and consent-based microphone/camera access. It installs beside Microsoft VS Code, with its own application ID and user-data directory. The agent, backend and Flutter app are unchanged.

New empty windows welcome the learner with Course Catalog. The Learning sidebar starts with Courses, Instructor, Study, Doubt Solver and Practice, with Course Files below. Existing editor tabs take precedence on restore. Practice expands the existing exercise browser; the terminal remains in its existing runtime workflow.

Outline and Timeline are hidden by default. They remain available from the Views menu for learners who want them.

The Activity Bar is hidden by default; the Learning sidebar is the primary navigation. Search, source control, debugging, extensions and settings remain accessible through menus, keyboard shortcuts and the Command Palette. Users can restore the Activity Bar through the layout settings.

Copilot is optional and disabled by default. The custom desktop permits it only for courses explicitly teaching AI-assisted coding; the current reviewed course is **Use AI Coding Help with Verification**. `src/courseCopilot.ts` in the learning extension holds the exact course allowlist. Instructor, Study, Practice and registered course files follow the active editor's course. Unknown courses and the catalog disable it. The switch uses in-memory configuration in the current window; it never rewrites user or workspace settings or enables another open window. A Practice exercise that disallows assistance remains disabled.

Provider/authentication/API configuration is retained for an optional compatible Copilot Chat installation. The pinned VSCodium preview does not bundle that extension; installing and signing into Copilot is separate, and live Copilot responses have not been validated here. No automatic extension download, sign-in, or model request is introduced. Stock VS Code receives the disabled default but no forced course override.

Light Modern is the whole editor's default theme. Learning panels inherit the editor theme; there is no separate extension appearance setting or palette. Users can still select a different editor theme.

`lock.json` pins VSCodium, Code OSS, Electron and Node. `customize.py` applies narrow source changes and fails when upstream context changes. `build.py` produces a macOS DMG, Windows user setup EXE, or Linux tarball and Debian package on native x64/ARM64 runners. Pushing the exported build repository to `main` builds the four supported targets sequentially; it neither publishes releases nor updates a running service.

## Build

Use Node 24.18.0, Python 3.11+, Pillow, Git, Bash, jq and the native Code OSS build tools (Xcode command line tools on macOS; Visual Studio C++ build tools on Windows; the Linux packages listed in the workflow). Allow at least 16 GB RAM and 30 GB disk space.

Package the extension from `dhimant-skilling/dhimantai-learning` using `npm ci`, `npm run compile`, and `npm run package`. Then, from the repository root:

```sh
python3 dhimant-skilling/desktop/build.py --cache /absolute/path/to/new-build-cache \
  --arch arm64 --vsix /absolute/path/to/dhimantai-learning.vsix \
  --flutter-env staging=/absolute/path/to/env.staging.json \
  --out /absolute/path/to/artifacts
```

Use `--arch x64` on an x64 host. `--stage prepare`, `build`, and `package` allow inspection between stages. Preparation refuses to overwrite an existing checkout. Build and network operations have finite deadlines. Receipts include source pins and artifact SHA-256 values.

macOS packaging defaults to `--macos-signing developer-id` and requires the
signing configuration below. For an internal unnotarized preview only, explicitly
pass `--macos-signing ad-hoc`; missing credentials never trigger that fallback.

The desktop bundle receives only the same token-service URL, app name and client HMAC credential used by Flutter. Its generated `desktop-client.json` stays out of source control and ordinary VSIX packages. Supply production and staging separately with repeated `--flutter-env` flags when both are needed. Never substitute a LiveKit API secret or Supabase service-role key. The workflow expects the existing Flutter configuration in `FLUTTER_STAGING_ENV_JSON` or `FLUTTER_PRODUCTION_ENV_JSON` repository secrets.

## GitHub staging builds

The source checkout and the build checkout have separate Git remotes:

| Location | Remote / destination | Contents |
| --- | --- | --- |
| Main `dhimantai` checkout | `origin`: `git@bitbucket.org:optficial/dhimantai.git` | Full project source and history. |
| Separate build checkout | `origin`: `https://github.com/ssuda/dhimantai-desktop-builds.git` | Private, exported desktop build inputs only. |
| Public downloads | [ssuda/dhimantai-downloads Releases](https://github.com/ssuda/dhimantai-downloads/releases) | Verified installer binaries and `SHA256SUMS`, uploaded with `gh`; no Git push from the main checkout. |

The main checkout normally has **no GitHub remote**. Run the GitHub push from
the separate build checkout. HTTPS authentication comes from the account already
signed in through `gh`, using `gh auth git-credential` as the credential helper.
No token is placed in the remote URL or source files, and no GitHub SSH key is
required. Check access with `gh auth status --hostname github.com`; use
`gh auth login --hostname github.com --git-protocol https` if sign-in is needed.

Before exporting, commit the desktop changes and increment `appVersion` and
`release` in `lock.json` for changed native payloads. Increment the extension's
`package.json` and `package-lock.json` version when its payload changes. Published
filenames and extension versions must keep their original bytes.

From the main source checkout, export and push with these commands. The temporary
directory creates a fresh build checkout, so the mirror copy cannot overwrite a
developer's existing checkout:

```sh
desktop_stage=$(mktemp -d "${TMPDIR:-/tmp}/dhimantai-desktop-release.XXXXXX")
desktop_export="$desktop_stage/source"
desktop_build_repo="$desktop_stage/github"
desktop_source_commit=$(git rev-parse HEAD)

python3 dhimant-skilling/desktop/export_build_source.py --out "$desktop_export"
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
  clone https://github.com/ssuda/dhimantai-desktop-builds.git "$desktop_build_repo"
test "$(git -C "$desktop_build_repo" remote get-url origin)" = \
  https://github.com/ssuda/dhimantai-desktop-builds.git
test -z "$(git -C "$desktop_build_repo" status --porcelain)"
rsync -a --delete --exclude=.git/ "$desktop_export/" "$desktop_build_repo/"
git -C "$desktop_build_repo" add -A
git -C "$desktop_build_repo" commit -m "Build desktop from $desktop_source_commit"
git -C "$desktop_build_repo" -c credential.helper= \
  -c 'credential.helper=!gh auth git-credential' push origin main
```

The export includes shared reader assets and packaged lesson data, but no backend or
Flutter app code, credentials, or monorepo history. `build-source.json` records
the originating commit and file hashes; builds verify those bytes before use.
Receipts distinguish that source commit from the GitHub build commit.

The push above starts **Custom desktop preview** automatically on GitHub `main`;
there is no manual-dispatch step. Its jobs run in this order, with each requiring
the previous job to succeed:

1. Windows x64 build, then installation/CLI/uninstall acceptance.
2. macOS ARM64.
3. macOS Intel x64.
4. Linux x64.

Linux ARM64 and Windows ARM64 are not built. Workflow concurrency also prevents
two pushes from building at the same time; a running build is allowed to finish.
The automatic pipeline uses staging and explicitly uses ad-hoc macOS signing.
The shared build job lives in `.github/workflows/desktop-build.yml`; the calling
jobs and their dependencies live in `.github/workflows/desktop-preview.yml`.

```sh
gh run list --repo ssuda/dhimantai-desktop-builds --workflow desktop-preview.yml \
  --commit "$(git -C "$desktop_build_repo" rev-parse HEAD)" \
  --json databaseId,status,conclusion,url
gh run watch BUILD_RUN_ID --repo ssuda/dhimantai-desktop-builds --exit-status
gh run download BUILD_RUN_ID --repo ssuda/dhimantai-desktop-builds \
  --pattern 'desktop-*' --dir /absolute/path/to/artifacts
gh run download BUILD_RUN_ID --repo ssuda/dhimantai-desktop-builds \
  --name windows-install-acceptance-x64 --dir /absolute/path/to/acceptance
```

Save the run ID and download its successful `desktop-*` artifacts and JSON build
receipts before publishing. Windows acceptance uses the installer uploaded in the
same run and completes before the first macOS build starts.

The staging Actions secret contains only the Flutter client's token URL and client HMAC
key. The workflow refuses a public repository and never deploys a service.
Linux runners use temporary swap; native compilation may take substantially
longer than extension compilation. Installers and receipts are retained for
14 days, build logs for 7 days. Download the artifacts before retention expires.

**Windows desktop installer acceptance** runs automatically after the Windows
build. On a fresh native Windows runner, it verifies the installer checksum, installs into a temporary directory,
checks the packaged architecture and staging defaults, runs the installed CLI,
and uninstalls. Its receipt does not certify GUI, YouTube or physical devices.

If a job fails before any steps start, inspect its Actions annotation. The message
“recent account payments have failed or your spending limit needs to be increased”
requires the `ssuda` account owner to resolve [GitHub billing](https://github.com/settings/billing)
before a retry can run. A Git remote or a new access token does not fix that block.
For HTTP 403 while downloading debugger extensions, check GitHub API rate limits;
Ubuntu package-host DNS failures occur in **Native Linux prerequisites**.
The native build receives the job-scoped `GITHUB_TOKEN` for authenticated dependency
downloads. Linux prerequisite setup fails on an incomplete package-index refresh
and has a five-minute timeout. Read the failed job logs before retrying, and retain
successful artifacts.

```sh
gh run view BUILD_RUN_ID --repo ssuda/dhimantai-desktop-builds --log-failed
gh run rerun BUILD_RUN_ID --repo ssuda/dhimantai-desktop-builds --failed
# For a cancelled run, rerun the whole run instead:
gh run rerun CANCELLED_RUN_ID --repo ssuda/dhimantai-desktop-builds
```

Keep a release in draft until all intended installers and their acceptance checks
pass. Record partial builds and the blocker in `deploy/releases/`; leave the live
website downloads on the last verified release until the replacement is complete.

Publish verified receipt/artifact pairs with
`./deploy_dhimantai.sh --desktop-receipt /absolute/path/to/receipt.json`
(repeat for every available platform). The script prepares the manifest,
uploads and verifies GitHub release assets, and deploys the website's permanent
download redirects. With no receipt arguments it verifies/publishes the current
manifest. See `website/upskill/README.md` for dry-run and release details.
Never replace an already
published immutable download with different bytes under the same filename;
increment the desktop release when changing its payload.

## macOS Developer ID signing and notarization

The next preview build is **1.143.10007-preview.7**, with new artifact filenames.
Published preview 3 and preview 5 downloads remain unchanged. Both native
macOS runners use the same signing path. The automatic staging pipeline sets
`macos_signing: ad-hoc` in both macOS jobs, so these previews still trigger
Gatekeeper warnings. After configuring the Apple secrets below, change both
callers in `.github/workflows/desktop-preview.yml` to `macos_signing: developer-id`
for signed and notarized builds.

Configure these **repository Actions secrets** in
[the private build repository](https://github.com/ssuda/dhimantai-desktop-builds/settings/secrets/actions):

| Secret | Required value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 of an exported **Developer ID Application** certificate **with its private key**, from Keychain Access. |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that `.p12` export. |
| `MACOS_SIGNING_IDENTITY` | Exact certificate name, e.g. `Developer ID Application: Optficial Labs Pvt Ltd (TEAMID1234)`; use the actual name Apple issued. |
| `APPLE_TEAM_ID` | The certificate's 10-character Apple Developer Team ID. |

Also configure **one** notarization authentication method:

| Method | Secrets |
| --- | --- |
| App Store Connect **team** API key | `APPLE_API_KEY_P8` (the `.p8` file contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`. The key must have access to notarization. Individual API keys are not supported by this workflow. |
| Apple Account | `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password, not the normal account password); uses `APPLE_TEAM_ID` above. |

An active Apple Developer Program membership and accepted agreements are needed.
An iOS/Apple Distribution certificate or Developer ID Installer certificate does
not replace Developer ID Application signing for this app/DMG. The current app
does not need a provisioning profile for these entitlements.

Set secrets through GitHub's settings or pipe files directly to `gh secret set`.
For example, `base64 -i /private/path/DeveloperID.p12 | gh secret set
MACOS_CERTIFICATE_P12_BASE64 --repo ssuda/dhimantai-desktop-builds`. Do not paste
private keys/passwords in chat, source files, workflow inputs, or build logs.

The workflow checks required secret names before compilation. After compilation
it imports the certificate into a temporary keychain, verifies a matching valid
identity, and validates notarization authentication with Apple. Original keychain
search paths are preserved and restored. Imported `.p12`/`.p8` files are removed
immediately; an `always()` step deletes the temporary keychain even on failure.
Credential command failures suppress command arguments and raw diagnostics.

Packaging signs the app and nested Electron components using the pinned Code OSS
entitlements, hardened runtime and secure timestamps. It notarizes a ZIP of the
app, requires an `Accepted` result, staples the app, then creates and signs the
DMG. It notarizes and staples that DMG and runs strict signature, stapler and
Gatekeeper checks, including the app mounted from the final read-only DMG.
The receipt is written only after those checks, records
`signing=developer-id-notarized`, team/submission IDs and validation results, and
hashes the final stapled DMG. No changes to the signed payload follow that hash.

Each notarization submission waits at most 20 minutes (25 minutes including
upload/process overhead), with no automatic re-submission. The separate
`notarization-*` Actions artifact retains submission IDs/status and rejection
reports for 14 days. If Apple is still processing a timed-out submission, inspect
`xcrun notarytool history` / `info` with the same credentials before a manual retry.
Do not treat a pending submission as success.

For local packaging, install the Developer ID certificate/private key in your
keychain and securely create a profile with `xcrun notarytool store-credentials`.
Set `MACOS_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, and
`MACOS_NOTARY_KEYCHAIN_PROFILE` to that profile name; optionally set
`MACOS_SIGNING_KEYCHAIN` when both the identity and profile use a custom keychain.
Then use the normal build command above. No credential values are needed in its
command-line arguments.

Credential inventory checked on **2026-11-10**: the private GitHub build repository
contained only `FLUTTER_STAGING_ENV_JSON`, no repository variables or environments,
and none of the Apple secrets above. The local user keychain had no valid signing
identities, Developer ID Application certificates, or detected notarization
profiles; Apple `notarytool` and `stapler` were installed. The iOS project records
team **HSUM36L347**, which is a candidate for `APPLE_TEAM_ID`, but its current
membership, ownership and availability for Developer ID issuance were not verified.
No `.p12`, `.pfx`, `.p8` or `.cer` files were found in the workspace, Downloads or
the standard local API-key directories checked. This inventory does not rule out
credentials held elsewhere or in another Apple account/keychain.

References: [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[GitHub signing keychains](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

## Existing client contract

The extension first uses its existing authenticated session endpoint for learner eligibility and profile fields. In the custom desktop, Instructor then connects through Flutter's existing `/getToken` contract, joins idle, and selects the lesson using `switch_mode`. Microphone control uses `toggle_audio`; camera capture publishes a LiveKit video track. No new RPC or agent behavior is introduced. Stock VS Code keeps its existing connection path.

Capture starts only on an explicit device action. The native host registers the extension's webview origin from the trusted workbench, checks the owning live frame, and asks for device-specific consent. YouTube/remote frames receive no media grant. The client stops tracks on hide, leave, disconnect or stale permission completion. macOS usage descriptions and capture entitlements are included.

Flutter rooms do not expose the extension-only automatic code-observation RPC. This preview disables that control and retains explicit “Ask Instructor” code sharing. Camera publication uses Flutter's existing behavior; this change does not add new visual reasoning to the agent.

## Validation and release status

Run `node --test dhimant-skilling/desktop/tests/*.test.mjs`, `python3 -m unittest discover -s dhimant-skilling/desktop/tests -p 'test_*.py'`, and, after extension compilation, `node --test dhimant-skilling/dhimantai-learning/out/test/desktopRoom.test.js`.

Preview 5 updates the five existing website targets: Windows x64, macOS x64/ARM64,
and Linux x64/ARM64. It bundles extension **0.39.17** and enables silent extension
updates. Its release and acceptance checks are recorded in the
[preview 5 release report](../../deploy/releases/2026-11-11-staging-desktop-preview5.json).
Windows x64 passed native install, CLI startup, staging-default and uninstall checks.
The macOS ARM64 DMG passed bundled-extension update/restart, real YouTube playback
and synthetic microphone/camera checks. Physical-device consent and live Instructor
responses were not certified by these tests.

Preview 4's six native builds and eight artifact checksums are verified in the
[build verification report](../../deploy/releases/2026-11-10-desktop-preview4-verification.json).
Windows x64 and ARM64 passed native install, CLI startup, staging-default and
uninstall checks. Both macOS packages passed architecture, staging-default and
ad-hoc signature checks; Linux packages passed payload/default checks. The report
records the original source and build commits. Later source changes require a
new desktop release. This verification did not publish the preview.

The local macOS ARM64 preview builds and signs successfully. Extension compilation, device-policy/client tests, the preload CSP check, and Catalog startup/navigation checks pass. The whole-editor light theme and Catalog welcome were inspected in the running app. The full Code OSS TypeScript check still reports errors in unchanged policy tests, notebook-status tests and the issue reporter; it is not a clean upstream type-check result.

`check-vscode-video-runtime.cjs` launches the actual editor with its sandbox enabled and tests real YouTube playback, audio-byte decoding, pause/ask/resume and server pause. Authentication and Instructor transport are fixtures; it is not live-agent acceptance. `check-desktop-devices.cjs` tests capture with synthetic devices; it must never be launched against physical devices for unattended testing. Chromium's fake-device path can bypass real consent, so its passing result does not certify native/OS permission prompts. Permission policy and client cleanup have separate unit tests; physical-device consent needs interactive acceptance.

The YouTube check may need an initial Play click in the real player. Cross-origin IFrame API calls do not reliably carry browser user activation; the test leaves autoplay restrictions enabled.

Preview 5 macOS packages are ad-hoc signed and unnotarized. The preview 5
pipeline supports Developer ID signing/notarization, but no real signed build has
been validated yet because the credentials are missing. Windows remains unsigned.
Native playback, capture, install/uninstall and signed-in Instructor acceptance
must be recorded on the final signed artifacts before customer release. No Windows
or Linux runtime acceptance is implied by the macOS checks.

Native test launchers use disposable profiles, in-memory secret storage and a macOS mock keychain. They contain no real sign-in credentials. The installed application retains OS-backed secure storage; ad-hoc signing can cause macOS Keychain prompts after rebuilds. Consistent Developer ID signing is required for customer updates.

## Updates

The learning extension updates silently from the selected dhimantAI service when the app starts. Downloads are
checked against the published SHA-256 before installation. The current lesson keeps running; the new version
activates on the next normal app restart, without a reload prompt. An explicit `dhimantai.autoUpdate=false`
opts out. Automatic installation makes one attempt per version; a failed attempt can be retried through
**dhimantAI: Install Extension Update**. App-owned device configuration and existing desktop preferences
survive extension updates.

Preview 3 and preview 4 need a one-time update to preview 5: the app must allow `optficial.dhimantai-learning` in
`builtInExtensionsEnabledWithAutoUpdates` and bundle extension 0.39.10 or newer. Publishing or manually
installing a VSIX alone cannot enable this in older apps, which reject updates to bundled extensions.

Native application updates are disabled for this preview. Microsoft and VSCodium update feeds cannot replace
the custom media runtime. Native Electron/device changes still require installing the next dhimantAI package
over it; application IDs and user-data paths remain stable.

For a customer channel, maintain the source pins, apply upstream security releases, rebuild and validate all target installers, sign/notarize them, then publish an owned HTTPS update feed with checksums. The existing updater plumbing is retained, but no feed or automatic release publication is configured here. Code OSS and VSCodium license/notices remain in the distribution; Open VSX remains the extension catalog.

Upstream references: [VSCodium build instructions](https://github.com/VSCodium/vscodium/blob/master/docs/howto-build.md), [Electron permission handlers](https://www.electronjs.org/docs/latest/api/session), [GitHub native runner labels](https://github.com/actions/runner-images).
