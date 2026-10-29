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
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.palette.graphics.Palette
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity(), PlaybackService.PlaybackEventListener {

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
                playbackService?.playbackListener = this@MainActivity
                serviceBound = true
                Log.i(TAG, "Connected to Media3 PlaybackService")
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService?.playbackListener = null
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

        // Bind Media3 PlaybackService for native background audio & lock-screen controls
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
            userAgentString = webView.settings.userAgentString + " MusicFlowAndroid/3.0 (Standalone; Media3)"
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

    // ── PlaybackService Event Listener Callbacks (ExoPlayer → WebView UI) ──

    override fun onPlaybackStateChanged(isPlaying: Boolean) {
        runOnUiThread {
            webView.evaluateJavascript(
                "if (window.MusicFlowAndroidBridge && window.MusicFlowAndroidBridge.onStateChanged) { window.MusicFlowAndroidBridge.onStateChanged($isPlaying); }",
                null
            )
        }
    }

    override fun onPositionUpdate(positionMs: Long, durationMs: Long, bufferedMs: Long) {
        runOnUiThread {
            webView.evaluateJavascript(
                "if (window.MusicFlowAndroidBridge && window.MusicFlowAndroidBridge.onPositionUpdate) { window.MusicFlowAndroidBridge.onPositionUpdate($positionMs, $durationMs, $bufferedMs); }",
                null
            )
        }
    }

    override fun onTrackEnded() {
        runOnUiThread {
            webView.evaluateJavascript(
                "if (window.MusicFlowAndroidBridge && window.MusicFlowAndroidBridge.onTrackEnded) { window.MusicFlowAndroidBridge.onTrackEnded(); }",
                null
            )
        }
    }

    override fun onError(error: String) {
        runOnUiThread {
            Log.w(TAG, "Playback error: $error")
        }
    }

    // ── Dynamic Dominant-Color Extraction (Album Art → Palette) ──

    private fun extractDominantColor(artworkUrl: String) {
        if (artworkUrl.isEmpty()) return
        executor.execute {
            try {
                val resolvedUrl = if (artworkUrl.startsWith("//")) "https:$artworkUrl" else artworkUrl
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
            if (window._musicFlowNativeExoBridge) return;
            window._musicFlowNativeExoBridge = true;

            // Global bridge receiver from native ExoPlayer Media3
            window.MusicFlowAndroidBridge = {
                onPositionUpdate: function(posMs, durMs, bufMs) {
                    var curSec = posMs / 1000.0;
                    var durSec = durMs / 1000.0;
                    
                    if (typeof SpotifyMobileController !== 'undefined' && SpotifyMobileController.syncTime) {
                        SpotifyMobileController.syncTime(curSec, durSec);
                    }
                    
                    var curEl = document.getElementById('sfpCurrentTime');
                    var durEl = document.getElementById('sfpDuration');
                    var fillEl = document.getElementById('sfpScrubberFill');
                    var thumbEl = document.getElementById('sfpScrubberThumb');
                    
                    if (curEl && typeof fmtTime === 'function') curEl.textContent = fmtTime(curSec);
                    if (durEl && durSec > 0 && typeof fmtTime === 'function') durEl.textContent = fmtTime(durSec);
                    if (durSec > 0 && fillEl && thumbEl) {
                        var pct = Math.min(100, Math.max(0, (curSec / durSec) * 100));
                        fillEl.style.width = pct + '%';
                        thumbEl.style.left = pct + '%';
                    }
                    
                    // Mini player bar sync
                    var npCurrent = document.getElementById('npCurrentTime');
                    var npDur = document.getElementById('npDuration');
                    var npBarFill = document.getElementById('npProgressFill');
                    if (npCurrent && typeof fmtTime === 'function') npCurrent.textContent = fmtTime(curSec);
                    if (npDur && durSec > 0 && typeof fmtTime === 'function') npDur.textContent = fmtTime(durSec);
                    if (durSec > 0 && npBarFill) {
                        npBarFill.style.width = Math.min(100, (curSec / durSec) * 100) + '%';
                    }
                    
                    // Synced lyrics highlight sync
                    if (typeof window.syncLyricsScroll === 'function') {
                        window.syncLyricsScroll(curSec);
                    }
                },
                onStateChanged: function(isPlaying) {
                    if (typeof setPlayState === 'function') {
                        setPlayState(isPlaying);
                    }
                    if (typeof SpotifyMobileController !== 'undefined' && SpotifyMobileController.syncPlayState) {
                        SpotifyMobileController.syncPlayState(isPlaying);
                    }
                },
                onTrackEnded: function() {
                    if (typeof playNext === 'function') {
                        playNext();
                    }
                }
            };

            // Hook MediaSession metadata for native track synchronization
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
                                    var audio = document.getElementById('audioPlayer');
                                    var src = audio ? (audio.currentSrc || audio.src || '') : '';
                                    var songId = (window.currentSong && window.currentSong.id) || '';
                                    window.MusicFlowAndroid.onTrackChange(
                                        songId,
                                        meta.title || '',
                                        meta.artist || '',
                                        meta.album || '',
                                        art,
                                        src
                                    );
                                } catch(e) {}
                            }
                        },
                        get: metaDesc.get ? metaDesc.get.bind(navigator.mediaSession) : function() { return null; },
                        configurable: true
                    });
                }
            }
        })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    // ── JavaScript Interface Exposing Native Media3 Engine ──

    @Suppress("unused")
    inner class WebAppInterface {
        @JavascriptInterface
        fun onTrackChange(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.playTrack(id, title, artist, album, artworkUrl, streamUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun playTrack(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.playTrack(id, title, artist, album, artworkUrl, streamUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun pauseTrack() {
            runOnUiThread { playbackService?.pause() }
        }

        @JavascriptInterface
        fun resumeTrack() {
            runOnUiThread { playbackService?.resume() }
        }

        @JavascriptInterface
        fun togglePlayPause() {
            runOnUiThread { playbackService?.togglePlayPause() }
        }

        @JavascriptInterface
        fun seekTo(positionSec: Float) {
            runOnUiThread { playbackService?.seekTo((positionSec * 1000).toLong()) }
        }

        @JavascriptInterface
        fun setPlaybackSpeed(speed: Float) {
            runOnUiThread { playbackService?.setPlaybackSpeed(speed) }
        }

        @JavascriptInterface
        fun setSleepTimer(minutes: Int) {
            runOnUiThread { playbackService?.setSleepTimer(minutes) }
        }

        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun startNativeDownload(url: String, title: String, artist: String) {
            runOnUiThread {
                try {
                    val safeTitle = (title.ifEmpty { "Song" }).replace(Regex("[^a-zA-Z0-9 _.-]"), "").trim()
                    val filename = "$safeTitle.mp3"
                    val resolvedUrl = if (url.startsWith("/")) {
                        "http://127.0.0.1:${LOCAL_PORT}$url"
                    } else url

                    val request = DownloadManager.Request(Uri.parse(resolvedUrl)).apply {
                        setMimeType("audio/mpeg")
                        setTitle(safeTitle)
                        setDescription("Downloading $safeTitle")
                        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "MusicFlow/$filename")
                    }
                    val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                    manager.enqueue(request)
                    Toast.makeText(this@MainActivity, "⬇ Downloading to Music/MusicFlow: $safeTitle", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Log.w(TAG, "Native download trigger notice: ${e.message}")
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
            playbackService?.playbackListener = null
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
                playbackService?.togglePlayPause()
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
