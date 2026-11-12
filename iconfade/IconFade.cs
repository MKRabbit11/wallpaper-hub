using System;
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
//        IconFade.exe restore  make icons visible again and exit
static class Native
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);
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

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x80000;
    public const uint LWA_ALPHA = 0x2;
    public const uint GA_ROOT = 2;

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

    public static void Hide(IntPtr h)
    {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) == 0) SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED);
        // Alpha 1 of 255 is invisible, but unlike 0 it still receives clicks (alpha 0 is click-through).
        SetLayeredWindowAttributes(h, 0, 1, LWA_ALPHA);
    }

    public static void Restore(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return;
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
    bool showing;

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

    public void ShowItem(int index, IconList.Item item, IconList reader)
    {
        string key = index + "|" + item.Text + "|" + item.Bounds;
        if (key == shownKey && showing) return;
        shownKey = key;
        showing = true;

        using (var bmp = reader.Capture(item.Bounds))
            Apply(bmp, item.Bounds.Location);
        Native.SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    public void HideItem()
    {
        if (!showing) return;
        showing = false;
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

class IconFade : ApplicationContext
{
    const int PollIntervalMs = 60;
    const int HideDelayMs = 150;
    const int Margin = 2;

    readonly NotifyIcon tray;
    readonly Timer timer;
    readonly MenuItem pauseItem;
    readonly IconOverlay overlay;
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
        bool created;
        using (var mutex = new System.Threading.Mutex(true, "IconFade_SingleInstance", out created))
        {
            if (!created) return;
            // At logon this can start before Explorer has built the desktop; wait for it (up to 2 minutes).
            for (int i = 0; i < 120 && Native.FindDesktopIcons() == IntPtr.Zero; i++)
                System.Threading.Thread.Sleep(1000);
            Application.EnableVisualStyles();
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try { Application.Run(new IconFade()); break; }
                catch { System.Threading.Thread.Sleep(3000); }
            }
        }
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
        timer = new Timer { Interval = PollIntervalMs };
        timer.Tick += (s, e) => Tick();
        timer.Start();
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Native.Restore(icons);
    }

    void TogglePause()
    {
        paused = !paused;
        pauseItem.Checked = paused;
        overlay.HideItem();
        if (icons == IntPtr.Zero) return;
        if (paused) Native.Restore(icons); else Native.Hide(icons);
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
        onDesktop = cls == "Progman" || cls == "WorkerW";
    }

    void Attach()
    {
        icons = Native.FindDesktopIcons();
        if (icons == IntPtr.Zero) return;
        if (reader != null) reader.Dispose();
        reader = new IconList(icons);
        if (!paused) Native.Hide(icons);
    }

    void Tick()
    {
        if (icons == IntPtr.Zero || !Native.IsWindow(icons) || reader == null || !reader.Ok)
        {
            Attach();
            if (icons == IntPtr.Zero || reader == null || !reader.Ok) return;
        }
        if (paused) return;

        bool onDesktop, inMenu;
        Point pt;
        CursorTarget(out onDesktop, out inMenu, out pt);
        if (inMenu) return; // keep whatever is showing while a desktop menu is open

        int index = onDesktop ? reader.HitTest(pt, Margin) : -1;
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
    }

    void Exit()
    {
        timer.Stop();
        overlay.Close();
        if (reader != null) reader.Dispose();
        Native.Restore(icons);
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }
}
