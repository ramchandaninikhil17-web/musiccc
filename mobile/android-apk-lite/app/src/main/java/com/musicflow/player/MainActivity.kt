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
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.util.Log
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
import android.media.MediaScannerConnection
import android.util.Base64
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.palette.graphics.Palette
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        const val LOCAL_PORT = 8765
        const val LOCAL_URL = "http://127.0.0.1:$LOCAL_PORT"
        private const val PERMISSION_REQUEST_NOTIFICATION = 1001
    }

    private lateinit var webView: WebView
    private lateinit var offlineView: LinearLayout
    private lateinit var retryButton: Button

    private var localServer: LocalServer? = null
    private var playbackService: PlaybackService? = null
    private var serviceBound = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var hasLoadedOnce = false

    private val executor = Executors.newSingleThreadExecutor()

    // File picker launcher using modern Activity Result API
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri>? ->
        fileUploadCallback?.onReceiveValue(uris?.toTypedArray())
        fileUploadCallback = null
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            if (service is PlaybackService.LocalBinder) {
                playbackService = service.getService()
                serviceBound = true
                Log.i(TAG, "Connected to PlaybackService")
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService = null
            serviceBound = false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full display cutout mode: punch hole and notch metrics are accurately resolved
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#0B0E14")
        window.navigationBarColor = Color.parseColor("#0B0E14")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_main)

        // Safe insets listener ensures WebView never overlaps camera punch hole or status bar
        val rootLayout = findViewById<FrameLayout>(R.id.rootLayout)
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val navInsets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
            view.setPadding(insets.left, insets.top, insets.right, navInsets.bottom)
            windowInsets
        }

        webView = findViewById(R.id.webView)
        offlineView = findViewById(R.id.offlineView)
        retryButton = findViewById(R.id.retryButton)

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        setupWebView()
        retryButton.setOnClickListener { startServerAndLoad() }
        requestNotificationPermission()

        // Bind Foreground PlaybackService for native background audio & lock-screen controls
        Intent(this, PlaybackService::class.java).also { intent ->
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            startService(intent)
        }

        startServerAndLoad()
    }

    // ── Local Embedded Standalone Server ──

    private fun startServerAndLoad() {
        offlineView.visibility = View.GONE
        webView.visibility = View.VISIBLE

        executor.execute {
            try {
                localServer?.stop()
                localServer = LocalServer(this@MainActivity, LOCAL_PORT)
                localServer?.start()
                Log.i(TAG, "Standalone on-device server running on port $LOCAL_PORT")

                Thread.sleep(250)

                runOnUiThread {
                    webView.loadUrl(LOCAL_URL)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start local server: ${e.message}", e)
                runOnUiThread {
                    Toast.makeText(this, "Server start error: ${e.message}", Toast.LENGTH_LONG).show()
                    showOffline()
                }
            }
        }
    }

    // ── WebView Setup ──

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
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = webView.settings.userAgentString + " MusicFlowAndroid/3.5 (Standalone; SpotifyStyle)"
        }

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.addJavascriptInterface(WebAppInterface(), "MusicFlowAndroid")
        webView.webViewClient = MusicFlowWebViewClient()
        webView.webChromeClient = MusicFlowChromeClient()
        webView.setDownloadListener(MusicFlowDownloadListener())
    }

    private fun showOffline() {
        webView.visibility = View.GONE
        offlineView.visibility = View.VISIBLE
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

    // ── Dynamic Dominant-Color Extraction (Album Art → Palette) ──

    private fun extractDominantColor(artworkUrl: String) {
        if (artworkUrl.isEmpty()) return
        executor.execute {
            try {
                val resolvedUrl = if (artworkUrl.startsWith("//")) "https:$artworkUrl"
                else if (artworkUrl.startsWith("/")) "http://127.0.0.1:$LOCAL_PORT$artworkUrl"
                else artworkUrl
                val stream = URL(resolvedUrl).openStream()
                val bitmap = BitmapFactory.decodeStream(stream)
                stream.close()

                if (bitmap != null) {
                    Palette.from(bitmap).generate { palette ->
                        val vibrant = palette?.vibrantSwatch ?: palette?.dominantSwatch
                        if (vibrant != null) {
                            val colorHex = String.format("#%06X", (0xFFFFFF and vibrant.rgb))
                            runOnUiThread {
                                webView.evaluateJavascript(
                                    """
                                    (function() {
                                        if (document.documentElement) {
                                            document.documentElement.style.setProperty('--dominant-color', '$colorHex');
                                        }
                                        var glow = document.getElementById('sfpArtGlow');
                                        if (glow) {
                                            glow.style.background = 'radial-gradient(circle, $colorHex 0%, transparent 70%)';
                                        }
                                        var fullPlayer = document.getElementById('spotifyFullscreenPlayer');
                                        if (fullPlayer) {
                                            fullPlayer.style.background = 'linear-gradient(180deg, ${colorHex}44 0%, #0B0E14 65%)';
                                        }
                                    })();
                                    """.trimIndent(),
                                    null
                                )
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Palette extract notice: ${e.message}")
            }
        }
    }

    // ── WebView Clients ──

    private inner class MusicFlowWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            hasLoadedOnce = true
            injectNativeBridge()
        }

        override fun onReceivedError(
            view: WebView?, request: WebResourceRequest?, error: WebResourceError?
        ) {
            if (request?.isForMainFrame == true && !hasLoadedOnce) {
                showOffline()
            }
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?, request: WebResourceRequest?
        ): Boolean {
            val url = request?.url?.toString() ?: return false
            if (url.startsWith(LOCAL_URL) || url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
                return false
            }
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) {}
            return true
        }
    }

    private inner class MusicFlowChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = filePathCallback
            filePickerLauncher.launch("audio/*")
            return true
        }
    }

    // ── Native Downloads ──

    private inner class MusicFlowDownloadListener : DownloadListener {
        override fun onDownloadStart(
            url: String?, userAgent: String?, contentDisposition: String?,
            mimeType: String?, contentLength: Long
        ) {
            if (url == null) return
            try {
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType ?: "audio/mpeg")
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimeType ?: "audio/mpeg")
                    addRequestHeader("User-Agent", userAgent)
                    setTitle(filename)
                    setDescription("Downloading $filename to Music")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "MusicFlow/$filename")
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this@MainActivity, "⬇ Downloading to Music/MusicFlow: $filename", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Native Bridge Injection ──

    private fun injectNativeBridge() {
        val js = """
        (function() {
            if (window._musicFlowNativeBridgeInjected) return;
            window._musicFlowNativeBridgeInjected = true;

            // Signal to web app that it is running inside the Android APK shell
            document.documentElement.classList.add('is-mobile-app');
            if (document.body) document.body.classList.add('is-mobile-app');

            // Hook MediaSession metadata and playbackState for native track synchronization
            if (navigator.mediaSession) {
                var metaDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
                if (metaDesc && metaDesc.set) {
                    var origSetMeta = metaDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'metadata', {
                        set: function(meta) {
                            origSetMeta.call(this, meta);
                            if (meta && window.MusicFlowAndroid) {
                                try {
                                    var art = (meta.artwork && meta.artwork.length > 0) ? meta.artwork[meta.artwork.length - 1].src : '';
                                    var dur = (window.audioPlayer && window.audioPlayer.duration) ? Math.round(window.audioPlayer.duration * 1000) : 0;
                                    window.MusicFlowAndroid.updateMetadata(
                                        meta.title || '',
                                        meta.artist || '',
                                        meta.album || '',
                                        art,
                                        dur
                                    );
                                } catch(e) {}
                            }
                        },
                        get: metaDesc.get ? metaDesc.get.bind(navigator.mediaSession) : function() { return null; },
                        configurable: true
                    });
                }

                var stateDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'playbackState');
                if (stateDesc && stateDesc.set) {
                    var origSetState = stateDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'playbackState', {
                        set: function(state) {
                            origSetState.call(this, state);
                            if (window.MusicFlowAndroid) {
                                window.MusicFlowAndroid.updatePlaybackState(state === 'playing');
                            }
                        },
                        get: stateDesc.get ? stateDesc.get.bind(navigator.mediaSession) : function() { return 'none'; },
                        configurable: true
                    });
                }

                if (typeof navigator.mediaSession.setPositionState === 'function') {
                    var origSetPos = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
                    navigator.mediaSession.setPositionState = function(state) {
                        origSetPos(state);
                        if (window.MusicFlowAndroid && state) {
                            try {
                                var posMs = Math.round((state.position || 0) * 1000);
                                var durMs = Math.round((state.duration || 0) * 1000);
                                window.MusicFlowAndroid.updatePosition(posMs, durMs);
                            } catch(e) {}
                        }
                    };
                }
            }
        })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    // ── JavaScript Interface Exposing Native Android Engine ──

    @Suppress("unused")
    inner class WebAppInterface {
        @JavascriptInterface
        fun updatePlaybackState(playing: Boolean) {
            runOnUiThread {
                if (playing) {
                    playbackService?.startPlayback()
                } else {
                    playbackService?.pausePlayback()
                }
            }
        }

        @JavascriptInterface
        fun updateMetadata(title: String, artist: String, album: String, artworkUrl: String, durationMs: Long) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl, durationMs)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun updatePosition(posMs: Long, durMs: Long) {
            runOnUiThread {
                playbackService?.updatePosition(posMs, durMs)
            }
        }

        @JavascriptInterface
        fun onTrackChange(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun playTrack(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun pauseTrack() {
            runOnUiThread { playbackService?.pausePlayback() }
        }

        @JavascriptInterface
        fun resumeTrack() {
            runOnUiThread { playbackService?.startPlayback() }
        }

        @JavascriptInterface
        fun togglePlayPause() {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
            }
        }

        @JavascriptInterface
        fun seekTo(positionSec: Float) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof audioPlayer!=='undefined'&&audioPlayer){audioPlayer.currentTime=$positionSec;}", null)
            }
        }

        @JavascriptInterface
        fun setPlaybackSpeed(speed: Float) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof audioPlayer!=='undefined'&&audioPlayer){audioPlayer.playbackRate=$speed;}", null)
            }
        }

        @JavascriptInterface
        fun setSleepTimer(minutes: Int) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof SleepTimerManager!=='undefined'&&SleepTimerManager.setDuration){SleepTimerManager.setDuration($minutes);}", null)
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String = "3.5.0-HyperFlow"

        @JavascriptInterface
        fun getVersionCode(): Int = 350

        @JavascriptInterface
        fun startNativeDownload(url: String, title: String, artist: String) {
            val isVideo = url.contains("format=video")
            val format = if (isVideo) "video" else "audio"
            val quality = if (isVideo) "1080" else "192"
            startNativeDownloadAdvanced(url, title, artist, format, quality)
        }

        @JavascriptInterface
        fun startNativeDownloadAdvanced(url: String, title: String, artist: String, format: String, quality: String) {
            runOnUiThread {
                try {
                    val isVideo = format.equals("video", ignoreCase = true) || url.contains("format=video")
                    val ext = if (isVideo) "mp4" else "mp3"
                    val mime = if (isVideo) "video/mp4" else "audio/mpeg"
                    val subDir = if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_MUSIC
                    val safeTitle = (title.ifEmpty { "Media" }).replace(Regex("[^a-zA-Z0-9 _.-]"), "").trim()
                    val filename = "$safeTitle.$ext"

                    val resolvedUrl = if (url.startsWith("/")) {
                        "http://127.0.0.1:${LOCAL_PORT}$url"
                    } else url

                    val request = DownloadManager.Request(Uri.parse(resolvedUrl)).apply {
                        setMimeType(mime)
                        setTitle(safeTitle)
                        setDescription("Downloading $safeTitle (${if (isVideo) "Video $quality p" else "Audio $quality kbps"})")
                        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(subDir, "MusicFlow/$filename")
                    }
                    val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                    manager.enqueue(request)
                    Toast.makeText(this@MainActivity, "⬇ Downloading to ${if (isVideo) "Movies" else "Music"}/MusicFlow: $filename", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Log.w(TAG, "Native download trigger notice: ${e.message}")
                    Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface
        fun installAppUpdate(apkUrl: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, "⏳ Starting 1-Click Update...", Toast.LENGTH_SHORT).show()
            }
            executor.execute {
                try {
                    val resolvedUrl = if (apkUrl.startsWith("/")) "http://127.0.0.1:${LOCAL_PORT}$apkUrl" else apkUrl
                    val client = okhttp3.OkHttpClient.Builder()
                        .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                        .build()

                    val request = okhttp3.Request.Builder().url(resolvedUrl).build()
                    val response = client.newCall(request).execute()
                    if (!response.isSuccessful) {
                        runOnUiThread { Toast.makeText(this@MainActivity, "Update download failed (HTTP ${response.code})", Toast.LENGTH_LONG).show() }
                        return@execute
                    }

                    val apkFile = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "MusicFlow_update.apk")
                    response.body?.byteStream()?.use { input ->
                        FileOutputStream(apkFile).use { output ->
                            input.copyTo(output)
                        }
                    }

                    runOnUiThread {
                        try {
                            val apkUri = FileProvider.getUriForFile(
                                this@MainActivity,
                                "${applicationContext.packageName}.fileprovider",
                                apkFile
                            )
                            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(apkUri, "application/vnd.android.package-archive")
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                            }
                            startActivity(installIntent)
                            Toast.makeText(this@MainActivity, "✅ Ready to install! Tap Install to update MusicFlow.", Toast.LENGTH_LONG).show()
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to launch package installer: ${e.message}", e)
                            Toast.makeText(this@MainActivity, "Could not open installer: ${e.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error downloading update: ${e.message}", e)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Update error: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        @JavascriptInterface
        fun saveTrackToDevice(base64Data: String, filename: String, title: String, artist: String) {
            executor.execute {
                try {
                    val rawBytes = Base64.decode(base64Data, Base64.DEFAULT)
                    val safeFilename = filename.replace(Regex("[^a-zA-Z0-9 _.-]"), "").ifEmpty { "song_${System.currentTimeMillis()}.mp3" }

                    val musicDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MusicFlow")
                    if (!musicDir.exists()) musicDir.mkdirs()

                    val targetFile = File(musicDir, safeFilename)
                    FileOutputStream(targetFile).use { fos ->
                        fos.write(rawBytes)
                        fos.flush()
                    }

                    MediaScannerConnection.scanFile(
                        this@MainActivity,
                        arrayOf(targetFile.absolutePath),
                        arrayOf("audio/mpeg")
                    ) { path, uri ->
                        Log.i(TAG, "MediaScanner indexed: $path -> $uri")
                    }

                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "✅ Saved: $safeFilename in Music/MusicFlow", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to save to public Music dir: ${e.message}", e)
                    try {
                        val fallbackDir = getExternalFilesDir(Environment.DIRECTORY_MUSIC)
                        val safeFilename = filename.replace(Regex("[^a-zA-Z0-9 _.-]"), "").ifEmpty { "song_${System.currentTimeMillis()}.mp3" }
                        val targetFile = File(fallbackDir, safeFilename)
                        FileOutputStream(targetFile).use { it.write(Base64.decode(base64Data, Base64.DEFAULT)) }
                        runOnUiThread {
                            Toast.makeText(this@MainActivity, "✅ Saved to Offline Storage: $safeFilename", Toast.LENGTH_SHORT).show()
                        }
                    } catch (e2: Exception) {
                        Log.e(TAG, "Fallback save failed: ${e2.message}", e2)
                    }
                }
            }
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun isStandalone(): Boolean = true
    }

    // ── Broadcast Receivers (Notification & Hardware Media Buttons) ──

    private val webViewCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.musicflow.player.WEBVIEW_COMMAND") {
                val js = intent.getStringExtra("js") ?: return
                runOnUiThread { webView.evaluateJavascript(js, null) }
            }
        }
    }

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
                val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }
                if (keyEvent?.action == KeyEvent.ACTION_DOWN) {
                    when (keyEvent.keyCode) {
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK ->
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        KeyEvent.KEYCODE_MEDIA_NEXT ->
                            webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS ->
                            webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                    }
                }
            }
        }
    }

    // ── Lifecycle ──

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()

        val cmdFilter = IntentFilter("com.musicflow.player.WEBVIEW_COMMAND")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(webViewCommandReceiver, cmdFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(webViewCommandReceiver, cmdFilter)
        }

        val mediaFilter = IntentFilter(Intent.ACTION_MEDIA_BUTTON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(mediaButtonReceiver, mediaFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(mediaButtonReceiver, mediaFilter)
        }
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(webViewCommandReceiver) } catch (e: Exception) {}
        try { unregisterReceiver(mediaButtonReceiver) } catch (e: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        localServer?.stop()
        localServer = null
        webView.destroy()
        executor.shutdown()
    }

    @Deprecated("Deprecated in API 33+")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
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
}
