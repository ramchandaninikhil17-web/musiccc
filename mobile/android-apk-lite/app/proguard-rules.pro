# ProGuard / R8 rules for MusicFlow APK Lite
# Keep WebView JavaScript interface methods
-keepclassmembers class com.musicflow.player.MainActivity$WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Kotlin metadata
-keep class kotlin.Metadata { *; }

# Keep AndroidX media classes
-keep class androidx.media.** { *; }
