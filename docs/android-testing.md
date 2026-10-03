# Android instrumentation tests

The Android suite runs on a fresh API 35 test emulator. It uses the app's local demo
adapter and newly generated fake credential values; no Mac server, real provider
account, authorization flow, or live model request is part of these tests.

The test entry point is
`android/app/src/androidTest/java/io/github/colorsn99/whisper/WhisperInstrumentedTest.java`.
It uses `AndroidJUnit4`, `ActivityScenario`, and the stable resource IDs exposed by
the native UI through UiAutomator 2.3.0.

## Scope

- Launch the default local conversations without configuring a Mac or provider.
- Send and stop a local demo reply from a private conversation.
- Inspect group members, read the uniquely identified group message through a
  new `LocalStore` instance, and restore it after closing and relaunching the
  Activity.
- Keep credentials in memory by default. Only an explicit persistent write may
  create a saved record; constructing another store must not restore it.
- Reject restoration without consent, restore only with consent, remove the
  test-owned record, and ensure opting back into memory-only storage removes the
  previously saved value.

Activity close/relaunch checks lifecycle restoration. It does not simulate a
force-stopped app or prove process-death recovery. Tests must not force-stop their
own instrumentation process or use a personal phone.

Streaming checks temporarily disable UiAutomator's implicit idle wait and use
bounded explicit conditions so that continuous text updates do not postpone the
stop action until the reply is already finished. The original idle timeout is
restored after each test. Group restoration waits for both replies to be committed
before relaunching and compares the complete rendered transcript.

Every credential test creates a unique record ID and fake value and removes only
that record in `finally`. Tests do not enumerate unrelated records, inspect real
credentials, configure external providers, or print secrets.

## Running and artifacts

Run the connected instrumentation task from the Android project after starting
the isolated emulator:

```sh
./gradlew connectedDebugAndroidTest
```

UI screenshots are saved with `UiDevice.takeScreenshot` inside the tested app's
external files directory, under `instrumentation-screenshots`. Credential tests
do not open credential forms or capture their fake values. The build environment can collect the
app-specific directory:

```sh
adb pull /sdcard/Android/data/io.github.colorsn99.whisper/files/instrumentation-screenshots android-instrumentation-screenshots
```

The instrumentation test report is generated under
`app/build/reports/androidTests/connected/`. Screenshots support the assertions;
they do not replace the test report. A successful local source review is not an
instrumentation pass: execution results must come from the emulator job.
