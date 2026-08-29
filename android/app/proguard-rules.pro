# Keep the @JavascriptInterface methods reachable from the WebView bridge even
# if minification is enabled in a future release build.
-keepclassmembers class app.tcoaal.browserplayer.SaveBridge {
    @android.webkit.JavascriptInterface <methods>;
}
