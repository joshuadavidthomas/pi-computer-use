Place arm64 helper binaries here as:

prebuilt/macos/arm64/modern/bridge
prebuilt/macos/arm64/legacy/bridge

`setup-helper.mjs` selects `modern` on macOS 14+ and `legacy` on macOS 12/13, then copies the selected binary to:
~/.pi/agent/helpers/pi-computer-use/bridge

Build both variants with:

node scripts/build-native.mjs --arch arm64 --variant all

For public releases, sign with a Developer ID Application identity and notarize the package artifact.
