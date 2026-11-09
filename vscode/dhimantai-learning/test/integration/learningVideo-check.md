# Inline video acceptance — 2026-11-09

Status: **native playback passed in an isolated repaired macOS arm64 application;
customer release and live Instructor acceptance remain pending**.

The production learning-room webview played the live Token Embeddings YouTube
video `KnCP1Sg8ajU` in VS Code 1.145.2 / Electron 43.8.3 after replacing the entire
Electron Framework with the matching upstream Electron framework. Replacing
only `libffmpeg.dylib` did not fix playback on this platform. The original
Microsoft application was not modified.

The final native run retained the Electron sandbox. Its receipt recorded 130 decoded
video frames and 31,619 decoded audio bytes at 2.064513 seconds, with the player
unmuted at full volume. This demonstrates audio decoding, not a human listening
check. Pause and ask acknowledged 2.077659 seconds before delivering the first
question. Resume advanced the playhead; sending a question during playback
paused at 3.106039 seconds before delivery. A second resume and server-requested
pause acknowledged 4.133043 seconds. The native process exited successfully.
An intermediate harness run timed out after requesting playback before YouTube
was ready; the suite now waits for player state and duration before starting it.

Catalog, auth and Instructor transport were fixtures. The player, hosted staging
wrapper, production room bundle and media decoding were real. This does not
verify signed-in staging answers, timestamp-grounded teaching, microphone/camera
capture, Windows/Linux, or a signed customer installer.

The stock installed VS Code still exhibits the original failure. The popup error
concerns navigation from the failed player's link; permitting popups does not
supply missing codecs. The earlier 2026-11-06 test on VS Code 1.106.3 failed to
advance playback and remains a failed result for that runtime.

Ten focused webview tests passed for video, learning room and speaker controls.
Seven patch/rollback tests passed. Those simulated tests do not replace native
playback acceptance. Applying and restoring the helper on a disposable real app
also passed: original executable/runtime hashes and native signatures were
verified after rollback. See [reproduction and distribution notes](../../scripts/video-runtime.md).
