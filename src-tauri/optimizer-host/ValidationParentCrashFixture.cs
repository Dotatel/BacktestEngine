using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DotaTel.ValidationProof;

/// <summary>Test-only native-parent surrogate; never shipped or used to accept numerical output.</summary>
internal static class ParentCrashFixture
{
    /// <summary>Create a named parent-owned job, start the real validation host, then wait or forward its exact exit.</summary>
    private static async Task<int> Main(string[] args)
    {
        string mode = args[0], sdk = args[1], host = args[2], python = args[3], source = args[4], config = args[5], working = args[6];
        string name = "Local\\DotaTel.Validation." + Guid.NewGuid().ToString("N");
        IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2208, ActiveProcesses = 16 }, JobMemory = new UIntPtr(2UL * 1024 * 1024 * 1024) };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());
            var start = new ProcessStartInfo(sdk) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = working };
            foreach (string argument in new[] { host, "--python", python, "--source", source, "--config", config, "--sdk", Path.GetDirectoryName(sdk)!, "--working", working, "--job", name }) start.ArgumentList.Add(argument);
            using Process child = Process.Start(start) ?? throw new InvalidOperationException("The actual validation host did not start.");
            File.WriteAllText(Path.Combine(working, "native-parent.pid"), Environment.ProcessId.ToString());
            File.WriteAllText(Path.Combine(working, "validation-host.pid"), child.Id.ToString());
            if (mode == "forward") { await child.WaitForExitAsync(); return child.ExitCode; }
            if (mode != "crash") throw new ArgumentException("Unknown synthetic parent-proof mode.");
            await Task.Delay(Timeout.Infinite);
            return 1;
        }
        finally { CloseHandle(job); }
    }

    /// <summary>Exact x64 native basic limits; fixture uses the production resource limits without joining itself.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessUserTime, JobUserTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    /// <summary>Native IO_COUNTERS layout embedded before pointer-sized memory limits.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }

    /// <summary>Extended native layout matching the original shared production job configuration.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }

    /// <summary>Create a test-owned named job; no app/OS/global process setting is changed.</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    /// <summary>Apply the same active-process, memory and last-close limits before launching the host.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits information, uint length);
    /// <summary>Normal return closes the parent; abrupt process death exercises the OS close path instead.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
