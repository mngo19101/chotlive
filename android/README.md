# ChốtLive cho Android

App Android native (Kotlin + Jetpack Compose), chuyển từ app iPhone trong `ios-native/`: cùng màn hình, cùng server, cùng tài khoản và đồng bộ dữ liệu như bản iPhone.

Khác bản iPhone:

- **Máy in:** nối được cả máy in Bluetooth LE lẫn máy chỉ có Bluetooth Classic (SPP). Máy Classic nên ghép đôi trước trong Cài đặt › Bluetooth của điện thoại.
- **Nút Back** ở màn chính đưa app xuống nền, không tắt app, để quay lại live nhanh.

## Build APK

Cần JDK 17 và Android SDK (platform 35, build-tools 35). Trên máy này đã cài sẵn ở `%LOCALAPPDATA%\chotlive-build\jdk17` và `%LOCALAPPDATA%\Android\Sdk`.

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA\chotlive-build\jdk17"
cd android
.\gradlew.bat assembleRelease
```

File ra ở `android/app/build/outputs/apk/release/app-release.apk`.

Địa chỉ server gắn sẵn mặc định là `https://mnhtis.tail3ed304.ts.net`. Muốn đổi:

```powershell
.\gradlew.bat assembleRelease -PchotliveServerUrl=https://ten-mien-cua-ban.vn
```

Truyền `-PchotliveServerUrl=` (để trống) thì màn đăng nhập cho nhập địa chỉ server bằng tay.

## Khoá ký app

APK được ký bằng `android/release-key/chotlive.p12`, mật khẩu nằm trong `android/keystore.properties`. Hai file này **không** đưa lên git.

**Hãy sao lưu cả hai file ra chỗ khác.** Mất khoá thì bản build sau không cài đè được lên app đang dùng: phải gỡ app cũ (mất dữ liệu chưa đồng bộ trên máy) rồi cài lại. Không có `keystore.properties` thì Gradle ký bằng khoá debug.

## Test

```powershell
.\gradlew.bat testDebugUnitTest
```

Test chạy trên JVM, không cần điện thoại: bắt giá (so với `public/js/price.js` của bản web), đồng bộ, lưu dữ liệu theo tài khoản, chọn kênh in Bluetooth.
