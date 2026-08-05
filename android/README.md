# Tunestack Android APK

This Android project packages the Tunestack phone/tablet interface. It builds
and installs normally without private credentials. Native ShazamKit support is
an optional add-on for one-time identification of local tracks.

## Optional private ShazamKit configuration

1. Download ShazamKit for Android from Apple Developer Downloads.
2. Place `shazamkit-android-release.aar` in `app/libs/`.
3. Create a Media ID and Media Services private key in Apple Developer.
4. Generate a signed ShazamKit developer token outside the app.
5. Add only the signed token to `local.properties`:

   `SHAZAM_DEVELOPER_TOKEN=your.signed.jwt`

Never place the Apple `.p8` private key in this project, the APK, or chat.

If the AAR or token is not present, the APK uses a safe unavailable-status
bridge; playback, Synology access, radio, lyrics, mood tags, and saved metadata
remain available.

## Build

Open this `android/` directory in Android Studio and build the debug APK, or
run `./gradlew assembleDebug` after configuring the Android SDK.

The APK will be written to:

`app/build/outputs/apk/debug/app-debug.apk`

The developer token expires on the date encoded in the JWT. Rebuild with a new
signed token before that date.
