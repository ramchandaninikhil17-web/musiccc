package com.musicflow.player

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    companion object {
        const val DEFAULT_URL = "https://musicwalahnar.com"
        private const val PREFS_NAME = "musicflow_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val PERMISSION_REQUEST_NOTIFICATION = 1001
        private const val PERMISSION_REQUEST_STORAGE = 1002
        private const val FILE_CHOOSER_REQUEST = 1003
    }

    private lateinit var webView: WebView
    private lateinit var offlineView: LinearLayout
    private lateinit var retryButton: Button
    private lateinit var changeServerButton: Button

    private var playbackService: PlaybackService? = null
    private var serviceBound = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDownloadUrl: String? = null
    private var hasLoadedOnce = false

    fun getServerUrl(): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL
    }

    fun setServerUrl(url: String) {
        var cleanUrl = url.trim()
        if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
            cleanUrl = "https://$cleanUrl"
        }
        cleanUrl = cleanUrl.trimEnd('/')
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, cleanUrl)
            .apply()
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as PlaybackService.LocalBinder
            playbackService = binder.getService()
            serviceBound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService = null
            serviceBound = false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.parseColor("#0B0E14")

        // Keep screen from dimming during active use
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        offlineView = findViewById(R.id.offlineView)
        retryButton = findViewById(R.id.retryButton)
        changeServerButton = findViewById(R.id.changeServerButton)

        // Configure status bar icons (light text on dark bg)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        setupWebView()
        setupButtons()
        requestNotificationPermission()

        // Bind to PlaybackService
        Intent(this, PlaybackService::class.java).also { intent ->
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }

        // Load the website
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            loadWebsite()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = webView.settings.userAgentString + " MusicFlowApp/1.0"
        }

        // Hardware-accelerated rendering
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        // Enable cookies
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        // Disable WebView debugging in release builds
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        // JavaScript interface for native bridge
        webView.addJavascriptInterface(WebAppInterface(), "MusicFlowAndroid")

        webView.webViewClient = MusicFlowWebViewClient()
        webView.webChromeClient = MusicFlowChromeClient()

        // Download listener for music downloads
        webView.setDownloadListener(MusicFlowDownloadListener())
    }

    private fun setupButtons() {
        retryButton.setOnClickListener {
            loadWebsite()
        }
        changeServerButton.setOnClickListener {
            showChangeServerDialog()
        }
    }

    private fun showChangeServerDialog() {
        val input = EditText(this).apply {
            setText(getServerUrl())
            hint = "https://your-app.onrender.com"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setSingleLine(true)
            val padding = (16 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
        }

        AlertDialog.Builder(this, androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert)
            .setTitle(R.string.server_url_dialog_title)
            .setMessage(R.string.server_url_dialog_message)
            .setView(input)
            .setPositiveButton(R.string.save_and_connect) { _, _ ->
                val entered = input.text.toString().trim()
                if (entered.isNotEmpty()) {
                    setServerUrl(entered)
                    hasLoadedOnce = false
                    Toast.makeText(this, "Server updated! Connecting...", Toast.LENGTH_SHORT).show()
                    loadWebsite()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun loadWebsite() {
        if (isNetworkAvailable()) {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            webView.loadUrl(getServerUrl())
        } else {
            showOfflineView()
        }
    }

    private fun showOfflineView() {
        webView.visibility = View.GONE
        offlineView.visibility = View.VISIBLE
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val network = cm.activeNetwork ?: return false
            val capabilities = cm.getNetworkCapabilities(network) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } else {
            @Suppress("DEPRECATION")
            val networkInfo = cm.activeNetworkInfo
            @Suppress("DEPRECATION")
            return networkInfo?.isConnected == true
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    PERMISSION_REQUEST_NOTIFICATION
                )
            }
        }
    }

    // ---- WebView Clients ----

    private inner class MusicFlowWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            hasLoadedOnce = true

            // Switch from splash theme to regular theme after first load
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.setBackgroundDrawableResource(R.color.mf_bg)
            }

            // Inject native bridge script for media notifications
            injectNativeBridge()
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            // Only show offline view for main frame navigation errors
            if (request?.isForMainFrame == true) {
                if (!hasLoadedOnce) {
                    showOfflineView()
                }
            }
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?
        ): Boolean {
            val url = request?.url?.toString() ?: return false

            // Keep navigation within the configured server or default domain inside the WebView
            val currentServer = getServerUrl()
            if (url.startsWith(currentServer) || url.startsWith(DEFAULT_URL) || url.startsWith("https://musicwalahnar.com")) {
                return false
            }

            // Open external URLs in the system browser
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                // No browser available — silently ignore
            }
            return true
        }
    }

    private inner class MusicFlowChromeClient : WebChromeClient() {
        // File chooser for local music picker
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = filePathCallback

            val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "audio/*"
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }

            // Accept audio files
            intent.type = "audio/*"
            intent.putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("audio/mpeg", "audio/flac", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/*")
            )

            try {
                startActivityForResult(intent, FILE_CHOOSER_REQUEST)
            } catch (e: Exception) {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = null
                Toast.makeText(this@MainActivity, "Cannot open file picker", Toast.LENGTH_SHORT).show()
            }
            return true
        }
    }

    // ---- Download Handling ----

    private inner class MusicFlowDownloadListener : DownloadListener {
        override fun onDownloadStart(
            url: String?,
            userAgent: String?,
            contentDisposition: String?,
            mimeType: String?,
            contentLength: Long
        ) {
            if (url == null) return

            try {
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimeType)
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
                    setTitle(filename)
                    setDescription("Downloading $filename")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "MusicFlow/$filename")
                }

                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this@MainActivity, "Downloading: $filename", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---- Native Bridge ----

    private fun injectNativeBridge() {
        val js = """
        (function() {
            if (window._musicFlowBridgeInjected) return;
            window._musicFlowBridgeInjected = true;
            
            // Listen for media session metadata changes and forward to native
            var origSetMetadata = null;
            if (navigator.mediaSession) {
                // Override metadata setter to capture updates
                var metaDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
                if (metaDesc && metaDesc.set) {
                    origSetMetadata = metaDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'metadata', {
                        set: function(meta) {
                            origSetMetadata.call(this, meta);
                            if (meta && window.MusicFlowAndroid) {
                                try {
                                    window.MusicFlowAndroid.onMediaMetadata(
                                        meta.title || '',
                                        meta.artist || '',
                                        meta.album || '',
                                        (meta.artwork && meta.artwork.length > 0) ? meta.artwork[meta.artwork.length - 1].src : ''
                                    );
                                } catch(e) {}
                            }
                        },
                        get: metaDesc.get ? metaDesc.get.bind(navigator.mediaSession) : function() { return null; },
                        configurable: true
                    });
                }

                // Override playbackState setter
                var stateDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'playbackState');
                if (stateDesc && stateDesc.set) {
                    var origSetState = stateDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'playbackState', {
                        set: function(state) {
                            origSetState.call(this, state);
                            if (window.MusicFlowAndroid) {
                                try {
                                    window.MusicFlowAndroid.onPlaybackStateChanged(state === 'playing');
                                } catch(e) {}
                            }
                        },
                        get: stateDesc.get ? stateDesc.get.bind(navigator.mediaSession) : function() { return 'none'; },
                        configurable: true
                    });
                }
            }
            
            // Monitor audio elements for play/pause events
            function monitorAudio(audio) {
                if (audio._mfMonitored) return;
                audio._mfMonitored = true;
                audio.addEventListener('play', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(true); } catch(e) {}
                    }
                });
                audio.addEventListener('pause', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(false); } catch(e) {}
                    }
                });
                audio.addEventListener('ended', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(false); } catch(e) {}
                    }
                });
            }
            
            // Monitor existing and future audio elements
            document.querySelectorAll('audio').forEach(monitorAudio);
            var origCreate = document.createElement;
            document.createElement = function(tag) {
                var el = origCreate.call(document, tag);
                if (tag.toLowerCase() === 'audio') {
                    setTimeout(function() { monitorAudio(el); }, 0);
                }
                return el;
            };
        })();
        """.trimIndent()

        webView.evaluateJavascript(js, null)
    }

    @Suppress("unused")
    inner class WebAppInterface {

        @JavascriptInterface
        fun onMediaMetadata(title: String, artist: String, album: String, artworkUrl: String) {
            playbackService?.updateMetadata(title, artist, album, artworkUrl)
        }

        @JavascriptInterface
        fun onPlaybackStateChanged(isPlaying: Boolean) {
            if (isPlaying) {
                playbackService?.startPlayback()
            } else {
                playbackService?.pausePlayback()
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return BuildConfig.VERSION_NAME
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean {
            return true
        }
    }

    // ---- Receivers for commands from PlaybackService and media buttons ----

    private val webViewCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.musicflow.player.WEBVIEW_COMMAND") {
                val js = intent.getStringExtra("js") ?: return
                runOnUiThread {
                    webView.evaluateJavascript(js, null)
                }
            }
        }
    }

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
                val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }

                if (keyEvent?.action == KeyEvent.ACTION_DOWN) {
                    when (keyEvent.keyCode) {
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                        KeyEvent.KEYCODE_HEADSETHOOK -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_NEXT -> {
                            webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                            webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PLAY -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                    }
                }
            }
        }
    }

    // ---- Lifecycle ----

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()

        // Register WebView command receiver (for PlaybackService notification actions)
        val cmdFilter = IntentFilter("com.musicflow.player.WEBVIEW_COMMAND")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(webViewCommandReceiver, cmdFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(webViewCommandReceiver, cmdFilter)
        }

        // Register media button receiver
        val mediaFilter = IntentFilter(Intent.ACTION_MEDIA_BUTTON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(mediaButtonReceiver, mediaFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(mediaButtonReceiver, mediaFilter)
        }
    }

    override fun onPause() {
        super.onPause()
        // Don't pause WebView timers — we need background playback
        try { unregisterReceiver(webViewCommandReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(mediaButtonReceiver) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        webView.destroy()
    }

    // ---- Back button handling ----

    @Deprecated("Deprecated in API 33+")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    // ---- Hardware key handling for media buttons ----

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_HEADSETHOOK -> {
                webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    // ---- File chooser result ----

    @Deprecated("Deprecated in API 33+")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                val results = mutableListOf<Uri>()

                // Handle multiple selection
                data.clipData?.let { clipData ->
                    for (i in 0 until clipData.itemCount) {
                        results.add(clipData.getItemAt(i).uri)
                    }
                } ?: data.data?.let { uri ->
                    results.add(uri)
                }

                fileUploadCallback?.onReceiveValue(results.toTypedArray())
            } else {
                fileUploadCallback?.onReceiveValue(null)
            }
            fileUploadCallback = null
        }
    }

    // ---- Permission results ----

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        when (requestCode) {
            PERMISSION_REQUEST_STORAGE -> {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    pendingDownloadUrl?.let { url ->
                        // Retry the download
                        webView.loadUrl(url)
                        pendingDownloadUrl = null
                    }
                }
            }
        }
    }
}
