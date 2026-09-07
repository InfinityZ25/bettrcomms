param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][int]$NativeProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PttTestInput {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBDINPUT key; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION input; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int state);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source, uint target, bool attach);
  public static void Focus(IntPtr window) {
    uint current = GetCurrentThreadId(), foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = current != foreground && AttachThreadInput(current, foreground, true);
    try { ShowWindow(window, 9); SetForegroundWindow(window); }
    finally { if (attached) AttachThreadInput(current, foreground, false); }
  }
  public static void Key(ushort scan, bool down) {
    var input = new INPUT { type=1, input=new UNION { key=new KEYBDINPUT { scan=scan, flags=(uint)(down ? 8 : 10) } } };
    if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new Exception("SendInput keyboard failed");
  }
  public static void Mouse(uint button, bool down) {
    uint flags = button == 0 ? (down ? 2u : 4u) : button == 1 ? (down ? 32u : 64u) : button == 2 ? (down ? 8u : 16u) : (down ? 128u : 256u);
    var input = new INPUT { type=0, input=new UNION { mouse=new MOUSEINPUT { flags=flags, data=button >= 3 ? button - 2 : 0 } } };
    if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new Exception("SendInput mouse failed");
  }
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'BetterComms global push-to-talk test'
$form.Size = New-Object Drawing.Size(520, 260)
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true
$label = New-Object Windows.Forms.Label
$label.Text = "Automated push-to-talk test window.`nKeyboard and mouse input must reach this window while BetterComms is in the background."
$label.Dock = 'Top'
$label.Height = 70
$label.Padding = New-Object Windows.Forms.Padding(12)
$form.Controls.Add($label)
$script:keyEvents = 0
$script:mouseEvents = 0
$form.Add_KeyDown({ $script:keyEvents++ })
$form.Add_MouseDown({ $script:mouseEvents++ })
$script:lastSequence = -1
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
  $commandFile = Join-Path $Directory 'command.json'
  if (-not (Test-Path -LiteralPath $commandFile)) { return }
  try { $command = Get-Content -Raw -LiteralPath $commandFile | ConvertFrom-Json } catch { return }
  if ($command.sequence -eq $script:lastSequence) { return }
  $script:lastSequence = $command.sequence
  try {
    switch ($command.action) {
      'focus' {
        [PttTestInput]::ShowWindow($form.Handle, 9) | Out-Null
        [PttTestInput]::ShowWindow($form.Handle, 5) | Out-Null
        $form.WindowState = 'Normal'
        $form.BringToFront()
        $form.Activate()
        [PttTestInput]::SetForegroundWindow($form.Handle) | Out-Null
        [PttTestInput]::Focus($form.Handle)
        [Windows.Forms.Cursor]::Position = $form.PointToScreen((New-Object Drawing.Point(250, 140)))
      }
      'keyDown' {
        if ([PttTestInput]::GetForegroundWindow() -ne $form.Handle) { throw 'Test window must have focus before injecting input. Unlock Windows and retry.' }
        [PttTestInput]::Key([ushort]$command.scan, $true)
      }
      'keyUp' { [PttTestInput]::Key([ushort]$command.scan, $false) }
      'mouseDown' {
        if ([PttTestInput]::GetForegroundWindow() -ne $form.Handle) { throw 'Test window must have focus before injecting input. Unlock Windows and retry.' }
        [PttTestInput]::Mouse([uint32]$command.button, $true)
      }
      'mouseUp' { [PttTestInput]::Mouse([uint32]$command.button, $false) }
      'snapshot' {}
      'restoreNative' {
        $native = Get-Process -Id $NativeProcessId -ErrorAction Stop
        $expectedBinary = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/desktop/src-tauri/target/debug/bettercomms-desktop.exe'
        if ($native.Path -ne $expectedBinary) { throw 'Refusing to restore a window outside the native test host' }
        [PttTestInput]::ShowWindow($native.MainWindowHandle, 9) | Out-Null
      }
      'close' { $timer.Stop(); $form.Hide() }
      default { throw 'Unknown input fixture command' }
    }
    @{ sequence=$command.sequence; foreground=([PttTestInput]::GetForegroundWindow() -eq $form.Handle); foregroundHandle=[PttTestInput]::GetForegroundWindow().ToInt64(); visible=[PttTestInput]::IsWindowVisible($form.Handle); keys=$script:keyEvents; mouse=$script:mouseEvents } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Directory 'response.json')
  } catch {
    @{ sequence=$command.sequence; error=$_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Directory 'response.json')
  }
})
$timer.Start()
try { [Windows.Forms.Application]::Run($form) } finally { $timer.Dispose(); $form.Dispose() }
