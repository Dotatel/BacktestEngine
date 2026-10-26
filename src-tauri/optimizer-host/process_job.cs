using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DotaTel.Processes;

/// <summary>Windows containment primitive retained from the tested optimizer host; no process is launched here.</summary>
internal static class OwnedProcessJob
{
    // The unnamed, non-inherited handle deliberately survives until process teardown;
    // closing it earlier would terminate the owner before its real exit code is returned.
    private static IntPtr ownedJob;

    /// <summary>Join only a pre-created native-parent job, then immediately close this temporary handle.</summary>
    internal static void JoinParent(string name)
    {
        const string prefix = "Local\\DotaTel.Validation.";
        if (!OperatingSystem.IsWindows() || !name.StartsWith(prefix, StringComparison.Ordinal)
            || !Guid.TryParseExact(name.Substring(prefix.Length), "N", out _))
            throw new ArgumentException("The full-validation parent job identity is invalid.");
        IntPtr joining = OpenJobObjectW(0x0001, false, name);
        if (joining == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The native parent validation job is unavailable.");
        try
        {
            using Process current = Process.GetCurrentProcess();
            if (!AssignProcessToJobObject(joining, current.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Validation could not join its native parent's job.");
        }
        finally
        {
            CloseHandle(joining); // Native parent must be the sole persistent owner before Python starts.
        }
    }

    /// <summary>Self-assign before spawning descendants; fail closed on unsupported/denied containment.</summary>
    internal static void Establish()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Owned validation process containment requires Windows.");
        ownedJob = CreateJobObjectW(IntPtr.Zero, null);
        if (ownedJob == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned process containment could not be created.");
        var limits = new ExtendedLimits
        {
            Basic = new BasicLimits { Flags = 0x2000 | 0x200 | 0x8, ActiveProcesses = 16 },
            JobMemory = new UIntPtr(2UL * 1024 * 1024 * 1024),
        };
        if (!SetInformationJobObject(ownedJob, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned process resource limits could not be established.");
        using Process current = Process.GetCurrentProcess();
        if (!AssignProcessToJobObject(ownedJob, current.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned process descendants cannot be contained.");
    }

    /// <summary>Native basic-limit layout preserves pointer-sized x64 alignment.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessUserTime;
        public long JobUserTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet;
        public UIntPtr MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    /// <summary>Native IO_COUNTERS is embedded unchanged in extended job limits.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations;
        public ulong WriteOperations;
        public ulong OtherOperations;
        public ulong ReadBytes;
        public ulong WriteBytes;
        public ulong OtherBytes;
    }

    /// <summary>Only declared flags activate kill-on-close, active-process and committed-memory limits.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory;
        public UIntPtr JobMemory;
        public UIntPtr PeakProcessMemory;
        public UIntPtr PeakJobMemory;
    }

    /// <summary>Create one private unnamed job with an explicitly non-inherited handle.</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    /// <summary>Open an existing named parent job for assignment only; never create a missing/foreign job here.</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);

    /// <summary>Release the temporary join reference so application death closes the last owning handle.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>Configure native extended limits before any self-assignment or process launch.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits information, uint length);

    /// <summary>Normal descendants inherit this kernel job; failure forbids child startup.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
