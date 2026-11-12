Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);[DllImport("user32.dll")]public static extern uint GetDpiForWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
public struct R{public int L,T,Rt,B;}}
"@
Add-Type -AssemblyName System.Drawing
[W]::SetProcessDPIAware()|Out-Null
$p=Get-Process softwarefactory|?{$_.MainWindowHandle -ne 0}|select -first 1
$h=$p.MainWindowHandle;$r=New-Object W+R;[W]::GetWindowRect($h,[ref]$r)|Out-Null
"rect $($r.L) $($r.T) $($r.Rt) $($r.B) dpi $([W]::GetDpiForWindow($h)) title $($p.MainWindowTitle)"
$w=$r.Rt-$r.L;$hh=$r.B-$r.T;$b=New-Object Drawing.Bitmap $w,$hh;$g=[Drawing.Graphics]::FromImage($b);$dc=$g.GetHdc();[W]::PrintWindow($h,$dc,2)|Out-Null;$g.ReleaseHdc($dc);$b.Save($args[0])
