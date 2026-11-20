#!/usr/bin/env bash
# Músicos MX — compila el APK de Android sin Gradle (GPL-3.0-o-posterior)
# Requiere: JDK, aapt, dx/d8, zipalign, apksigner y android.jar (SDK de Android o paquetes
# de Debian/Ubuntu: aapt apksigner zipalign dalvik-exchange android-sdk-platform-23).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(node -p "require('../package.json').version")
CODE=$(node -p "const v=require('../package.json').version.split('.').map(Number);v[0]*10000+v[1]*100+v[2]")
SDK=${ANDROID_HOME:-/usr/lib/android-sdk}
JAR=${ANDROID_JAR:-$(ls -d $SDK/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1)}
BT=$(ls -d $SDK/build-tools/* 2>/dev/null | sort -V | tail -1 || true)
AAPT=${AAPT:-$( [ -n "$BT" ] && [ -x "$BT/aapt" ] && echo "$BT/aapt" || command -v aapt )}
ZIPALIGN=${ZIPALIGN:-$( [ -n "$BT" ] && [ -x "$BT/zipalign" ] && echo "$BT/zipalign" || command -v zipalign )}
APKSIGNER=${APKSIGNER:-$( [ -n "$BT" ] && [ -x "$BT/apksigner" ] && echo "$BT/apksigner" || command -v apksigner )}
D8=$( [ -n "$BT" ] && [ -x "$BT/d8" ] && echo "$BT/d8" || true )
DX=$(command -v dalvik-exchange || command -v dx || true)
echo "android.jar: $JAR"
rm -rf build && mkdir -p build/gen build/classes build/assets/www build/res
cp -r ../dist/. build/assets/www/
cp -r res/. build/res/
# iconos del lanzador
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  n=${d%%:*}; s=${d##*:}; mkdir -p build/res/mipmap-$n
  if command -v rsvg-convert >/dev/null; then rsvg-convert -w $s -h $s ../build/icon-small.svg -o build/res/mipmap-$n/ic_launcher.png
  else cp ../build/icons/128x128.png build/res/mipmap-$n/ic_launcher.png; fi
done
"$AAPT" package -f -m -J build/gen -M AndroidManifest.xml -S build/res -I "$JAR" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$CODE" --version-name "$VERSION"
javac -encoding UTF-8 --release 8 -nowarn -classpath "$JAR" -d build/classes build/gen/mx/santiagomiguel/musicosmx/R.java src/mx/santiagomiguel/musicosmx/MainActivity.java
if [ -n "$D8" ]; then "$D8" --min-api 24 --lib "$JAR" --output build $(find build/classes -name '*.class')
else "$DX" --dex --min-sdk-version=24 --output=build/classes.dex build/classes; fi
"$AAPT" package -f -M AndroidManifest.xml -S build/res -A build/assets -I "$JAR" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$CODE" --version-name "$VERSION" -F build/unsigned.apk
(cd build && "$AAPT" add unsigned.apk classes.dex >/dev/null)
"$ZIPALIGN" -f -p 4 build/unsigned.apk build/aligned.apk
KS=${ANDROID_KEYSTORE:-$HOME/.musicosmx/musicosmx-release.keystore}
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass "${ANDROID_KS_PASS:-musicosmx}" -keypass "${ANDROID_KS_PASS:-musicosmx}" -alias musicosmx -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Santiago Miguel, O=Musicos MX, C=MX" >/dev/null 2>&1
fi
mkdir -p ../release
"$APKSIGNER" sign --ks "$KS" --ks-pass pass:"${ANDROID_KS_PASS:-musicosmx}" --ks-key-alias musicosmx --out "../release/Musicos-MX-$VERSION.apk" build/aligned.apk
"$APKSIGNER" verify "../release/Musicos-MX-$VERSION.apk" && echo "APK listo: release/Musicos-MX-$VERSION.apk"
