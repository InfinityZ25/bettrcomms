param([Parameter(Mandatory)][int]$AppProcessId, [switch]$FocusFixture)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CopilotFixtureWindows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  public class Entry { public long Handle; public string Title; public string ClassName; public bool Visible; public long Style; public uint Affinity; public Rect Bounds; public bool Foreground; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Rect rect, int size);
  public static Entry[] Inspect(int appProcess) {
    var entries = new List<Entry>();
    EnumWindows((hwnd, data) => {
      uint process; GetWindowThreadProcessId(hwnd, out process);
      var title = new StringBuilder(256); GetWindowText(hwnd, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(hwnd, cls, cls.Capacity);
      bool fixture = title.ToString().Contains("BetterComms Copilot Fixture");
      bool overlay = process == appProcess && cls.ToString() == "Static";
      if (!fixture && !overlay) return true;
      Rect rect; GetWindowRect(hwnd, out rect);
      if (fixture) DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(Rect)));
      uint affinity; GetWindowDisplayAffinity(hwnd, out affinity);
      entries.Add(new Entry { Handle=hwnd.ToInt64(), Title=fixture ? "fixture" : "overlay", ClassName=cls.ToString(), Visible=IsWindowVisible(hwnd), Style=GetWindowLongPtr(hwnd,-20).ToInt64(), Affinity=affinity, Bounds=rect, Foreground=GetForegroundWindow()==hwnd });
      return true;
    }, IntPtr.Zero);
    return entries.ToArray();
  }
  public static void Focus() {
    EnumWindows((hwnd, data) => {
      var title = new StringBuilder(256); GetWindowText(hwnd, title, title.Capacity);
      if (!title.ToString().Contains("BetterComms Copilot Fixture")) return true;
      uint ignored; uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
      uint ownThread = GetCurrentThreadId(); bool attached = AttachThreadInput(ownThread, foregroundThread, true);
      try { ShowWindow(hwnd, 9); SetForegroundWindow(hwnd); } finally { if (attached) AttachThreadInput(ownThread, foregroundThread, false); }
      if (GetForegroundWindow() != hwnd) {
        // A real click is confined to the verified synthetic window's titlebar.
        // Temporarily raise only that fixture; never click through another app.
        Point previous; GetCursorPos(out previous); Rect rect; GetWindowRect(hwnd, out rect);
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
        var point = new Point { X=(rect.Left+rect.Right)/2, Y=rect.Top+15 };
        try {
          SetCursorPos(point.X, point.Y);
          if (GetAncestor(WindowFromPoint(point), 2) == hwnd) { mouse_event(2,0,0,0,UIntPtr.Zero); mouse_event(4,0,0,0,UIntPtr.Zero); }
        } finally { SetWindowPos(hwnd, new IntPtr(-2),0,0,0,0,0x0013); SetCursorPos(previous.X, previous.Y); }
      }
      return false;
    }, IntPtr.Zero);
  }
}
'@
if ($FocusFixture) { [CopilotFixtureWindows]::Focus(); Start-Sleep -Milliseconds 150 }
ConvertTo-Json -InputObject @([CopilotFixtureWindows]::Inspect($AppProcessId)) -Depth 4 -Compress
