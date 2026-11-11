# VS Code video runtime investigation

The local repair is experimental and supports only the exact macOS arm64 build
identified in `patch-vscode-video-runtime.py`: VS Code 1.145.2, commit
`c4453f8ea430795f941c1b2ff6c9321135a74a02`, Electron 43.8.3. It is not a customer
installer and does not enable microphone or camera capture.

## Local reproduction

From the extension directory, inspect without changing the application:

```sh
python3 scripts/patch-vscode-video-runtime.py
```

Prepare an isolated application and exercise the actual production webview:

```sh
python3 scripts/patch-vscode-video-runtime.py --prepare '/tmp/dhimantai-video/Code.app'
npm run compile
VSCODE_TEST_EXECUTABLE='/tmp/dhimantai-video/Code.app/Contents/MacOS/Code' \
  node scripts/check-vscode-video-runtime.cjs
```

The native check uses a fresh temporary profile and retains the sandbox. It
exercises live YouTube media and fixture Instructor transport. Results and a
screenshot remain in the printed output directory. Set `DHIMANTAI_UX_OUT` to a
fresh directory to choose that destination. No learner login is used.

For an explicitly chosen local installation, quit all VS Code processes first:

```sh
python3 scripts/patch-vscode-video-runtime.py --app '/path/to/Code.app' --apply
python3 scripts/patch-vscode-video-runtime.py --app '/path/to/Code.app' --restore
```

The helper verifies the pinned official Electron archive checksum, copies the
application, replaces the full runtime and applies local development signatures.
It retains the full original application and original signatures beside the app,
along with a recovery receipt. It refuses an unknown build, a running app, an
existing backup or a changed executable/runtime on restore. User profiles are
untouched. It changes no system security settings.

These development signatures do not preserve Microsoft's hardened-runtime
signature or provide notarization. Restore the original before using the normal
VS Code updater. An upstream update may replace the repair; the script will
refuse an untested version. Do not blindly reapply it after updates.

Safety checks:

```sh
python3 -m unittest discover -s scripts -p test_patch_vscode_video_runtime.py
```

## Customer distribution across Windows, macOS and Linux

A maintained Code OSS distribution using the VSCodium build infrastructure is
the proposed customer route. It has not been built or released by this change.
Stock VSCodium is not assumed to fix media by itself; the packaged runtime must
pass the native playback tests on every target.

The distribution needs a pinned compatible Electron runtime, the dhimantAI
extension, product identity and platform packaging: a Windows installer,
signed/notarized macOS app, and Linux packages. It also needs an update feed owned
by this distribution, with tested upstream VS Code/Electron updates rebuilt and
published for each supported OS and architecture. Microsoft's automatic updater
cannot maintain these customizations. Extension updates remain a separate track.

Device access requires changes beyond codecs. In the inspected VS Code source,
`configureSession()` allows `media` for core windows but omits it for extension
webviews. Both permission checks and requests need an explicit consent flow
bound to the requesting dhimantAI webview, with revocation and navigation checks.
The webview frame permission policy and macOS camera/microphone usage descriptions
and entitlements must also permit capture. The YouTube iframe should retain its
current `microphone 'none'; camera 'none'` policy; learning-room capture belongs in
the trusted app webview. The current disabled microphone UI still needs product
wiring, and the learning-room grant currently has `can_publish=False`, so sending
capture tracks also needs a scoped backend change. OS permission prompts and
customer/administrator device policies apply.

Customer acceptance must cover actual video with audible sound, capture allowed
and denied, missing devices, pause/resume, installer/uninstaller behavior and
an update from the previous packaged release. Signing identities and a hosted
update channel remain release inputs, not completed work in this prototype.

Sources:

- [VS Code permission handlers at the inspected commit](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/code/electron-main/app.ts#L262-L299)
- [Electron permission checks and requests](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler)
- [VSCodium build instructions](https://github.com/VSCodium/vscodium/blob/master/docs/howto-build.md)
- [VSCodium extension compatibility](https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md)
