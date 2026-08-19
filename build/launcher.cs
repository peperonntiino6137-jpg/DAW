// DAW 起動用ランチャー。
// アプリの全ファイルをリソースとして内蔵し、起動時に %LOCALAPPDATA%\DAW\app へ
// 展開してから Chrome のアプリモードで開く（Edge は使わない）。exe 1 個で配布できる。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

static class Launcher
{
    static void Main()
    {
        var asm = Assembly.GetExecutingAssembly();
        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DAW", "app");

        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }

        foreach (string name in asm.GetManifestResourceNames())
        {
            string dest = Path.Combine(dir, name.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            using (var s = asm.GetManifestResourceStream(name))
            using (var f = File.Create(dest))
                s.CopyTo(f);
        }

        string url = new Uri(Path.Combine(dir, "index.html")).AbsoluteUri;
        string[] browsers =
        {
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string b in browsers)
        {
            if (File.Exists(b))
            {
                Process.Start(b, "--app=\"" + url + "\"");
                return;
            }
        }
        Process.Start(url); // フォールバック: 既定ブラウザの通常タブで開く
    }
}
