using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Interop;
using System.Windows.Media.Imaging;

internal class Program
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static readonly Dictionary<string, Snapshot> Snapshots = new();
    record Node(string Id, string Name, string Type, string AutomationId, bool Enabled, bool Offscreen, object Bounds, string? Value, string[] Patterns);
    record Snapshot(nint Hwnd, int Pid, RECT Rect, DateTime At, byte[] Image, Dictionary<string, AutomationElement> Elements, Dictionary<string, Node> Nodes);
    [STAThread]
    static void Main()
    {
        SetProcessDpiAwarenessContext(new nint(-4));
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            string? id = null;
            try
            {
                using var doc = JsonDocument.Parse(line); var root = doc.RootElement;
                id = root.GetProperty("id").GetString(); var a = root.GetProperty("args");
                object value = root.GetProperty("method").GetString() switch
                {
                    "protect" => new { data = Protect(a.GetProperty("text").GetString()!, false) },
                    "unprotect" => new { text = Protect(a.GetProperty("data").GetString()!, true) },
                    "snapshot" => Capture(a),
                    "restore" => Restore(a),
                    "action" => Action(a),
                    _ => throw new InvalidOperationException("unknown-native-method")
                };
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, value }, Json));
            }
            catch (Exception e) { Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = new { code = "native-error", message = e.Message } }, Json)); }
        }
    }
    static int Validate(nint hwnd)
    {
        if (!IsWindow(hwnd)) throw new InvalidOperationException("Window no longer exists.");
        GetWindowThreadProcessId(hwnd, out var pid);
        using var p = Process.GetProcessById((int)pid);
        if (!string.Equals(p.ProcessName, "PCL-Deepseek-Harness-Launcher", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Target is not a DSHL window.");
        return (int)pid;
    }
    static object Capture(JsonElement a)
    {
        var hwnd = new nint(long.Parse(a.GetProperty("handle").GetString()!)); var pid = Validate(hwnd);
        if (IsIconic(hwnd)) throw new InvalidOperationException("Restore the DSHL window before taking a snapshot.");
        GetWindowRect(hwnd, out var rect); var nodes = new List<Node>(); var elements = new Dictionary<string, AutomationElement>();
        var queue = new Queue<AutomationElement>(); queue.Enqueue(AutomationElement.FromHandle(hwnd));
        var clock = Stopwatch.StartNew(); var walker = TreeWalker.ControlViewWalker;
        while (queue.Count > 0 && nodes.Count < 800 && clock.ElapsedMilliseconds < 6000)
        {
            var e = queue.Dequeue();
            try
            {
                var c = e.Current; var key = string.Join(".", e.GetRuntimeId());
                var patterns = e.GetSupportedPatterns().Select(p => p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "")).ToArray();
                string? value = null;
                if (!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out var v)) value = ((ValuePattern)v).Current.Value;
                var r = c.BoundingRectangle;
                var empty = r.IsEmpty || !double.IsFinite(r.X) || !double.IsFinite(r.Y);
                nodes.Add(new Node(key, c.IsPassword ? "<password>" : c.Name, c.ControlType.ProgrammaticName.Replace("ControlType.", ""), c.AutomationId, c.IsEnabled, c.IsOffscreen || empty, new { x = empty ? 0 : r.X - rect.Left, y = empty ? 0 : r.Y - rect.Top, width = empty ? 0 : r.Width, height = empty ? 0 : r.Height }, c.IsPassword ? "<redacted>" : value, patterns));
                elements[key] = e;
                for (var child = walker.GetFirstChild(e); child != null; child = walker.GetNextSibling(child)) queue.Enqueue(child);
            }
            catch (ElementNotAvailableException) { }
        }
        var image = Screenshot(hwnd, rect); var snapshotId = Guid.NewGuid().ToString("N");
        if (Snapshots.Count >= 12) Snapshots.Remove(Snapshots.Keys.First());
        Snapshots[snapshotId] = new Snapshot(hwnd, pid, rect, DateTime.UtcNow, image, elements, nodes.ToDictionary(n => n.Id));
        var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
        return new { snapshotId, window = new { handle = hwnd.ToString(), pid, title = title.ToString(), x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top, dpi = GetDpiForWindow(hwnd) }, nodes, truncated = queue.Count > 0, imageBase64 = Convert.ToBase64String(image) };
    }
    static object Restore(JsonElement a)
    {
        var hwnd = new nint(long.Parse(a.GetProperty("handle").GetString()!)); Validate(hwnd);
        ShowWindow(hwnd, 9); Thread.Sleep(250);
        return new { restored = !IsIconic(hwnd), handle = hwnd.ToString() };
    }
    static object Action(JsonElement a)
    {
        var id = a.GetProperty("snapshotId").GetString()!;
        if (!Snapshots.TryGetValue(id, out var s) || DateTime.UtcNow - s.At > TimeSpan.FromSeconds(90)) throw new InvalidOperationException("Snapshot expired; take a new snapshot.");
        if (Validate(s.Hwnd) != s.Pid) throw new InvalidOperationException("Window identity changed.");
        GetWindowRect(s.Hwnd, out var r);
        if (!r.Equals(s.Rect)) throw new InvalidOperationException("Window moved or resized; take a new snapshot.");
        var action = a.GetProperty("action").GetString();
        AutomationElement? element = null;
        if (a.TryGetProperty("nodeId", out var node))
        {
            if (!s.Elements.TryGetValue(node.GetString()!, out element) || !element.Current.IsEnabled || element.Current.IsOffscreen) throw new InvalidOperationException("Control is unavailable.");
            var expected = s.Nodes[node.GetString()!]; var actual = element.Current;
            if ((actual.IsPassword ? "<password>" : actual.Name) != expected.Name || actual.AutomationId != expected.AutomationId || actual.ControlType.ProgrammaticName.Replace("ControlType.", "") != expected.Type) throw new InvalidOperationException("Control identity changed; take a new snapshot.");
            var b = element.Current.BoundingRectangle;
            if (b.IsEmpty || b.Left < r.Left || b.Top < r.Top || b.Right > r.Right || b.Bottom > r.Bottom) throw new InvalidOperationException("Control is outside the bound window.");
        }
        if (action == "expand" && element != null)
        {
            if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand)) throw new InvalidOperationException("Control cannot expand.");
            var pattern = (ExpandCollapsePattern)expand;
            if (pattern.Current.ExpandCollapseState != ExpandCollapseState.Expanded) pattern.Expand();
        }
        else if (action == "click" && element != null)
        {
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) ((InvokePattern)invoke).Invoke();
            else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection)) ((SelectionItemPattern)selection).Select();
            else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) ((TogglePattern)toggle).Toggle();
            else if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand)) { var pattern = (ExpandCollapsePattern)expand; if (pattern.Current.ExpandCollapseState == ExpandCollapseState.Expanded) pattern.Collapse(); else pattern.Expand(); }
            else throw new InvalidOperationException("Control has no semantic click pattern; use a fresh screenshot coordinate.");
        }
        else if (action == "fill" && element != null)
        {
            if (element.Current.IsPassword) throw new InvalidOperationException("Password input is not exposed by this tool.");
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value)) ((ValuePattern)value).SetValue(a.GetProperty("text").GetString()!);
            else { Focus(s.Hwnd); element.SetFocus(); PressKey("CTRL+A"); Unicode(a.GetProperty("text").GetString()!); }
        }
        else
        {
            var currentImage = Screenshot(s.Hwnd, r);
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(currentImage), SHA256.HashData(s.Image))) throw new InvalidOperationException("Window content changed; take a new snapshot before coordinate or keyboard actions.");
            Focus(s.Hwnd);
            if (action == "click")
            {
                var x = a.GetProperty("x").GetInt32(); var y = a.GetProperty("y").GetInt32();
                if (x < 0 || y < 0 || x >= r.Right - r.Left || y >= r.Bottom - r.Top) throw new InvalidOperationException("Coordinate outside window.");
                SetCursorPos(r.Left + x, r.Top + y); mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0);
            }
            else if (action == "press") PressKey(a.GetProperty("key").GetString()!);
            else if (action == "type") Unicode(a.GetProperty("text").GetString()!);
            else if (action == "scroll")
            {
                SetCursorPos((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
                mouse_event(0x0800, 0, 0, a.GetProperty("delta").GetInt32(), 0);
            }
            else throw new InvalidOperationException("Unsupported UI action.");
        }
        Snapshots.Remove(id);
        return new { performed = true, verified = false, next = "Take a new snapshot and verify the requested result.", handle = s.Hwnd.ToString() };
    }
    static void Focus(nint hwnd)
    {
        SetForegroundWindow(hwnd); Thread.Sleep(100);
        if (GetForegroundWindow() != hwnd) throw new InvalidOperationException("Cannot focus the bound DSHL window.");
    }
    static void Unicode(string text)
    {
        foreach (var c in text)
        {
            var input = new INPUT { Type = 1, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { Scan = c, Flags = 4 } } };
            if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("Keyboard input was rejected.");
            input.Data.Keyboard.Flags = 6;
            if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("Keyboard input was rejected.");
        }
    }
    static void PressKey(string key)
    {
        var keys = new Dictionary<string, byte> { ["ENTER"] = 13, ["TAB"] = 9, ["ESCAPE"] = 27, ["UP"] = 38, ["DOWN"] = 40, ["LEFT"] = 37, ["RIGHT"] = 39, ["HOME"] = 36, ["END"] = 35, ["BACKSPACE"] = 8, ["DELETE"] = 46, ["CTRL+A"] = 65 };
        if (!keys.TryGetValue(key.ToUpperInvariant(), out var k)) throw new InvalidOperationException("Unsupported key.");
        var ctrl = key.ToUpperInvariant() == "CTRL+A";
        if (ctrl) keybd_event(17, 0, 0, 0);
        keybd_event(k, 0, 0, 0); keybd_event(k, 0, 2, 0);
        if (ctrl) keybd_event(17, 0, 2, 0);
    }
    static byte[] Screenshot(nint hwnd, RECT r)
    {
        var width = r.Right - r.Left; var height = r.Bottom - r.Top;
        if (width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new InvalidOperationException("Invalid window dimensions.");
        var dc = GetWindowDC(hwnd); var mem = CreateCompatibleDC(dc); var bitmap = CreateCompatibleBitmap(dc, width, height); var old = SelectObject(mem, bitmap);
        try
        {
            if (!PrintWindow(hwnd, mem, 2)) throw new InvalidOperationException("Window capture failed.");
            var source = Imaging.CreateBitmapSourceFromHBitmap(bitmap, 0, System.Windows.Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(source));
            using var output = new MemoryStream(); encoder.Save(output); return output.ToArray();
        }
        finally { SelectObject(mem, old); DeleteObject(bitmap); DeleteDC(mem); ReleaseDC(hwnd, dc); }
    }
    static string Protect(string text, bool decrypt)
    {
        var bytes = decrypt ? Convert.FromBase64String(text) : Encoding.UTF8.GetBytes(text);
        var input = new BLOB { Size = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) }; Marshal.Copy(bytes, 0, input.Data, bytes.Length);
        BLOB output = default;
        try
        {
            var ok = decrypt ? CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output) : CryptProtectData(ref input, null, 0, 0, 0, 1, out output);
            if (!ok) throw new InvalidOperationException("DPAPI operation failed.");
            var result = new byte[output.Size]; Marshal.Copy(output.Data, result, 0, result.Length);
            return decrypt ? Encoding.UTF8.GetString(result) : Convert.ToBase64String(result);
        }
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != 0) LocalFree(output.Data); }
    }
    [StructLayout(LayoutKind.Sequential)] struct BLOB { public int Size; public nint Data; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint Type; public INPUTUNION Data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT Keyboard; [FieldOffset(0)] public MOUSEINPUT Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort Key, Scan; public uint Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int X, Y; public uint MouseData, Flags, Time; public nuint Extra; }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(nint value);
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(nint hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(nint hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, int data, nuint extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, nuint extra);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] static extern nint GetWindowDC(nint hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(nint hwnd, nint dc);
    [DllImport("user32.dll")] static extern bool PrintWindow(nint hwnd, nint dc, uint flags);
    [DllImport("gdi32.dll")] static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] static extern nint CreateCompatibleBitmap(nint dc, int width, int height);
    [DllImport("gdi32.dll")] static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(nint dc);
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CryptProtectData(ref BLOB input, string? description, nint entropy, nint reserved, nint prompt, uint flags, out BLOB output);
    [DllImport("crypt32.dll", SetLastError = true)] static extern bool CryptUnprotectData(ref BLOB input, nint description, nint entropy, nint reserved, nint prompt, uint flags, out BLOB output);
    [DllImport("kernel32.dll")] static extern nint LocalFree(nint memory);
}
