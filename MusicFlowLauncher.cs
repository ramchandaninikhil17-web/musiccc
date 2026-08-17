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

                // 1. Instant Health Check: If server is already running, open app window IMMEDIATELY (< 50ms)!
                string activeUrl = IsServerRunning(AppUrl) ? AppUrl : null;

                if (string.IsNullOrEmpty(activeUrl))
                {
                    // Find Node.js executable
                    string nodePath = FindNodeExecutable(appDir);

                    // Ensure node_modules exists
                    string nodeModulesDir = Path.Combine(appDir, "node_modules");
                    if (!Directory.Exists(nodeModulesDir))
                    {
                        ProcessStartInfo npmStart = new ProcessStartInfo
                        {
                            FileName = "npm.cmd",
                            Arguments = "install",
                            WorkingDirectory = appDir,
                            CreateNoWindow = true,
                            UseShellExecute = false,
                            WindowStyle = ProcessWindowStyle.Hidden
                        };
                        Process npmProcess = Process.Start(npmStart);
                        if (npmProcess != null) npmProcess.WaitForExit();
                    }

                    // Spawn node server.js in hidden background mode
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

                    // Poll http://localhost:3000/health every 20ms for up to 4 seconds
                    for (int i = 0; i < 200; i++)
                    {
                        Thread.Sleep(20);
                        if (IsServerRunning(AppUrl))
                        {
                            activeUrl = AppUrl;
                            break;
                        }
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

        private static bool IsServerRunning(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/health");
                request.Timeout = 100;
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
