Place the arm64 helper binary here as:

prebuilt/macos/arm64/bridge

`setup-helper.mjs` will copy this binary to:
~/.pi/agent/helpers/pi-computer-use/bridge

Build it with:

node scripts/build-native.mjs --arch arm64

For public releases, sign with a Developer ID Application identity and notarize the package artifact.
