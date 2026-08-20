using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MusicFlow
{
    static class Program
    {
        // The server walks upward from 3000 when a port is taken, so the
        // launcher never assumes a fixed port. It reads data/runtime.json
        // first and falls back to probing this range.
        private const int FirstPort = 3000;
        private const int LastPort = 3010;

        // Node cold start on a slow disk can take several seconds. The loop
        // exits the instant the server answers, so a generous ceiling costs
        // nothing on a fast machine.
        private const int StartupTimeoutMs = 30000;
        private const int PollIntervalMs = 50;

        [STAThread]
        static void Main()
        {
            // Guards the impatient double-click. Without this, two launchers
            // race: both see no server, both spawn node, the loser dies on
            // EADDRINUSE, and the user gets two windows.
            bool isFirstInstance;
            using (Mutex launchLock = new Mutex(true, @"Local\MusicFlowLauncher", out isFirstInstance))
            {
                if (!isFirstInstance) return;
                try
                {
                    Launch();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Failed to launch MusicFlow: " + ex.Message,
                        "MusicFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static void Launch()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(appDir);

            // 1. Already running? Open the window immediately.
            int port = FindRunningServer(appDir);

            if (port == 0)
            {
                EnsureDependencies(appDir);
                StartServer(appDir);

                Stopwatch clock = Stopwatch.StartNew();
                while (clock.ElapsedMilliseconds < StartupTimeoutMs)
                {
                    Thread.Sleep(PollIntervalMs);
                    port = FindRunningServer(appDir);
                    if (port != 0) break;
                }
            }

            if (port == 0)
            {
                MessageBox.Show(
                    "MusicFlow's server did not start within " + (StartupTimeoutMs / 1000) + " seconds.\r\n\r\n" +
                    "Check that Node.js is installed, then try running start.bat in\r\n" + appDir +
                    "\r\nto see the error.",
                    "MusicFlow", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            OpenAppWindow("http://localhost:" + port + "/?autoplay=1");
        }

        /// <summary>
        /// Returns the port a live MusicFlow server is listening on, or 0.
        /// Checks data/runtime.json first (instant), then probes the range.
        /// </summary>
        private static int FindRunningServer(string appDir)
        {
            int hinted = ReadPortHint(appDir);
            if (hinted != 0 && IsMusicFlowOn(hinted)) return hinted;

            for (int p = FirstPort; p <= LastPort; p++)
            {
                if (p == hinted) continue;
                if (IsMusicFlowOn(p)) return p;
            }
            return 0;
        }

        private static int ReadPortHint(string appDir)
        {
            try
            {
                string file = Path.Combine(appDir, "data", "runtime.json");
                if (!File.Exists(file)) return 0;
                string json = File.ReadAllText(file);
                int i = json.IndexOf("\"port\"", StringComparison.OrdinalIgnoreCase);
                if (i < 0) return 0;
                i = json.IndexOf(':', i);
                if (i < 0) return 0;
                StringBuilder digits = new StringBuilder();
                for (int j = i + 1; j < json.Length; j++)
                {
                    char c = json[j];
                    if (char.IsDigit(c)) digits.Append(c);
                    else if (digits.Length > 0) break;
                }
                int port;
                if (int.TryParse(digits.ToString(), out port)) return port;
            }
            catch { }
            return 0;
        }

        /// <summary>
        /// A 200 from /api/health is not enough — some other dev server could
        /// own the port. The body must identify itself as MusicFlow.
        /// </summary>
        private static bool IsMusicFlowOn(int port)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + port + "/api/health");
                request.Timeout = 700;
                request.ReadWriteTimeout = 700;
                request.Method = "GET";
                request.Proxy = null; // proxy autodetect adds hundreds of ms
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK) return false;
                    using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        return body.IndexOf("musicflow", StringComparison.OrdinalIgnoreCase) >= 0;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static void EnsureDependencies(string appDir)
        {
            if (Directory.Exists(Path.Combine(appDir, "node_modules"))) return;
            try
            {
                // npm is a .cmd shim, which cannot be started directly with
                // UseShellExecute = false — it has to go through cmd.exe.
                ProcessStartInfo npm = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c npm install",
                    WorkingDirectory = appDir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(npm))
                {
                    if (p != null) p.WaitForExit(300000);
                }
            }
            catch { }
        }

        private static void StartServer(string appDir)
        {
            ProcessStartInfo server = new ProcessStartInfo
            {
                FileName = FindNodeExecutable(appDir),
                Arguments = "server.js",
                WorkingDirectory = appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(server);
        }

        private static void OpenAppWindow(string url)
        {
            string browser = FindBrowserExecutable();
            if (string.IsNullOrEmpty(browser))
            {
                Process.Start(url);
                return;
            }

            string profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MusicFlowAppData");

            // --autoplay-policy is what actually lets the resumed track start
            // without a click. Chrome and Edge otherwise block play() until the
            // site has earned enough Media Engagement, which is unpredictable.
            // A dedicated profile keeps that relaxed policy off the main browser.
            string args =
                "--app=\"" + url + "\"" +
                " --user-data-dir=\"" + profile + "\"" +
                " --autoplay-policy=no-user-gesture-required" +
                " --window-size=1280,820" +
                " --no-first-run" +
                " --no-default-browser-check" +
                " --disable-features=Translate";

            Process.Start(new ProcessStartInfo
            {
                FileName = browser,
                Arguments = args,
                UseShellExecute = true
            });
        }

        private static string FindNodeExecutable(string appDir)
        {
            string local = Path.Combine(appDir, "node.exe");
            if (File.Exists(local)) return local;

            string pf = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe");
            if (File.Exists(pf)) return pf;

            string pfx86 = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe");
            if (File.Exists(pfx86)) return pfx86;

            // nvm-for-windows and similar installs land here.
            string appData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"nvm\node.exe");
            if (File.Exists(appData)) return appData;

            return "node";
        }

        private static string FindBrowserExecutable()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"BraveSoftware\Brave-Browser\Application\brave.exe")
            };

            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }
    }
}
