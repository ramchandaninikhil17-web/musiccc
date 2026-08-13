using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace MusicFlow
{
    static class Program
    {
        private const string AppUrl = "http://localhost:3000";

        [STAThread]
        static void Main()
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                Directory.SetCurrentDirectory(appDir);

                // 1. Fast Server Health Check: If already running, launch instantly!
                string activeUrl = GetActiveServerUrl();

                if (string.IsNullOrEmpty(activeUrl))
                {
                    // Find Node.js executable
                    string nodePath = FindNodeExecutable(appDir);
                    if (string.IsNullOrEmpty(nodePath))
                    {
                        nodePath = "node";
                    }

                    // Check if node_modules exists; if not, run npm install
                    string nodeModulesDir = Path.Combine(appDir, "node_modules");
                    if (!Directory.Exists(nodeModulesDir))
                    {
                        string npmPath = FindNpmExecutable();
                        ProcessStartInfo npmStart = new ProcessStartInfo
                        {
                            FileName = npmPath,
                            Arguments = "install",
                            WorkingDirectory = appDir,
                            CreateNoWindow = false,
                            UseShellExecute = true,
                            WindowStyle = ProcessWindowStyle.Normal
                        };
                        Process npmProcess = Process.Start(npmStart);
                        if (npmProcess != null) npmProcess.WaitForExit();
                    }

                    // Spawn node server.js silently
                    ProcessStartInfo serverStart = new ProcessStartInfo
                    {
                        FileName = nodePath,
                        Arguments = "server.js",
                        WorkingDirectory = appDir,
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };

                    Process.Start(serverStart);

                    // Poll health endpoint every 50ms up to 60 times (3s max)
                    int retries = 60;
                    while (retries-- > 0 && string.IsNullOrEmpty(activeUrl))
                    {
                        Thread.Sleep(50);
                        activeUrl = GetActiveServerUrl();
                    }
                }

                if (string.IsNullOrEmpty(activeUrl)) activeUrl = AppUrl;

                // 2. Launch Edge App Mode or Chrome App Mode or Default Browser
                string browserPath = FindBrowserExecutable();
                if (!string.IsNullOrEmpty(browserPath))
                {
                    string userDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MusicFlowAppData");
                    string args = string.Format("--app=\"{0}\" --user-data-dir=\"{1}\" --app-id=MusicFlowPlayer", activeUrl, userDataDir);

                    ProcessStartInfo browserStart = new ProcessStartInfo
                    {
                        FileName = browserPath,
                        Arguments = args,
                        UseShellExecute = true
                    };
                    Process.Start(browserStart);
                }
                else
                {
                    Process.Start(activeUrl);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to launch MusicFlow: " + ex.Message, "MusicFlow Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string FindNodeExecutable(string appDir)
        {
            string localNode = Path.Combine(appDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfNode = Path.Combine(pf, @"nodejs\node.exe");
            if (File.Exists(pfNode)) return pfNode;

            string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string pfxNode = Path.Combine(pfx86, @"nodejs\node.exe");
            if (File.Exists(pfxNode)) return pfxNode;

            return "node";
        }

        private static string FindNpmExecutable()
        {
            return "npm.cmd";
        }

        private static string FindBrowserExecutable()
        {
            string edge86 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(edge86)) return edge86;

            string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(edge)) return edge;

            string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(chrome)) return chrome;

            string chrome86 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(chrome86)) return chrome86;

            return null;
        }

        private static string GetActiveServerUrl()
        {
            for (int port = 3000; port <= 3005; port++)
            {
                string url = string.Format("http://localhost:{0}", port);
                if (IsServerRunning(url)) return url;
            }
            return null;
        }

        private static bool IsServerRunning(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/health");
                request.Timeout = 150;
                request.Method = "GET";
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}
