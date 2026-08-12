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

                // 1. Find Node.js executable
                string nodePath = FindNodeExecutable(appDir);
                if (string.IsNullOrEmpty(nodePath))
                {
                    DialogResult result = MessageBox.Show(
                        "Node.js was not found on your PC.\n\nMusicFlow requires Node.js (LTS version) to run.\n\nWould you like to download and install Node.js now?",
                        "MusicFlow — Node.js Required",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information
                    );
                    if (result == DialogResult.Yes)
                    {
                        Process.Start("https://nodejs.org/");
                    }
                    return;
                }

                // 2. Check if node_modules exists; if not, run npm install
                string nodeModulesDir = Path.Combine(appDir, "node_modules");
                if (!Directory.Exists(nodeModulesDir))
                {
                    string npmPath = FindNpmExecutable();
                    if (!string.IsNullOrEmpty(npmPath))
                    {
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
                        if (npmProcess != null)
                        {
                            npmProcess.WaitForExit();
                        }
                    }
                }

                // 3. Find active server port (3000-3010)
                string activeUrl = GetActiveServerUrl();

                if (string.IsNullOrEmpty(activeUrl))
                {
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

                    int retries = 50;
                    while (retries-- > 0 && string.IsNullOrEmpty(activeUrl))
                    {
                        Thread.Sleep(200);
                        activeUrl = GetActiveServerUrl();
                    }
                }

                if (string.IsNullOrEmpty(activeUrl)) activeUrl = AppUrl;

                // 4. Launch Edge App Mode or Chrome App Mode or Default Browser
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

            string[] possiblePaths = new string[]
            {
                "node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"npm\node.exe")
            };

            foreach (string p in possiblePaths)
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = p,
                        Arguments = "--version",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using (Process proc = Process.Start(psi))
                    {
                        if (proc != null)
                        {
                            proc.WaitForExit(1500);
                            if (proc.ExitCode == 0) return p;
                        }
                    }
                }
                catch { }
            }
            return null;
        }

        private static string FindNpmExecutable()
        {
            string[] possiblePaths = new string[]
            {
                "npm.cmd",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\npm.cmd"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\npm.cmd"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"npm\npm.cmd")
            };

            foreach (string p in possiblePaths)
            {
                if (File.Exists(p) || p == "npm.cmd")
                {
                    return p;
                }
            }
            return "npm.cmd";
        }

        private static string FindBrowserExecutable()
        {
            string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(edge)) return edge;

            edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(edge)) return edge;

            string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(chrome)) return chrome;

            chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(chrome)) return chrome;

            return null;
        }

        private static string GetActiveServerUrl()
        {
            for (int port = 3000; port <= 3010; port++)
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
                request.Timeout = 800;
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
