#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== [1/6] التحقق من android.jar ==="
ANDROID_JAR=""
for p in "$PREFIX/share/aapt/android.jar" "$PREFIX/share/java/android.jar"; do
    if [ -f "$p" ]; then
        ANDROID_JAR="$p"
        break
    fi
done

if [ -z "$ANDROID_JAR" ]; then
    echo "خطأ: لم يتم العثور على android.jar. نفّذ: pkg install -y aapt"
    exit 1
fi
echo "تم العثور على: $ANDROID_JAR"

rm -rf build
mkdir -p build/gen build/obj build/dex

echo "=== [2/6] تجميع الموارد وملفات التطبيق (aapt) ==="
aapt package -f -m     -J build/gen     -M AndroidManifest.xml     -S res     -A assets     -I "$ANDROID_JAR"     -F build/unsigned.apk

echo "=== [3/6] ترجمة كود Java (javac) ==="
JAVA_FILES=$(find src build/gen -name '*.java')
javac -source 1.8 -target 1.8 -encoding UTF-8     -classpath "$ANDROID_JAR"     -d build/obj     $JAVA_FILES

echo "=== [4/6] تحويل إلى DEX (d8) ==="
CLASS_FILES=$(find build/obj -name '*.class')
d8 --lib "$ANDROID_JAR" --output build/dex $CLASS_FILES

echo "=== [5/6] دمج classes.dex والمحاذاة (zipalign) ==="
(cd build/dex && zip -u ../unsigned.apk classes.dex)
zipalign -f 4 build/unsigned.apk build/aligned.apk

echo "=== [6/6] توقيع ملف APK (apksigner) ==="
if [ ! -f debug.keystore ]; then
    keytool -genkeypair -v         -keystore debug.keystore         -alias androiddebugkey         -keyalg RSA         -keysize 2048         -validity 10000         -storepass android         -keypass android         -dname "CN=Android Debug,O=Android,C=US"
fi

apksigner sign     --ks debug.keystore     --ks-pass pass:android     --key-pass pass:android     --out SubscriptionsManager.apk     build/aligned.apk

echo ""
echo "========================================"
echo "تم بناء ملف APK بنجاح: $(pwd)/SubscriptionsManager.apk"
if [ -d "$HOME/storage/downloads" ]; then
    cp -f SubscriptionsManager.apk "$HOME/storage/downloads/SubscriptionsManager.apk"
    echo "تم نسخه تلقائياً إلى مجلد التنزيلات (Downloads/SubscriptionsManager.apk)"
fi
echo "========================================"
