using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// IconFade: desktop icons stay invisible until the mouse is over one; only that icon shows.
//
// The real icon list is made fully transparent once and left alone (toggling it is what
// causes flashes). The hovered icon is copied exactly as Windows draws it into a small
// click-through window sitting just above the desktop, so clicks still reach the real,
// invisible icon underneath.
//
// Usage: IconFade.exe          run in the tray
//        IconFade.exe --parent=1234  run in the tray, and quit (showing the icons again) as soon as program 1234 is gone
//        IconFade.exe restore  make icons visible again and exit
static class Native
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("psapi.dll")] static extern bool EmptyWorkingSet(IntPtr process);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr rgn, uint flags);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref Point pos, ref Size size, IntPtr src, ref Point srcPos, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr addr, UIntPtr size, uint type, uint prot);
    [DllImport("kernel32.dll")] public static extern bool VirtualFreeEx(IntPtr p, IntPtr addr, UIntPtr size, uint type);
    [DllImport("kernel32.dll")] public static extern bool WriteProcessMemory(IntPtr p, IntPtr addr, byte[] buf, int n, out IntPtr written);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr p, IntPtr addr, byte[] buf, int n, out IntPtr read);

    [StructLayout(LayoutKind.Sequential)]
    public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    public static bool Full;
    public static IntPtr CatcherHandle;
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SetCapture(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x80000;
    public const uint LWA_ALPHA = 0x2;
    public const uint GA_ROOT = 2;

    // Gives back memory the program is not using right now (it is paged in again only if needed), so it sits at a few MB while idle.
    public static void Trim()
    {
        try { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); EmptyWorkingSet(System.Diagnostics.Process.GetCurrentProcess().Handle); } catch { }
    }

    public static string ClassOf(IntPtr h)
    {
        var s = new StringBuilder(128);
        GetClassName(h, s, 128);
        return s.ToString();
    }

    // The desktop icon list lives in Progman or a WorkerW, depending on wallpaper software.
    public static IntPtr FindDesktopIcons()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            IntPtr view = FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (view != IntPtr.Zero)
            {
                IntPtr list = FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
                if (list != IntPtr.Zero) { found = list; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // "Stronger hide": the icon names are also made black while hidden, so no faint bright ghost of the text is left on screens that blend the
    // almost-invisible layer brightly (HDR, some GPUs). The original colour is kept in a small file so it can always be put back, even after a crash.
    static string ColorFile() { return System.IO.Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? System.IO.Path.GetTempPath(), "IconFade", "textcolor.txt"); }

    public static void DimLabels(IntPtr h)
    {
        try
        {
            string f = ColorFile();
            if (!System.IO.File.Exists(f))
            {
                int cur = (int)SendMessage(h, 0x1023, IntPtr.Zero, IntPtr.Zero); // LVM_GETTEXTCOLOR
                System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(f));
                System.IO.File.WriteAllText(f, cur.ToString());
            }
            SendMessage(h, 0x1024, IntPtr.Zero, IntPtr.Zero); // LVM_SETTEXTCOLOR = black
        }
        catch { }
    }

    public static void UndimLabels(IntPtr h)
    {
        try
        {
            string f = ColorFile();
            if (!System.IO.File.Exists(f)) return;
            int cur;
            if (int.TryParse(System.IO.File.ReadAllText(f), out cur)) SendMessage(h, 0x1024, IntPtr.Zero, (IntPtr)cur);
            System.IO.File.Delete(f);
        }
        catch { }
    }

    public static void Hide(IntPtr h, bool strong)
    {
        if (strong) DimLabels(h); else UndimLabels(h);
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) == 0) SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED);
        // Alpha 1 of 255 is invisible, but unlike 0 it still receives clicks (alpha 0 is click-through).
        // In "full" mode (HDR screens, where even 1/255 shows) it is truly 0, and the Catcher window takes the clicks instead.
        SetLayeredWindowAttributes(h, 0, (byte)(Full ? 0 : 1), LWA_ALPHA);
        NudgeTaskbar();
    }

    // Making the desktop list see-through can leave a stale white box behind a see-through taskbar (TranslucentTB and similar);
    // asking the taskbar to repaint itself right afterwards (and once more a moment later) clears it.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
    public static void NudgeTaskbar()
    {
        try
        {
            foreach (var cls in new[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" })
            {
                IntPtr t = FindWindow(cls, null);
                if (t != IntPtr.Zero) RedrawWindow(t, IntPtr.Zero, IntPtr.Zero, 0x1 | 0x4 | 0x80 | 0x100); // INVALIDATE | ERASE | ALLCHILDREN | UPDATENOW
            }
        }
        catch { }
    }

    public static void Restore(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return;
        UndimLabels(h); // also fixes names left black by an earlier crash
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) == 0) return;
        SetWindowLong(h, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
        RedrawWindow(h, IntPtr.Zero, IntPtr.Zero, 0x1 | 0x4 | 0x80 | 0x100); // INVALIDATE | ERASE | ALLCHILDREN | UPDATENOW
    }
}

// Reads icon positions and labels out of Explorer's desktop list, and copies how an icon is drawn.
class IconList : IDisposable
{
    const int LVM_GETBKCOLOR = 0x1000, LVM_SETBKCOLOR = 0x1001;
    const int LVM_GETITEMCOUNT = 0x1004, LVM_GETITEMRECT = 0x100E;
    const int LVM_GETTEXTBKCOLOR = 0x1025, LVM_SETTEXTBKCOLOR = 0x1026;
    const int LVM_GETITEMW = 0x104B;
    const int LVM_GETTEXTCOLOR = 0x1023, LVM_SETTEXTCOLOR = 0x1024;
    const uint PROCESS_VM_OPERATION = 0x8, PROCESS_VM_READ = 0x10, PROCESS_VM_WRITE = 0x20;
    const int TextOffset = 128;

    readonly IntPtr list;
    IntPtr proc, remote;

    public struct Item { public Rectangle Bounds; public string Text; }

    public IconList(IntPtr list)
    {
        this.list = list;
        uint pid;
        Native.GetWindowThreadProcessId(list, out pid);
        proc = Native.OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid);
        if (proc != IntPtr.Zero)
            remote = Native.VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)1024, 0x3000, 0x04);
    }

    public bool Ok { get { return proc != IntPtr.Zero && remote != IntPtr.Zero; } }

    public int Count
    {
        get { return (int)Native.SendMessage(list, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero); }
    }

    // Whole-item rectangle in screen coordinates.
    public bool GetBounds(int index, out Rectangle rect)
    {
        rect = Rectangle.Empty;
        byte[] buf = new byte[16]; // rect.left = 0 -> LVIR_BOUNDS
        IntPtr n;
        Native.WriteProcessMemory(proc, remote, buf, 16, out n);
        if (Native.SendMessage(list, LVM_GETITEMRECT, (IntPtr)index, remote) == IntPtr.Zero) return false;
        if (!Native.ReadProcessMemory(proc, remote, buf, 16, out n)) return false;
        var tl = new Point(BitConverter.ToInt32(buf, 0), BitConverter.ToInt32(buf, 4));
        Native.ClientToScreen(list, ref tl);
        rect = new Rectangle(tl.X, tl.Y, BitConverter.ToInt32(buf, 8) - BitConverter.ToInt32(buf, 0), BitConverter.ToInt32(buf, 12) - BitConverter.ToInt32(buf, 4));
        return true;
    }

    public int HitTest(Point screen, int margin)
    {
        int count = Count;
        for (int i = 0; i < count; i++)
        {
            Rectangle r;
            if (!GetBounds(i, out r)) continue;
            r.Inflate(margin, margin);
            if (r.Contains(screen)) return i;
        }
        return -1;
    }

    public bool GetItem(int index, out Item item)
    {
        item = new Item();
        if (!GetBounds(index, out item.Bounds)) return false;

        // LVITEMW (x64): mask@0 iItem@4 iSubItem@8 state@12 stateMask@16 pszText@24 cchTextMax@32
        byte[] lv = new byte[88];
        BitConverter.GetBytes(0x1).CopyTo(lv, 0); // LVIF_TEXT
        BitConverter.GetBytes(index).CopyTo(lv, 4);
        BitConverter.GetBytes((long)remote + TextOffset).CopyTo(lv, 24);
        BitConverter.GetBytes(256).CopyTo(lv, 32);
        IntPtr n;
        Native.WriteProcessMemory(proc, remote, lv, lv.Length, out n);
        if (Native.SendMessage(list, LVM_GETITEMW, IntPtr.Zero, remote) == IntPtr.Zero) return false;

        byte[] text = new byte[512];
        Native.ReadProcessMemory(proc, (IntPtr)((long)remote + TextOffset), text, 512, out n);
        item.Text = Encoding.Unicode.GetString(text);
        int nul = item.Text.IndexOf('\0');
        if (nul >= 0) item.Text = item.Text.Substring(0, nul);
        return true;
    }

    // Copies exactly what the list draws for one item, with per-pixel transparency.
    // The item is printed once over black and once over white; the difference gives the alpha.
    // The list itself is fully transparent, so nothing visible changes while this happens.
    public Bitmap Capture(Rectangle screenRect)
    {
        var origin = new Point(0, 0);
        Native.ClientToScreen(list, ref origin);
        int cx = screenRect.X - origin.X, cy = screenRect.Y - origin.Y;
        int w = Math.Max(1, screenRect.Width), h = Math.Max(1, screenRect.Height);
        int stride = (w * 3 + 3) & ~3;

        if (cx < 0 || cy < 0) return new Bitmap(w, h, PixelFormat.Format32bppPArgb);

        IntPtr bk = Native.SendMessage(list, LVM_GETBKCOLOR, IntPtr.Zero, IntPtr.Zero);
        IntPtr tbk = Native.SendMessage(list, LVM_GETTEXTBKCOLOR, IntPtr.Zero, IntPtr.Zero);
        IntPtr tc = Native.SendMessage(list, LVM_GETTEXTCOLOR, IntPtr.Zero, IntPtr.Zero);
        byte[][] px = new byte[2][];
        // PrintWindow always draws from the window's top-left, so print only as far as this item reaches.
        int fw = cx + w, fh = cy + h;
        int fstride = (fw * 3 + 3) & ~3;
        try
        {
            Native.SendMessage(list, LVM_SETTEXTCOLOR, IntPtr.Zero, (IntPtr)0xFFFFFF); // same text colour on both passes
            for (int pass = 0; pass < 2; pass++)
            {
                IntPtr color = pass == 0 ? IntPtr.Zero : (IntPtr)0xFFFFFF;
                Native.SendMessage(list, LVM_SETBKCOLOR, IntPtr.Zero, color);
                Native.SendMessage(list, LVM_SETTEXTBKCOLOR, IntPtr.Zero, color);
                using (var bmp = new Bitmap(fw, fh, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        IntPtr hdc = g.GetHdc();
                        Native.PrintWindow(list, hdc, 2); // PW_RENDERFULLCONTENT
                        g.ReleaseHdc(hdc);
                    }
                    var data = bmp.LockBits(new Rectangle(0, 0, fw, fh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                    byte[] all = new byte[fstride * fh];
                    Marshal.Copy(data.Scan0, all, 0, all.Length);
                    bmp.UnlockBits(data);
                    px[pass] = new byte[stride * h];
                    for (int y = 0; y < h; y++)
                        Buffer.BlockCopy(all, (cy + y) * fstride + cx * 3, px[pass], y * stride, w * 3);
                }
            }
        }
        finally
        {
            Native.SendMessage(list, LVM_SETBKCOLOR, IntPtr.Zero, bk);
            Native.SendMessage(list, LVM_SETTEXTBKCOLOR, IntPtr.Zero, tbk);
            Native.SendMessage(list, LVM_SETTEXTCOLOR, IntPtr.Zero, tc);
        }

        var result = new Bitmap(w, h, PixelFormat.Format32bppPArgb);
        var rd = result.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        byte[] outPx = new byte[rd.Stride * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int si = y * stride + x * 3, di = y * rd.Stride + x * 4;
                int diff = ((px[1][si] - px[0][si]) + (px[1][si + 1] - px[0][si + 1]) + (px[1][si + 2] - px[0][si + 2])) / 3;
                int a = Math.Max(0, Math.Min(255, 255 - diff));
                // over black, the pixel already equals the premultiplied colour
                outPx[di] = (byte)Math.Min((int)px[0][si], a);
                outPx[di + 1] = (byte)Math.Min((int)px[0][si + 1], a);
                outPx[di + 2] = (byte)Math.Min((int)px[0][si + 2], a);
                outPx[di + 3] = (byte)a;
            }
        Marshal.Copy(outPx, 0, rd.Scan0, outPx.Length);
        result.UnlockBits(rd);
        return result;
    }

    public void Dispose()
    {
        if (proc != IntPtr.Zero)
        {
            if (remote != IntPtr.Zero) Native.VirtualFreeEx(proc, remote, UIntPtr.Zero, 0x8000);
            Native.CloseHandle(proc);
        }
        proc = remote = IntPtr.Zero;
    }
}

// A click-through window showing a copy of one desktop icon, just above the desktop.
class IconOverlay : Form
{
    static readonly IntPtr HWND_BOTTOM = (IntPtr)1;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
    string shownKey;
    bool showing, shownHover;
    readonly Dictionary<string, Bitmap> idle = new Dictionary<string, Bitmap>();  // how an icon looks with nothing pointing at it
    readonly Dictionary<string, Bitmap> hover = new Dictionary<string, Bitmap>(); // how it looks while pointed at (with the highlight)

    public IconOverlay()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);
        Size = new Size(1, 1);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // layered | transparent (click-through) | toolwindow | noactivate
            cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x8000000;
            return cp;
        }
    }

    static string KeyOf(int index, IconList.Item item) { return index + "|" + item.Text + "|" + item.Bounds; }

    public void ClearCache()
    {
        foreach (var b in idle.Values) b.Dispose();
        foreach (var b in hover.Values) b.Dispose();
        idle.Clear(); hover.Clear();
        shownKey = null; showing = false; shownHover = false;
    }

    // Draws an icon ahead of time. Returns false when it was already drawn.
    public bool Prefetch(int index, IconList.Item item, IconList reader)
    {
        string key = KeyOf(index, item);
        if (idle.ContainsKey(key)) return false;
        if (idle.Count > 150) { foreach (var b in idle.Values) b.Dispose(); idle.Clear(); }
        idle[key] = reader.Capture(item.Bounds);
        return true;
    }

    public void ShowItem(int index, IconList.Item item, IconList reader)
    {
        string key = KeyOf(index, item);
        bool same = key == shownKey && showing;
        if (same && shownHover) return;
        shownKey = key;
        showing = true;

        Bitmap bmp;
        if (hover.TryGetValue(key, out bmp)) { Apply(bmp, item.Bounds.Location); shownHover = true; }          // seen before: instant
        else if (!same && idle.TryGetValue(key, out bmp)) { Apply(bmp, item.Bounds.Location); shownHover = false; } // first look: show it at once, the highlighted version follows on the next tick
        else
        {
            if (hover.Count > 150) { foreach (var b in hover.Values) b.Dispose(); hover.Clear(); }
            bmp = reader.Capture(item.Bounds); hover[key] = bmp;
            Apply(bmp, item.Bounds.Location); shownHover = true;
        }
        Native.SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    public void HideItem()
    {
        if (!showing) return;
        showing = false;
        shownHover = false;
        shownKey = null;
        Hide();
    }

    void Apply(Bitmap bmp, Point pos)
    {
        IntPtr screenDc = Native.GetDC(IntPtr.Zero);
        IntPtr memDc = Native.CreateCompatibleDC(screenDc);
        IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0));
        IntPtr old = Native.SelectObject(memDc, hbmp);
        var size = new Size(bmp.Width, bmp.Height);
        var src = new Point(0, 0);
        var blend = new Native.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
        Native.UpdateLayeredWindow(Handle, screenDc, ref pos, ref size, memDc, ref src, 0, ref blend, 2);
        Native.SelectObject(memDc, old);
        Native.DeleteObject(hbmp);
        Native.DeleteDC(memDc);
        Native.ReleaseDC(IntPtr.Zero, screenDc);
    }
}

// Full mode only: an almost-black (1/255 opacity, invisible even on HDR) window over the whole desktop that receives the mouse and
// passes it on to the real, fully transparent icon list.
class Catcher : Form
{
    IntPtr list;
    Rectangle area;
    public Catcher()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);
        Size = new Size(1, 1);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= 0x80000 | 0x80 | 0x8000000; return cp; } // layered | toolwindow | noactivate
    }

    public void Cover(IntPtr listHwnd)
    {
        list = listHwnd;
        var vs = SystemInformation.VirtualScreen;
        if (vs == area && Visible) { Native.SetWindowPos(Handle, (IntPtr)1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40); return; }
        area = vs;
        using (var bmp = new Bitmap(vs.Width, vs.Height, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.FromArgb(1, 0, 0, 0)); }
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = Native.CreateCompatibleDC(screenDc);
            IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0));
            IntPtr old = Native.SelectObject(memDc, hbmp);
            var size = new Size(vs.Width, vs.Height);
            var pos = vs.Location;
            var src = new Point(0, 0);
            var blend = new Native.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
            Native.UpdateLayeredWindow(Handle, screenDc, ref pos, ref size, memDc, ref src, 0, ref blend, 2);
            Native.SelectObject(memDc, old);
            Native.DeleteObject(hbmp);
            Native.DeleteDC(memDc);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }
        Native.SetWindowPos(Handle, (IntPtr)1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40); // bottom, no move/size, no activate, show
        Native.CatcherHandle = Handle;
        Native.Trim();
    }

    public void Uncover() { Hide(); }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x21) { m.Result = (IntPtr)3; return; } // WM_MOUSEACTIVATE: never take focus
        if (list != IntPtr.Zero && m.Msg >= 0x201 && m.Msg <= 0x209 && m.Msg != 0x200)
        {
            long lp = m.LParam.ToInt64();
            int x = (short)(lp & 0xFFFF), y = (short)((lp >> 16) & 0xFFFF);
            var o = new Point(0, 0);
            Native.ClientToScreen(list, ref o);
            int cx = x + area.X - o.X, cy = y + area.Y - o.Y;
            if (m.Msg == 0x201 || m.Msg == 0x204 || m.Msg == 0x207) Native.SetCapture(Handle);
            if (m.Msg == 0x202 || m.Msg == 0x205 || m.Msg == 0x208) Native.ReleaseCapture();
            Native.PostMessage(list, m.Msg, m.WParam, (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF)));
            return;
        }
        if (list != IntPtr.Zero && m.Msg == 0x200 && ((long)m.WParam & 0x3) != 0) // dragging with a button held
        {
            long lp = m.LParam.ToInt64();
            int x = (short)(lp & 0xFFFF), y = (short)((lp >> 16) & 0xFFFF);
            var o = new Point(0, 0);
            Native.ClientToScreen(list, ref o);
            Native.PostMessage(list, 0x200, m.WParam, (IntPtr)((((y + area.Y - o.Y) & 0xFFFF) << 16) | ((x + area.X - o.X) & 0xFFFF)));
            return;
        }
        base.WndProc(ref m);
    }
}

class IconFade : ApplicationContext
{
    const int PollIntervalMs = 8; // asks for ~8 ms; Windows rounds to its ~15 ms clock, so about 4 times more often than before
    const int HideDelayMs = 150;
    const int Margin = 2;

    static int ParentPid;
    static bool Strong;
    long parentAt;
    readonly List<Rectangle> bounds = new List<Rectangle>(); // where each desktop icon is, refreshed a few times a second
    long boundsAt, prefetchTick, prefetchRest, trimAt; int prefetchAt;
    readonly NotifyIcon tray;
    readonly Timer timer;
    readonly MenuItem pauseItem;
    readonly IconOverlay overlay;
    Catcher catcher;
    long catcherAt, nudgeAt;
    IntPtr icons = IntPtr.Zero;
    IconList reader;
    bool paused;
    long lastHover = long.MinValue / 2;

    [STAThread]
    static void Main(string[] args)
    {
        Native.SetProcessDPIAware(); // so cursor and icon rectangles use the same pixels
        if (args.Length > 0 && args[0].ToLowerInvariant() == "restore")
        {
            Native.Restore(Native.FindDesktopIcons());
            return;
        }
        if (args.Length > 0 && args[0].StartsWith("--guard=")) { Guard(args[0].Substring(8)); return; }
        foreach (var a in args)
            if (a.StartsWith("--parent=")) int.TryParse(a.Substring(9), out ParentPid);
            else if (a == "--strong") Strong = true;
            else if (a == "--full") { Native.Full = true; Strong = true; }
        if (args.Length > 0 && args[0] == "--bench") { Bench(); return; }
        bool created;
        using (var mutex = new System.Threading.Mutex(true, "IconFade_SingleInstance", out created))
        {
            if (!created) return;
            // At logon this can start before Explorer has built the desktop; wait for it (up to 2 minutes).
            for (int i = 0; i < 120 && Native.FindDesktopIcons() == IntPtr.Zero; i++)
                System.Threading.Thread.Sleep(1000);
            Application.EnableVisualStyles();
            StartGuard();
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try { Application.Run(new IconFade()); break; }
                catch { System.Threading.Thread.Sleep(3000); }
            }
        }
    }

    // The guard: a tiny, separate program that does nothing but wait for Icon Fade to end and then put the icons back, so they are never left hidden
    // even when Icon Fade and Wallpaper Hub are both killed abruptly (for example by Task Manager). It is started by Icon Fade, but detached from it.
    static void Guard(string pidText)
    {
        int pid; if (!int.TryParse(pidText, out pid)) return;
        try { System.Diagnostics.Process.GetCurrentProcess().PriorityClass = System.Diagnostics.ProcessPriorityClass.Idle; } catch { }
        Native.Trim(); // stay small while waiting
        try { using (var p = System.Diagnostics.Process.GetProcessById(pid)) p.WaitForExit(); } catch { }
        System.Threading.Thread.Sleep(2500); // a restart (for example when a setting changes) brings a new Icon Fade up within this time
        bool created;
        using (var m = new System.Threading.Mutex(false, "IconFade_SingleInstance", out created))
        {
            if (!created) return; // another Icon Fade is running and looks after the icons
            Native.Restore(Native.FindDesktopIcons());
        }
    }

    static void StartGuard()
    {
        try
        {
            string exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
            int me = System.Diagnostics.Process.GetCurrentProcess().Id;
            // started through cmd so that the guard is not a child of Icon Fade: ending Icon Fade (or Wallpaper Hub) with its child programs does not end the guard
            var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", "/c start \"\" /b \"" + exe + "\" --guard=" + me) { CreateNoWindow = true, UseShellExecute = false, WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden };
            System.Diagnostics.Process.Start(psi);
        }
        catch { }
    }

    // Timing test (not used in normal running): IconFade.exe --bench writes how long the main steps take to the temp folder
    static void Bench()
    {
        var o = new System.Text.StringBuilder();
        IntPtr icons = Native.FindDesktopIcons();
        using (var r = new IconList(icons))
        {
            int n = r.Count;             o.AppendLine("icons: " + n);
            for (int i = 0; i < n; i++) { Rectangle rr; r.GetBounds(i, out rr); o.AppendLine("rect " + i + " " + rr.X + " " + rr.Y + " " + rr.Width + " " + rr.Height); }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < 50; i++) r.HitTest(new Point(5, 5), 2);
            o.AppendLine("HitTest (looks through every icon): " + (sw.Elapsed.TotalMilliseconds / 50).ToString("0.00") + " ms each");
            double sumCap = 0, maxCap = 0, sumItem = 0;
            for (int i = 0; i < n; i++)
            {
                IconList.Item it; sw.Restart(); if (!r.GetItem(i, out it)) continue; sumItem += sw.Elapsed.TotalMilliseconds;
                sw.Restart(); using (var b = r.Capture(it.Bounds)) { } double t = sw.Elapsed.TotalMilliseconds; sumCap += t; if (t > maxCap) maxCap = t;
            }
            o.AppendLine("GetItem: " + (sumItem / Math.Max(1, n)).ToString("0.00") + " ms avg");
            o.AppendLine("Capture (draw one icon): " + (sumCap / Math.Max(1, n)).ToString("0.0") + " ms avg, " + maxCap.ToString("0.0") + " ms worst");
        }
        System.IO.File.WriteAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "iconfade-bench.txt"), o.ToString());
    }

    IconFade()
    {
        pauseItem = new MenuItem("Pause (show all icons)", (s, e) => TogglePause());
        var menu = new ContextMenu(new[] { pauseItem, new MenuItem("Exit", (s, e) => Exit()) });
        Icon trayIcon = SystemIcons.Application;
        try
        {
            // IconFade.ico is embedded as a resource; ask for the size the tray wants so it stays sharp.
            using (var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("IconFade.ico"))
                if (s != null) trayIcon = new Icon(s, SystemInformation.SmallIconSize);
        }
        catch { }
        tray = new NotifyIcon { Icon = trayIcon, Text = "IconFade", ContextMenu = menu, Visible = true };
        System.Diagnostics.Process.GetCurrentProcess().PriorityClass = System.Diagnostics.ProcessPriorityClass.Idle;
        overlay = new IconOverlay();
        overlay.Show();
        overlay.Hide();
        if (Native.Full) { catcher = new Catcher(); catcher.Show(); catcher.Hide(); }
        timer = new Timer { Interval = PollIntervalMs };
        timer.Tick += (s, e) => Tick();
        timer.Start();
        trimAt = Environment.TickCount - 25000; // first clean-up about 5 seconds after start
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Native.Restore(icons);
    }

    void TogglePause()
    {
        paused = !paused;
        pauseItem.Checked = paused;
        overlay.HideItem();
        if (icons == IntPtr.Zero) return;
        if (paused) { if (catcher != null) catcher.Uncover(); Native.Restore(icons); }
        else { Native.Hide(icons, Strong); if (catcher != null) catcher.Cover(icons); }
    }

    // Where the cursor is: on the desktop surface, in a desktop context menu, or elsewhere.
    static void CursorTarget(out bool onDesktop, out bool inMenu, out Point pt)
    {
        onDesktop = false; inMenu = false;
        if (!Native.GetCursorPos(out pt)) return;
        IntPtr h = Native.WindowFromPoint(pt);
        if (h == IntPtr.Zero) return;
        IntPtr root = Native.GetAncestor(h, Native.GA_ROOT);
        string cls = Native.ClassOf(root == IntPtr.Zero ? h : root);
        if (cls == "#32768") { inMenu = true; return; }
        onDesktop = cls == "Progman" || cls == "WorkerW" || (Native.CatcherHandle != IntPtr.Zero && (root == Native.CatcherHandle || h == Native.CatcherHandle));
    }

    void Attach()
    {
        icons = Native.FindDesktopIcons();
        if (icons == IntPtr.Zero) return;
        overlay.ClearCache(); bounds.Clear();
        if (reader != null) reader.Dispose();
        reader = new IconList(icons);
        if (!paused) { Native.Hide(icons, Strong); if (catcher != null) catcher.Cover(icons); nudgeAt = Environment.TickCount + 1500; }
    }

    static bool ParentAlive()
    {
        if (ParentPid <= 0) return true;
        try { return !System.Diagnostics.Process.GetProcessById(ParentPid).HasExited; }
        catch { return false; }
    }

    void RefreshBounds(bool force)
    {
        long now = Environment.TickCount;
        if (!force && bounds.Count > 0 && now - boundsAt < 250) return;
        boundsAt = now;
        int n = reader.Count;
        bounds.Clear();
        for (int i = 0; i < n; i++) { Rectangle r; bounds.Add(reader.GetBounds(i, out r) ? r : Rectangle.Empty); }
    }

    int HitCached(Point pt)
    {
        for (int i = 0; i < bounds.Count; i++)
        {
            var r = bounds[i];
            if (r.IsEmpty) continue;
            r.Inflate(Margin, Margin);
            if (r.Contains(pt)) return i;
        }
        return -1;
    }

    // Draws one icon (as it looks when nothing points at it) so the first hover can show it at once.
    void PrefetchStep(long now)
    {
        if (now - prefetchTick < 30 || now < prefetchRest) return;
        prefetchTick = now;
        RefreshBounds(false);
        if (bounds.Count == 0) return;
        prefetchAt = (prefetchAt + 1) % bounds.Count;
        IconList.Item it;
        if (!reader.GetItem(prefetchAt, out it)) return;
        bool drew = overlay.Prefetch(prefetchAt, it, reader);
        if (!drew && prefetchAt == bounds.Count - 1) { prefetchRest = now + 1500; if (now - trimAt > 8000) { trimAt = now; Native.Trim(); } } // everything is ready: rest for a moment, and give unused memory back
    }

    void Tick()
    {
        if (ParentPid > 0 && Environment.TickCount - parentAt >= 1000) // about once a second
        {
            parentAt = Environment.TickCount;
            if (!ParentAlive()) { Exit(); return; } // whoever started us is gone: show the icons again and quit
        }
        if (icons == IntPtr.Zero || !Native.IsWindow(icons) || reader == null || !reader.Ok)
        {
            Attach();
            if (icons == IntPtr.Zero || reader == null || !reader.Ok) return;
        }
        if (paused) return;
        if (nudgeAt != 0 && Environment.TickCount - nudgeAt >= 0) { nudgeAt = 0; Native.NudgeTaskbar(); } // second repaint a moment after starting
        if (catcher != null &&Environment.TickCount - catcherAt >= 2000) { catcherAt = Environment.TickCount; catcher.Cover(icons); } // follows screen changes, stays at the bottom

        bool onDesktop, inMenu;
        Point pt;
        CursorTarget(out onDesktop, out inMenu, out pt);
        if (inMenu) return; // keep whatever is showing while a desktop menu is open

        int index = -1;
        if (onDesktop) { RefreshBounds(false); index = HitCached(pt); }
        long now = Environment.TickCount;
        if (index >= 0)
        {
            lastHover = now;
            IconList.Item item;
            if (reader.GetItem(index, out item)) overlay.ShowItem(index, item, reader);
        }
        else if (now - lastHover >= HideDelayMs)
        {
            overlay.HideItem();
        }
        if (index < 0) PrefetchStep(now);
        if (now - trimAt > 30000) { trimAt = now; Native.Trim(); } // and now and then regardless // while you are not pointing at an icon, draw them ahead of time
    }

    void Exit()
    {
        timer.Stop();
        overlay.Close();
        if (catcher != null) catcher.Close();
        if (reader != null) reader.Dispose();
        Native.Restore(icons);
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }
}
