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

                // Check if server is already running
                bool isRunning = IsServerRunning(AppUrl);

                if (!isRunning)
                {
                    // Start Node.js server.js silently
                    ProcessStartInfo serverStart = new ProcessStartInfo
                    {
                        FileName = "node.exe",
                        Arguments = "server.js",
                        WorkingDirectory = appDir,
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };

                    Process serverProcess = Process.Start(serverStart);

                    // Wait for server to be responsive
                    int retries = 30;
                    while (retries-- > 0 && !IsServerRunning(AppUrl))
                    {
                        Thread.Sleep(300);
                    }
                }

                // Launch Edge in App Mode (Lite Native App Window)
                string edgePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
                if (!File.Exists(edgePath))
                {
                    edgePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe");
                }

                if (File.Exists(edgePath))
                {
                    string userDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MusicFlowAppData");
                    string args = string.Format("--app=\"{0}\" --user-data-dir=\"{1}\" --app-id=MusicFlowPlayer", AppUrl, userDataDir);

                    ProcessStartInfo edgeStart = new ProcessStartInfo
                    {
                        FileName = edgePath,
                        Arguments = args,
                        UseShellExecute = true
                    };
                    Process.Start(edgeStart);
                }
                else
                {
                    // Fallback to default browser
                    Process.Start(AppUrl);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to launch MusicFlow: " + ex.Message, "MusicFlow Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static bool IsServerRunning(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 1000;
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
