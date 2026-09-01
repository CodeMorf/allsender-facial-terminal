# AllSender Facial has no custom shrinking rules yet. Keep the WebView bridge
# methods, which are reached by JavaScript through @JavascriptInterface.
-keepclassmembers class tech.allsender.facialterminal.** {
    @android.webkit.JavascriptInterface <methods>;
}
