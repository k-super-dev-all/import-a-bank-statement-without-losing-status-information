# Statement import (React Native 0.88, TypeScript)

Pick a PDF/CSV, validate it locally, stream the real bytes to the local mock, survive a lost response / relaunch, and delete the import safely. Native run only (no web, no Expo Go).

## Clean checkout

Node 22.11+ (RN 0.88). The mock kit is the unmodified kit in the parent folder.

```sh
# terminal 1 – mock API (kit root)
npm start                        # http://127.0.0.1:8787
npm run fixtures:oversize        # creates fixtures/oversize.csv

# terminal 2 – client
cd mobile
npm install
npx react-native start

# terminal 3 – Android emulator
adb reverse tcp:8787 tcp:8787    # client uses http://127.0.0.1:8787
npm run android
# iOS simulator (macOS only): cd ios && bundle exec pod install && cd .. && npm run ios
```

Base URL lives in `src/config.ts`. Android debug builds allow cleartext HTTP; a release build would need HTTPS or a network-security config.

Put test files on the device first (e.g. `adb push fixtures/statement.csv /sdcard/Download/`, same for `statement.pdf`, `spoofed.pdf`, `oversize.csv`), then use "Choose file".

## Tests

```sh
cd mobile && npm test
```

`__tests__/flow.test.ts` starts the real, unmodified `mock-server.mjs` on port 8799 (resets it first), drives the same `ImportController` as the app against it, and asserts mock counters from `/__test/state`:

| Matrix item | Assertion |
| --- | --- |
| happy | 202 is `queued` without items; after ready: 2 items, 151.99 AUD; `newJobs=1`, bytes match the fixture |
| saved key | the op with its key is persisted before any POST (`createRequests=0` at first save) |
| lost_ack | `newJobs=1`; recovered by `GET /by-key`; relaunch does not POST. In Jest `createRequests=1`; on Android it was 2 in a manual run (the HTTP client's automatic retry of the dropped POST, same key and bytes, so the server returned the same job) |
| relaunch mid-send | state `unknown`, no automatic POST; user retry reuses the same key |
| stale_status | ready/rev 3 followed by processing/rev 2 leaves UI at ready/rev 3 |
| delete_failure | 503 → "NOT confirmed deleted", status stays ready; retry with same key → `deleting` → `deleted`; `deleteRequests=2` |
| spoofed + oversize | `createRequests` identical before and after; temp copies removed |

The tests run in Node with the HTTP/file layers swapped for Node equivalents (the native streaming upload and picker are not exercised by Jest — see "Verified").

## How it works

- **Picker** (`@react-native-documents/picker`, `open` mode) → copy into the app's private cache (`keepLocalCopy`) → iOS security scope released. Files whose reported size is over 10 MiB are refused *before* copying.
- **Validation** by content: size from `stat`, and the first 32 bytes (via `fs.slice`, never the whole file) must be `%PDF-` or the CSV header the server expects. Extension/MIME are ignored.
- **Upload** streams the file from disk (`react-native-blob-util` file body) as `application/octet-stream` with `Idempotency-Key` and `X-File-Name`.
- **State** (`import-op.json` in the app document dir): key, minimal job data, and the delete key, saved before the first POST. On relaunch, an unresolved send becomes "result unknown": the app only does `GET /imports/by-key/…`; a second POST needs a user tap and uses the same key and the same private copy.
- **Revisions**: `mergeStatus` ignores older revisions, and after delete was accepted ignores anything but deleting/deleted.
- **Delete** is "deleted" only when the server reports `deleted`. The copy is deleted as soon as the job exists, on rejection, on cancel, or on discard.
- No logging anywhere; file name, bytes and items never go to logs or analytics.

## Verified

| Platform | Status |
| --- | --- |
| Jest (Node, real mock) | 10/10 pass |
| Android emulator | see the table below — fill with the device/API level you actually ran |
| iOS | **not verified** (no macOS/simulator available on this machine) |

Android manual run (fill in): device/API ____, happy ____, lost_ack/relaunch ____, stale_status ____, delete_failure ____.

## Release note

- **Permissions**: Android `INTERNET` only. The picker uses the system document UI (no storage permission). iOS: none; no Info.plist usage strings needed for the picker.
- **Where copies live**: one private cache copy (`cacheDir/<uuid>/<name>`) from pick until the job is created, rejected, cancelled or discarded; `import-op.json` (file name, size, keys, report items) in the app's document dir until "Done"/"Discard". Backup is disabled on Android. Clear via Done/Discard, or Settings → Clear storage / uninstall.
- **Rollout stop signal**: rising share of "result unknown" that never resolves, any report of a second job per one import (`newJobs` ≠ imports), or any delete shown as done without server `deleted`.
- **Needs a new binary (not OTA)**: changing picker/blob-util versions or any native module, manifest/Info.plist changes, cleartext/ATS config, new permissions. UI/state logic in `src/` and `App.tsx` can ship over JS/OTA.
